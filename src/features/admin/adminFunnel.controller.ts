import { Request, Response } from 'express';
import { getPool } from '../../shared/db/db.js';

// GET /admin/funnel?days=7|30|90 - the funnel dashboard's single data source.
//
// Two sources, deliberately mixed:
//  - Step counts, daily trend, and rejection reasons come from RAW funnel_event, so the
//    dashboard is LIVE (includes today, which the nightly rollup excludes by design).
//    Range-capped at 90 days, inside the 180-day raw retention; the BRIN time index
//    makes these range scans cheap, and the endpoint sits behind the admin role gate +
//    admin limiter. Scale note: if raw volume ever makes this slow, switch counts to
//    funnel_daily and accept counts lagging one day.
//  - Transition timings (avg/p50/p90) come from funnel_transition_daily (nightly),
//    aggregated with an n-weighted average - approximate but plenty for a dashboard.
const ALLOWED_DAYS = [7, 30, 90];

// The funnel is the CONSUMER journey. Emission is role-gated at the source (auth sync,
// profile setup, phone OTP, register page), but events recorded before that gate - and
// any future authed staff event - are excluded here too. Anonymous pre-auth events
// (user_id NULL) stay: they cannot be attributed to a role and are overwhelmingly
// consumer traffic. Deleted accounts also land here (FK ON DELETE SET NULL nulls their
// user_id), so their history keeps counting as anonymous - accepted, and why
// people['account_created'] can sit slightly above journey.accounts.
// user_id is table-qualified: the flyer-scans query joins business (which has its own
// user_id column) and an unqualified reference would be ambiguous there.
const CONSUMER_EVENTS_ONLY = `(funnel_event.user_id IS NULL OR EXISTS (
  SELECT 1 FROM "user" u WHERE u.id = funnel_event.user_id AND u.role = 'User'
))`;

export const getFunnelAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const days = ALLOWED_DAYS.includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const pool = getPool();

    const [totals, reasons, daily, transitions, journey, flyerScans] = await Promise.all([
      // n = raw events (volume); people = distinct persons. The person key prefers
      // user_id (dedups one user across sessions and days), falls back to session_id
      // for anonymous pre-auth events (one journey = one person), and finally the
      // event itself for server events carrying neither (counts 1, never drops to 0).
      pool.query(
        `SELECT event_type, COUNT(*)::int AS n,
                COUNT(DISTINCT COALESCE(user_id::text, session_id::text, event_id::text))::int AS people
         FROM funnel_event
         WHERE occurred_at >= CURRENT_DATE - $1::int
           AND ${CONSUMER_EVENTS_ONLY}
         GROUP BY 1`,
        [days],
      ),
      pool.query(
        `SELECT COALESCE(reason_code, 'unknown_error') AS reason, COUNT(*)::int AS n
         FROM funnel_event
         WHERE event_type = 'submission_rejected' AND occurred_at >= CURRENT_DATE - $1::int
           AND ${CONSUMER_EVENTS_ONLY}
         GROUP BY 1 ORDER BY 2 DESC`,
        [days],
      ),
      pool.query(
        `SELECT occurred_at::date::text AS day,
                COUNT(*) FILTER (WHERE event_type = 'account_created')::int    AS accounts,
                COUNT(*) FILTER (WHERE event_type = 'submission_accepted')::int AS submissions
         FROM funnel_event
         WHERE occurred_at >= CURRENT_DATE - $1::int
           AND ${CONSUMER_EVENTS_ONLY}
         GROUP BY 1 ORDER BY 1`,
        [days],
      ),
      pool.query(
        `SELECT from_step, to_step, SUM(n)::int AS n,
                SUM(avg_s * n) / NULLIF(SUM(n), 0) AS avg_s,
                SUM(p50_s * n) / NULLIF(SUM(n), 0) AS p50_s,
                SUM(p90_s * n) / NULLIF(SUM(n), 0) AS p90_s
         FROM funnel_transition_daily
         WHERE day >= CURRENT_DATE - $1::int
         GROUP BY 1, 2`,
        [days],
      ),
      // New-user journey: PER-USER (not per-event) activation funnel for the cohort who
      // created their account in the range. Answers the question the event funnels can't:
      // how many new users never got an entry. EXISTS lookups ride the partial user index.
      pool.query(
        `WITH cohort AS (
           SELECT DISTINCT user_id FROM funnel_event
           WHERE event_type = 'account_created' AND user_id IS NOT NULL
             AND occurred_at >= CURRENT_DATE - $1::int
             AND ${CONSUMER_EVENTS_ONLY}
         )
         SELECT
           COUNT(*)::int AS accounts,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM funnel_event f WHERE f.user_id = c.user_id AND f.event_type = 'otp_verified'
           ))::int AS phone_verified,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM funnel_event f WHERE f.user_id = c.user_id
               AND f.event_type IN ('submit_attempted', 'submission_accepted', 'submission_rejected')
           ))::int AS tried_entry,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM funnel_event f WHERE f.user_id = c.user_id AND f.event_type = 'submission_accepted'
           ))::int AS got_entry
         FROM cohort c`,
        [days],
      ),
      // Per-location flyer performance: every flyer QR lands on /scan?l=<id>, which fires
      // scan_landing_viewed with that location_id. Visitors counts PEOPLE, not raw scans -
      // dedup by user, falling back to journey session for anonymous scanners (the common
      // case - most people scan before they have an account). Signups come from
      // user_acquisition (written once at signup), range-matched on its own created_at;
      // deleted locations drop out via the inner join, same as the Users-tab "Joined via"
      // dropdown. Bounded: one row per location that had a scan in range, capped at 100
      // as a payload guard.
      pool.query(
        `SELECT funnel_event.location_id,
                bl.name AS location_name,
                b.name AS business_name,
                COUNT(DISTINCT COALESCE(funnel_event.user_id::text, funnel_event.session_id::text, funnel_event.event_id::text))::int AS visitors,
                (SELECT COUNT(*) FROM user_acquisition ua
                 WHERE ua.location_id = funnel_event.location_id
                   AND ua.source = 'location_flyer'
                   AND ua.created_at >= CURRENT_DATE - $1::int)::int AS signups
         FROM funnel_event
         JOIN business_location bl ON bl.id = funnel_event.location_id
         JOIN business b ON b.id = bl.business_id
         WHERE funnel_event.event_type = 'scan_landing_viewed'
           AND funnel_event.occurred_at >= CURRENT_DATE - $1::int
           AND ${CONSUMER_EVENTS_ONLY}
         GROUP BY funnel_event.location_id, bl.name, b.name
         ORDER BY visitors DESC
         LIMIT 100`,
        [days],
      ),
    ]);

    const totalsMap: Record<string, number> = {};
    const peopleMap: Record<string, number> = {};
    for (const row of totals.rows as Array<{ event_type: string; n: number; people: number }>) {
      totalsMap[row.event_type] = row.n;
      peopleMap[row.event_type] = row.people;
    }

    res.json({
      days,
      totals: totalsMap,
      people: peopleMap,
      rejectionReasons: reasons.rows,
      daily: daily.rows,
      transitions: transitions.rows,
      journey: journey.rows[0],
      flyerScans: flyerScans.rows,
    });
  } catch (err) {
    console.error('[admin] funnel analytics failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ message: 'Failed to load funnel analytics.' });
  }
};
