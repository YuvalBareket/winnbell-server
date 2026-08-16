import { getPool } from '../../shared/db/db.js';
import { safeRollback } from '../../shared/db/txn.js';

// Nightly-ish rollup of raw funnel_event into funnel_daily / funnel_transition_daily,
// plus raw retention pruning. Design contract (FUNNEL_ANALYTICS_PLAN_2026_08_15.md):
//  - Idempotent: recomputes the last RECOMPUTE_DAYS full days with upserts, so re-runs
//    and late-arriving events just overwrite yesterday's numbers.
//  - Single-runner: pg_try_advisory_xact_lock family 12 (families 2,3,4,7,10,11 taken)
//    so only one instance does the work when the service scales out.
//  - Dashboards read ONLY the rollup tables; raw funnel_event is pruned after RETENTION_DAYS.
//  - Deltas use occurred_at (server clock) on both ends - consistent across client and
//    server events; client_ts stays available for ad-hoc intra-session analysis.

const RECOMPUTE_DAYS = 3;
const RETENTION_DAYS = 180;
const PRUNE_BATCH = 10_000;
/** How far back a journey's from-step may be from its to-step (spans midnight, email
 *  confirmation delays, etc.). */
const LOOKBACK_HOURS = 48;

/** The transitions the dashboard cares about. key: how the two steps are joined -
 *  'session' for pre-auth journeys, 'user' for cross-session post-auth journeys. */
const TRANSITIONS: ReadonlyArray<{ from: string; to: string; key: 'session' | 'user' }> = [
  { from: 'scan_landing_viewed', to: 'registration_started', key: 'session' },
  { from: 'registration_started', to: 'account_created', key: 'session' },
  { from: 'scan_landing_viewed', to: 'account_created', key: 'session' },
  { from: 'account_created', to: 'profile_setup_completed', key: 'user' },
  { from: 'account_created', to: 'submission_accepted', key: 'user' },
  { from: 'submit_page_viewed', to: 'submit_attempted', key: 'session' },
  { from: 'submit_attempted', to: 'submission_accepted', key: 'session' },
  { from: 'otp_requested', to: 'otp_verified', key: 'user' },
];

export const rollupFunnelDaily = async (): Promise<void> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query(`SELECT pg_try_advisory_xact_lock(12, 0) AS ok`);
    if (!lock.rows[0].ok) {
      // Another instance is already rolling up - nothing to do. Release BEFORE returning:
      // this early exit sits outside the finally below, and a leaked connection per skipped
      // daily run would quietly starve the 10-slot pool on scaled deployments.
      await client.query('COMMIT');
      client.release();
      return;
    }
    // Nightly batch, not a request path: give the aggregation queries batch headroom
    // instead of the pool's 10s request budget (SET LOCAL = this transaction only).
    // Scale note: if the transition LATERAL ever outgrows even this, the upgrade path is
    // composite indexes on (event_type, session_id|user_id, occurred_at) + materializing
    // both step sets into a temp table before joining.
    await client.query(`SET LOCAL statement_timeout = '300s'`);

    // Window: the last N full days, ending yesterday (today is still accumulating).
    const range = await client.query(
      `SELECT (CURRENT_DATE - $1::int) AS from_day, CURRENT_DATE AS to_day`,
      [RECOMPUTE_DAYS],
    );
    const fromDay = range.rows[0].from_day;
    const toDay = range.rows[0].to_day; // exclusive

    await client.query(
      `INSERT INTO funnel_daily (day, event_type, device_class, n)
       SELECT occurred_at::date, event_type, COALESCE(device_class, ''), COUNT(*)::int
       FROM funnel_event
       WHERE occurred_at >= $1::date AND occurred_at < $2::date
       GROUP BY 1, 2, 3
       ON CONFLICT (day, event_type, device_class) DO UPDATE SET n = EXCLUDED.n`,
      [fromDay, toDay],
    );

    for (const t of TRANSITIONS) {
      const keyCol = t.key === 'session' ? 'session_id' : 'user_id';
      await client.query(
        `INSERT INTO funnel_transition_daily (day, from_step, to_step, n, avg_s, p50_s, p90_s)
         SELECT d.day, $3, $4, COUNT(*)::int,
                AVG(d.delta_s),
                percentile_cont(0.5) WITHIN GROUP (ORDER BY d.delta_s),
                percentile_cont(0.9) WITHIN GROUP (ORDER BY d.delta_s)
         FROM (
           -- GREATEST(...) clamps the batching artifact: a client from-step can arrive a
           -- few seconds AFTER its server-emitted to-step (flush lag), so the from-step
           -- window extends 10s past the to-step and negative deltas count as 0.
           SELECT dst.day, GREATEST(EXTRACT(EPOCH FROM (dst.t - src.t)), 0) AS delta_s
           FROM (
             SELECT ${keyCol} AS k, occurred_at::date AS day, MIN(occurred_at) AS t
             FROM funnel_event
             WHERE event_type = $4 AND ${keyCol} IS NOT NULL
               AND occurred_at >= $1::date AND occurred_at < $2::date
             GROUP BY 1, 2
           ) dst
           JOIN LATERAL (
             SELECT MIN(f.occurred_at) AS t
             FROM funnel_event f
             WHERE f.${keyCol} = dst.k AND f.event_type = $3
               AND f.occurred_at <= dst.t + interval '10 seconds'
               AND f.occurred_at >= dst.t - make_interval(hours => $5)
           ) src ON src.t IS NOT NULL
         ) d
         GROUP BY d.day
         ON CONFLICT (day, from_step, to_step)
         DO UPDATE SET n = EXCLUDED.n, avg_s = EXCLUDED.avg_s, p50_s = EXCLUDED.p50_s, p90_s = EXCLUDED.p90_s`,
        [fromDay, toDay, t.from, t.to, LOOKBACK_HOURS],
      );
    }

    // Commit the aggregation FIRST: a prune failure must never roll back the rollups
    // (that failure mode would silently starve the dashboards forever).
    await client.query('COMMIT');
  } catch (err) {
    await safeRollback(client);
    client.release();
    throw err;
  }

  try {
    // Retention: prune raw events past the window in bounded batches. Each batch gets its
    // own mini-transaction with a 60s SET LOCAL budget - the aggregation's SET LOCAL died
    // at its COMMIT, and the pool's 10s request budget is too tight for a cold DELETE on a
    // large backlog (a silent prune failure would let the table grow unboundedly). LOCAL
    // scope means the pooled connection returns with its normal timeout untouched. Runs
    // outside the advisory lock - concurrent prunes are harmless, they delete the same
    // dead rows. Rollups already hold the history.
    for (;;) {
      let del;
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = '60s'`);
        del = await client.query(
          `DELETE FROM funnel_event
           WHERE id IN (
             SELECT id FROM funnel_event
             WHERE occurred_at < NOW() - make_interval(days => $1)
             LIMIT $2
           )`,
          [RETENTION_DAYS, PRUNE_BATCH],
        );
        await client.query('COMMIT');
      } catch (err) {
        await safeRollback(client);
        throw err;
      }
      if ((del.rowCount ?? 0) < PRUNE_BATCH) break;
    }
  } finally {
    client.release();
  }
};
