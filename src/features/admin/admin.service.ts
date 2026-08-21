import { getPool } from '../../shared/db/db.js';
import { safeRollback } from '../../shared/db/txn.js';
import { OPEN_DRAW_ID_SUBQUERY } from '../../shared/db/queries.js';
import { getPlatformSettings, invalidatePlatformSettings, invalidatePublicBusinessData, invalidateUserAuth } from '../../shared/cache/cache.js';
import { lastDayOfMonthNyMidnightUtc, nextCampaignOpensNy, drawDateFromString, drawStartDateFromString, nyMidnightFromString } from '../../shared/dates.js';
import { sendFoundingFinalCampaignEmail } from '../../shared/email/email.service.js';
import { snapshotOfficialRulesForDraw } from '../../shared/legal/officialRulesSnapshot.js';
import { decayAllUserRiskScores } from '../risk/risk.service.js';

// Entry sources that need no receipt verification. Winner validation is expected to end at
// the first one it reaches, so the stored selection order stops at the first auto-valid
// entry - but never before WINNER_ORDER_MIN positions are stored.
export const AUTO_VALID_SOURCES = ['free', 'promo', 'referral'];
// How many positions each generation/extension of the selection order draws at most. The
// stored order is a bounded prefix of a full fair shuffle: batches are drawn lazily
// (uniformly, without replacement) instead of materializing a row per entry, which is
// statistically identical to ranking the whole pool and matches the Official Rules
// alternate-selection clause (alternates drawn at random from the remaining entries).
const WINNER_ORDER_BATCH = 200;
// Floor: every draw stores at least this many positions (when the pool has that many),
// regardless of auto-valid entries landing earlier in the order.
const WINNER_ORDER_MIN = 70;

// Selects the current top of the drawn list: the lowest stored position whose ticket is
// still eligible and not rejected. Shared by pickDrawWinnerService and the admin-approved
// list extension (extendDrawWinnerOrderService).
const WINNER_PICK_SQL = `
  SELECT
    t.id AS ticket_id,
    t.code,
    t.activated_by_user_id,
    t.receipt_identifier,
    t.transaction_amount,
    t.transaction_date,
    t.receipt_image_url,
    t.entry_source,
    t.image_validation_status,
    u.full_name,
    u.email,
    u.risk_score,
    b.name AS business_name,
    bl.name AS location_name,
    dwo.position AS queue_position,
    (SELECT COUNT(*)::int FROM draw_winner_order o WHERE o.draw_id = $1) AS queue_total
  FROM draw_winner_order dwo
  JOIN ticket t ON t.id = dwo.ticket_id
  JOIN "user" u ON t.activated_by_user_id = u.id AND u.risk_score < 20 AND u.is_active = TRUE
  LEFT JOIN business b ON t.business_id = b.id
  LEFT JOIN business_location bl ON t.location_id = bl.id
  WHERE dwo.draw_id = $1
    AND t.status = 'Activated'
    AND t.is_quarantined = FALSE
    AND NOT EXISTS (
      SELECT 1 FROM draw_rejected_winner drw
      WHERE drw.draw_id = dwo.draw_id AND drw.ticket_id = t.id
    )
  ORDER BY dwo.position
  LIMIT 1
`;

export type PickedWinner = {
  winnerId: number;
  winnerName: string;
  winnerEmail: string;
  ticketCode: string;
  businessName: string | null;
  locationName: string | null;
  prizePool: number;
  receiptIdentifier: string | null;
  transactionAmount: number | null;
  transactionDate: string | null;
  receiptImageUrl: string | null;
  entrySource: string | null;
  imageValidationStatus: string | null;
  riskScore: number;
  queuePosition: number;
  queueTotal: number;
};

// Returned when the stored list has no eligible entry left. The rejection that led here (if
// any) is COMMITTED - never rolled back - and the admin must explicitly draw the next batch
// via extendDrawWinnerOrderService before a new candidate can exist.
export type PickExhausted = { exhausted: true; queueTotal: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mapPickedWinnerRow = (winner: any, prizePool: number): PickedWinner => ({
  winnerId: winner.activated_by_user_id,
  winnerName: winner.full_name,
  winnerEmail: winner.email,
  ticketCode: winner.code,
  businessName: winner.business_name,
  locationName: winner.location_name,
  prizePool,
  receiptIdentifier: winner.receipt_identifier ?? null,
  transactionAmount: winner.transaction_amount ? parseFloat(winner.transaction_amount) : null,
  transactionDate: winner.transaction_date ?? null,
  receiptImageUrl: winner.receipt_image_url ?? null,
  entrySource: winner.entry_source ?? null,
  imageValidationStatus: winner.image_validation_status ?? null,
  riskScore: winner.risk_score ?? 0,
  queuePosition: winner.queue_position,
  queueTotal: winner.queue_total,
});

const logDrawAudit = async (
  client: import('pg').PoolClient,
  drawId: number,
  action: string,
  // The admin who performed the action. Every draw mutation is admin-initiated, so this is
  // always a real id in practice; typed nullable only so a future automated caller can pass null.
  actorUserId: number | null,
  metadata?: Record<string, unknown>,
) => {
  await client.query(
    `INSERT INTO draw_audit_log (draw_id, action, actor_user_id, metadata) VALUES ($1, $2, $3, $4)`,
    [drawId, action, actorUserId, metadata ? JSON.stringify(metadata) : null],
  );
};

// ---------------------------------------------------------------------------
// biz_health CTE
// ---------------------------------------------------------------------------
// This literal is the single definition of every health flag threshold.
// Both getBusinessesWithStats and getBusinessHealthSummaryService embed it
// verbatim so the thresholds are never duplicated.
//
// Scoped to the single open draw (earliest draw_date ASC LIMIT 1 when several
// exist, which should never happen in practice but is safe-guarded).
//
// Cap rule: tickets counted ONLY when is_quarantined = FALSE AND
//           activated_by_user_id IS NOT NULL (this is the universal cap rule
//           used everywhere in the codebase — never deviate).
//
// total_cap = cap_at_entry * COUNT(active locations).
// Fallback to subscription.entries_per_location when cap_at_entry is NULL
// (legacy rows before draw_entry.cap_at_entry was added).
//
// Flag rationale:
//   billing_issue  — subscription failed or incomplete; admin may need to
//                    contact the owner before they are auto-dropped.
//   setup_gap      — subscribed but not ready to receive entries; each clause
//                    catches a distinct incompleteness:
//                      * no receipt image: customers cannot verify purchases
//                      * no active location: business is invisible on the map
//                      * not enrolled in open draw: enrolled check prevents
//                        false positives for businesses whose plan changed
//                        mid-campaign and were not re-enrolled.
//   no_recent_entries — enrolled in the open draw, the campaign has been open
//                    for >7 days (grace period excludes freshly-opened draws),
//                    but zero entries in the last 7 days: potentially abandoned
//                    or the business stopped promoting participation.
//   low_engagement — enrolled and has entries but the engagement signal is
//                    weak, suggesting the receipt flow is not converting well:
//                      * unique_customers <= 2: too few distinct customers
//                        (could be just the owner testing)
//                      * repeat_customers = 0 AND unique_customers >= 5:
//                        five different customers but none returned — no
//                        loyalty signal at all
//                      * views_30d >= 10 AND entries_current < 3: the
//                        location is being discovered on the map but almost
//                        nobody is completing a receipt entry (funnel drop-off)
//
// health:
//   'at_risk' — billing_issue OR no_recent_entries (revenue / participation risk)
//   'watch'   — not at_risk, but setup_gap OR low_engagement (growth risk)
//   'good'    — no flags
// ---------------------------------------------------------------------------
// The EXACT eligibility predicate openDrawInTx uses to auto-enroll businesses when a draw
// opens (alias `s` = subscription). Shared between the real enrollment INSERT and the
// "next campaign ready" preview below so the preview can never drift from reality.
const ENROLLMENT_ELIGIBLE_SQL = `s.status IN ('Active', 'Trialing')
      AND s.current_period_end >= NOW()
      AND s.skip_next_campaign = FALSE
      AND s.participation_paused = FALSE`;

const BIZ_HEALTH_CTE = `
  -- open_draw: resolve the single open draw once; NULL when none is open.
  open_draw AS (
    SELECT id, start_date FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1
  ),
  -- ticket_agg: flat aggregates per business for the open draw.
  -- LEFT JOIN so businesses with no tickets still appear (all counts default to 0).
  ticket_agg AS (
    SELECT
      t.business_id,
      COUNT(*) FILTER (
        WHERE t.is_quarantined = FALSE AND t.activated_by_user_id IS NOT NULL
      )::int                                                                       AS entries_current,
      COUNT(*) FILTER (
        WHERE t.is_quarantined = FALSE AND t.activated_by_user_id IS NOT NULL
          AND t.activated_at >= NOW() - INTERVAL '7 days'
      )::int                                                                       AS entries_7d,
      COUNT(DISTINCT t.activated_by_user_id) FILTER (
        WHERE t.is_quarantined = FALSE AND t.activated_by_user_id IS NOT NULL
      )::int                                                                       AS unique_customers,
      MAX(t.activated_at) FILTER (
        WHERE t.is_quarantined = FALSE AND t.activated_by_user_id IS NOT NULL
      )                                                                            AS last_entry_at
    FROM ticket t
    WHERE t.draw_id = (SELECT id FROM open_draw)
    GROUP BY t.business_id
  ),
  -- repeat_agg: count customers with >= 2 entries in the open draw.
  repeat_agg AS (
    SELECT
      t.business_id,
      COUNT(*) FILTER (WHERE cnt >= 2)::int AS repeat_customers
    FROM (
      SELECT t.business_id, t.activated_by_user_id, COUNT(*) AS cnt
      FROM ticket t
      WHERE t.draw_id       = (SELECT id FROM open_draw)
        AND t.is_quarantined = FALSE
        AND t.activated_by_user_id IS NOT NULL
      GROUP BY t.business_id, t.activated_by_user_id
    ) t
    GROUP BY t.business_id
  ),
  -- views_agg: profile-view count per business over the last 30 days.
  views_agg AS (
    SELECT
      bpv.business_id,
      COUNT(*)::int AS views_30d
    FROM business_profile_view bpv
    WHERE bpv.last_viewed_at >= NOW() - INTERVAL '30 days'
    GROUP BY bpv.business_id
  ),
  -- active_loc_agg: count of active locations per business (used in setup_gap and total_cap).
  active_loc_agg AS (
    SELECT business_id, COUNT(*)::int AS active_count
    FROM business_location
    WHERE is_active = TRUE
    GROUP BY business_id
  ),
  -- biz_health: one row per business with all health fields.
  biz_health AS (
    SELECT
      b.id AS business_id,

      -- Enrollment: TRUE when this business has a draw_entry row for the open draw.
      (EXISTS (
        SELECT 1 FROM draw_entry de
        WHERE de.draw_id = (SELECT id FROM open_draw) AND de.business_id = b.id
      ))                                                                          AS enrolled,

      -- Entry metrics (default to 0 when no tickets exist yet).
      COALESCE(ta.entries_current,  0)::int                                       AS entries_current,
      COALESCE(ta.entries_7d,       0)::int                                       AS entries_7d,
      COALESCE(ta.unique_customers, 0)::int                                       AS unique_customers,
      COALESCE(ra.repeat_customers, 0)::int                                       AS repeat_customers,
      ta.last_entry_at,

      -- Profile views in the last 30 days (0 when none).
      COALESCE(va.views_30d, 0)::int                                              AS views_30d,

      -- Total capacity: cap_at_entry * active_locations (fallback to entries_per_location).
      (
        COALESCE(de.cap_at_entry, s.entries_per_location)
        * COALESCE(ala.active_count, 0)
      )::int                                                                       AS total_cap,

      -- next_campaign_ready: will be AUTO-ENROLLED the moment the next campaign opens.
      -- COALESCE because a business with no subscription row yields NULL, which must read
      -- as "not ready", never as unknown.
      COALESCE((${ENROLLMENT_ELIGIBLE_SQL}), FALSE)                               AS next_campaign_ready,

      -- billing_issue: subscription is in a failed or incomplete payment state.
      -- (un-subscribed businesses never have billing_issue — nothing to fix)
      (s.status IN ('Past_Due', 'Incomplete'))                                    AS billing_issue,

      -- setup_gap: subscribed but not operationally ready to earn entries.
      -- Only applies to subscribed businesses (no point flagging unsubscribed ones).
      (
        s.status IN ('Active', 'Trialing')
        AND (
          -- No receipt image: customers at the counter cannot verify the business's receipts
          b.receipt_example_image_url IS NULL
          -- No active location: business is invisible on the map
          OR COALESCE(ala.active_count, 0) = 0
          -- Not enrolled in the open draw: subscribed but somehow missed enrollment.
          -- Guarded on an open draw existing: with no draw open, NOT EXISTS is vacuously
          -- TRUE and would wrongly flag EVERY subscribed business between campaigns.
          OR (
            (SELECT id FROM open_draw) IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM draw_entry de2
              WHERE de2.draw_id = (SELECT id FROM open_draw) AND de2.business_id = b.id
            )
          )
        )
      )                                                                            AS setup_gap,

      -- no_recent_entries: enrolled, campaign has been open > 7 days (grace period),
      -- but no entries in the last 7 days — potentially abandoned or under-promoted.
      (
        EXISTS (
          SELECT 1 FROM draw_entry de3
          WHERE de3.draw_id = (SELECT id FROM open_draw) AND de3.business_id = b.id
        )
        AND (SELECT start_date FROM open_draw) <= NOW() - INTERVAL '7 days'
        AND COALESCE(ta.entries_7d, 0) = 0
      )                                                                            AS no_recent_entries,

      -- low_engagement: enrolled and has at least one entry but weak engagement signal.
      (
        EXISTS (
          SELECT 1 FROM draw_entry de4
          WHERE de4.draw_id = (SELECT id FROM open_draw) AND de4.business_id = b.id
        )
        AND COALESCE(ta.entries_current, 0) > 0
        AND (
          -- Too few distinct customers: could be just the owner/staff testing the flow
          COALESCE(ta.unique_customers, 0) <= 2
          -- Five-plus customers but not one returned: zero loyalty signal
          OR (COALESCE(ra.repeat_customers, 0) = 0 AND COALESCE(ta.unique_customers, 0) >= 5)
          -- Map discovery without conversion: location is being found but receipt flow drops off
          OR (COALESCE(va.views_30d, 0) >= 10 AND COALESCE(ta.entries_current, 0) < 3)
        )
      )                                                                            AS low_engagement

    FROM business b
    LEFT JOIN subscription        s   ON s.business_id  = b.id
    LEFT JOIN draw_entry          de  ON de.business_id = b.id
                                     AND de.draw_id     = (SELECT id FROM open_draw)
    LEFT JOIN ticket_agg          ta  ON ta.business_id = b.id
    LEFT JOIN repeat_agg          ra  ON ra.business_id = b.id
    LEFT JOIN views_agg           va  ON va.business_id = b.id
    LEFT JOIN active_loc_agg      ala ON ala.business_id = b.id
  )
`;

// Allowed filter values for the businesses list endpoint.
type BusinessHealthFilter = 'attention' | 'no_recent_entries' | 'low_engagement' | 'billing' | 'setup' | 'next_ready';
const VALID_HEALTH_FILTERS = new Set<BusinessHealthFilter>(['attention', 'no_recent_entries', 'low_engagement', 'billing', 'setup', 'next_ready']);

export const getBusinessesWithStats = async (params: {
  page: number;
  limit: number;
  search?: string;
  filter?: string;
  // When set, exclude businesses already enrolled (draw_entry) in this draw. Powers the admin
  // campaign "add business" search so it only ever surfaces non-participating businesses.
  excludeDrawId?: number;
}) => {
  const pool = getPool();
  const { page, limit, search, excludeDrawId } = params;
  // Whitelist the filter value — invalid strings are silently ignored (treated as absent)
  // so a client sending an unknown value never triggers a 400; it just gets unfiltered results.
  const filter: BusinessHealthFilter | undefined = VALID_HEALTH_FILTERS.has(params.filter as BusinessHealthFilter)
    ? (params.filter as BusinessHealthFilter)
    : undefined;
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (search) {
    conditions.push(`(b.name ILIKE $${idx} OR u.full_name ILIKE $${idx} OR u.email ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }

  // Exclude businesses already participating in the given draw (validated as a positive int
  // by the caller). Parameterized like every other value - never string-interpolated.
  if (excludeDrawId != null) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM draw_entry de_ex WHERE de_ex.business_id = b.id AND de_ex.draw_id = $${idx})`);
    values.push(excludeDrawId);
    idx++;
  }

  // When a health filter is active, restrict to businesses that have that flag set.
  // 'attention' means any flag at all. Pushed into the shared conditions list so the WHERE
  // clause is always well-formed regardless of whether a search term is present.
  if (filter) {
    conditions.push(
      filter === 'attention'
        ? `(h.billing_issue OR h.setup_gap OR h.no_recent_entries OR h.low_engagement)`
        : filter === 'no_recent_entries'
        ? `h.no_recent_entries`
        : filter === 'low_engagement'
        ? `h.low_engagement`
        : filter === 'billing'
        ? `h.billing_issue`
        : filter === 'next_ready'
        ? `h.next_campaign_ready`
        : `h.setup_gap`, // 'setup'
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Default order is b.name ASC.
  // When a filter is active, sort worst-first (at_risk before watch before good,
  // then alphabetically within each tier) so the most urgent businesses surface first.
  // The tier is derived from the CTE's flag booleans here - `health` itself is a SELECT-list
  // alias (not a CTE column), so ORDER BY cannot reference it as h.health.
  const orderBy = filter
    ? `ORDER BY CASE
         WHEN h.billing_issue OR h.no_recent_entries THEN 0
         WHEN h.setup_gap OR h.low_engagement        THEN 1
         ELSE                                             2
       END ASC, b.name ASC`
    : `ORDER BY b.name ASC`;

  const [rowsRes, countRes] = await Promise.all([
    pool.query(`
      WITH ${BIZ_HEALTH_CTE}
      SELECT
        b.id,
        b.name,
        b.sector,
        s.entries_per_location,
        (s.status IN ('Active', 'Trialing')) AS is_subscribed,
        u.full_name AS owner_name,
        u.email AS owner_email,
        s.status AS subscription_status,
        s.current_period_end,
        s.fee_at_entry,
        COALESCE(loc.location_count, 0) AS location_count,
        (SELECT COUNT(*)::int FROM ticket WHERE business_id = b.id AND is_quarantined = FALSE AND activated_by_user_id IS NOT NULL) AS total_activated,
        -- Health fields from the biz_health CTE
        h.enrolled,
        h.next_campaign_ready,
        h.entries_current,
        h.entries_7d,
        h.unique_customers,
        h.repeat_customers,
        h.last_entry_at,
        h.views_30d,
        h.total_cap,
        -- Collapse boolean flags into a text[] for easy client consumption
        ARRAY_REMOVE(ARRAY[
          CASE WHEN h.billing_issue    THEN 'billing_issue'    END,
          CASE WHEN h.setup_gap        THEN 'setup_gap'        END,
          CASE WHEN h.no_recent_entries THEN 'no_recent_entries' END,
          CASE WHEN h.low_engagement   THEN 'low_engagement'   END
        ], NULL)                                                AS flags,
        -- Derived health tier
        CASE
          WHEN h.billing_issue OR h.no_recent_entries THEN 'at_risk'
          WHEN h.setup_gap OR h.low_engagement        THEN 'watch'
          ELSE                                              'good'
        END                                                     AS health
      FROM business b
      LEFT JOIN "user" u ON b.user_id = u.id
      LEFT JOIN subscription s ON s.business_id = b.id
      LEFT JOIN (
        SELECT business_id, COUNT(*) AS location_count FROM business_location GROUP BY business_id
      ) loc ON loc.business_id = b.id
      JOIN biz_health h ON h.business_id = b.id
      ${where}
      ${orderBy}
      LIMIT $${idx} OFFSET $${idx + 1}
    `, [...values, limit, offset]),
    pool.query(`
      WITH ${BIZ_HEALTH_CTE}
      SELECT COUNT(*) AS total
      FROM business b
      LEFT JOIN "user" u ON b.user_id = u.id
      JOIN biz_health h ON h.business_id = b.id
      ${where}
    `, values),
  ]);

  return {
    rows: rowsRes.rows,
    total: Number(countRes.rows[0]?.total ?? 0),
    page,
    limit,
    totalPages: Math.ceil(Number(countRes.rows[0]?.total ?? 0) / limit),
  };
};

export const getBusinessHealthSummaryService = async (): Promise<{
  total: number;
  attention: number;
  no_recent_entries: number;
  low_engagement: number;
  billing: number;
  setup: number;
  next_ready: number;
}> => {
  const pool = getPool();
  const result = await pool.query(`
    WITH ${BIZ_HEALTH_CTE}
    SELECT
      COUNT(*)::int                                                              AS total,
      COUNT(*) FILTER (
        WHERE h.billing_issue OR h.setup_gap OR h.no_recent_entries OR h.low_engagement
      )::int                                                                     AS attention,
      COUNT(*) FILTER (WHERE h.no_recent_entries)::int                          AS no_recent_entries,
      COUNT(*) FILTER (WHERE h.low_engagement)::int                             AS low_engagement,
      COUNT(*) FILTER (WHERE h.billing_issue)::int                              AS billing,
      COUNT(*) FILTER (WHERE h.setup_gap)::int                                  AS setup,
      COUNT(*) FILTER (WHERE h.next_campaign_ready)::int                        AS next_ready
    FROM business b
    JOIN biz_health h ON h.business_id = b.id
  `);
  const row = result.rows[0];
  return {
    total:             Number(row?.total             ?? 0),
    attention:         Number(row?.attention         ?? 0),
    no_recent_entries: Number(row?.no_recent_entries ?? 0),
    low_engagement:    Number(row?.low_engagement    ?? 0),
    billing:           Number(row?.billing           ?? 0),
    setup:             Number(row?.setup             ?? 0),
    next_ready:        Number(row?.next_ready        ?? 0),
  };
};

export const getActiveDraws = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, status
    FROM draw
    WHERE status = 'Open'
  `);
  return result.rows;
};

export const createBusinessService = async (data: {
  owner_user_id: number;
  name: string;
  sector: string;
  location: string;
  latitude?: number;
  longitude?: number;
}) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One user = one business (UNIQUE business.user_id). Same guard as the self-serve setup
    // path so the admin gets a clean 409 instead of a raw constraint violation.
    const existing = await client.query(
      `SELECT id FROM business WHERE user_id = $1 LIMIT 1`,
      [data.owner_user_id],
    );
    if (existing.rows.length > 0) {
      throw new Error('BUSINESS_ALREADY_EXISTS');
    }
    const bizResult = await client.query(
      `INSERT INTO business (user_id, name, sector) VALUES ($1, $2, $3) RETURNING *`,
      [data.owner_user_id, data.name, data.sector],
    );
    const business = bizResult.rows[0];
    await client.query(
      `INSERT INTO business_location (business_id, name, address, latitude, longitude, is_active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [business.id, data.name, data.location, data.latitude ?? null, data.longitude ?? null],
    );
    await client.query('COMMIT');
    return business;
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
};

export const getAllDrawsService = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      d.id,
      d.name,
      d.prize_pool AS prize_amount,
      d.prize_revealed,
      d.start_date,
      d.draw_date,
      d.status,
      d.winner_user_id,
      d.winner_ticket_id,
      d.winner_confirmed,
      NULLIF(drw.rejected_count, 0)::int AS rejected_count,
      COALESCE(tc.entry_count, 0)::int AS entry_count
    FROM draw d
    LEFT JOIN (
      SELECT draw_id, COUNT(*)::int AS rejected_count
      FROM draw_rejected_winner GROUP BY draw_id
    ) drw ON drw.draw_id = d.id
    LEFT JOIN (
      SELECT draw_id, COUNT(*)::int AS entry_count
      FROM ticket
      WHERE is_quarantined = FALSE AND activated_by_user_id IS NOT NULL
      GROUP BY draw_id
    ) tc ON tc.draw_id = d.id
    ORDER BY d.draw_date DESC
  `);
  return result.rows;
};

// lastDayOfMonthNyMidnightUtc moved to shared/dates.ts — stripe.service needs the same
// campaign-calendar math for the founding-to-regular transition window.

export const updateDrawService = async (
  drawId: number,
  data: { name?: string; prize_amount?: number; draw_date?: string; start_date?: string },
) => {
  const pool = getPool();

  // Verify draw exists and is Upcoming (dates needed to validate a partial update)
  const existing = await pool.query(
    `SELECT id, status, start_date, draw_date FROM draw WHERE id = $1`,
    [drawId],
  );
  if (!existing.rows[0]) throw new Error('Campaign not found');
  if (existing.rows[0].status !== 'Upcoming')
    throw new Error('Only upcoming campaigns can be edited');

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.name !== undefined) {
    const trimmed = data.name.trim();
    if (!trimmed) throw new Error('name must not be empty');
    updates.push(`name = $${idx++}`);
    values.push(trimmed);
  }
  if (data.prize_amount !== undefined) {
    if (data.prize_amount <= 0) throw new Error('prize_amount must be positive');
    updates.push(`prize_pool = $${idx++}`);
    values.push(data.prize_amount);
  }
  // An explicit start pick wins; when only the draw date moves, the start snaps back
  // to the 1st of the new month (the default pairing) rather than keeping a stale day.
  const newDrawDate = data.draw_date !== undefined ? drawDateFromString(data.draw_date) : undefined;
  const newStartDate = data.start_date !== undefined
    ? nyMidnightFromString(data.start_date)
    : data.draw_date !== undefined
    ? drawStartDateFromString(data.draw_date)
    : undefined;
  const finalDrawDate = newDrawDate ?? (existing.rows[0].draw_date ? new Date(existing.rows[0].draw_date) : undefined);
  const finalStartDate = newStartDate ?? (existing.rows[0].start_date ? new Date(existing.rows[0].start_date) : undefined);
  if (finalStartDate && finalDrawDate && finalStartDate.getTime() >= finalDrawDate.getTime())
    throw new Error('Start date must be before the draw date');
  if (newDrawDate !== undefined) {
    updates.push(`draw_date = $${idx++}`);
    values.push(newDrawDate);
  }
  if (newStartDate !== undefined) {
    updates.push(`start_date = $${idx++}`);
    values.push(newStartDate);
  }

  if (updates.length === 0) throw new Error('No fields to update');

  values.push(drawId);
  const result = await pool.query(
    `UPDATE draw SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, name, prize_pool AS prize_amount, start_date, draw_date, status`,
    values,
  );
  invalidatePublicBusinessData();
  return result.rows[0];
};

// Prize teaser toggle: while a campaign is Upcoming its prize is hidden publicly until
// the admin reveals it. Only meaningful pre-open (Open/Closed always show the prize).
export const setDrawPrizeRevealedService = async (drawId: number, revealed: boolean) => {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE draw SET prize_revealed = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'Upcoming'
     RETURNING id, prize_revealed`,
    [drawId, revealed],
  );
  if (result.rowCount === 0) throw new Error('Only upcoming campaigns have a prize reveal');
  invalidatePublicBusinessData();
  return result.rows[0];
};

export const deleteDrawService = async (drawId: number) => {
  const pool = getPool();
  const existing = await pool.query(
    `SELECT id, status, winner_user_id, winner_ticket_id FROM draw WHERE id = $1`,
    [drawId],
  );
  if (!existing.rows[0]) throw new Error('Campaign not found');
  if (existing.rows[0].status !== 'Upcoming')
    throw new Error('Only upcoming campaigns can be deleted');
  // Belt-and-suspenders for the legal audit trail: a draw that carries any winner record must
  // never be hard-deleted (deletion would CASCADE-wipe its draw_audit_log / draw_rejected_winner
  // history). The Upcoming-only rule above already implies no winner, but assert it explicitly so
  // the trail can never be lost, even if the status invariant is ever weakened.
  if (existing.rows[0].winner_user_id !== null || existing.rows[0].winner_ticket_id !== null)
    throw new Error('Cannot delete a campaign that has a winner on record');
  const rejected = await pool.query(`SELECT 1 FROM draw_rejected_winner WHERE draw_id = $1 LIMIT 1`, [drawId]);
  if (rejected.rows.length > 0)
    throw new Error('Cannot delete a campaign that has a rejected-winner record');
  await pool.query(`DELETE FROM draw WHERE id = $1`, [drawId]);
  invalidatePublicBusinessData();
};

export const createDrawService = async (data: {
  name: string;
  prize_amount: number;
  draw_date: string;
  start_date?: string;
}) => {
  // The draw always lands on the last day of its month (midnight NY). The start is
  // admin-selectable (midnight NY on the picked day); without a pick it defaults to
  // the 1st of the draw month.
  const drawDate = drawDateFromString(data.draw_date);
  const startDate = data.start_date
    ? nyMidnightFromString(data.start_date)
    : drawStartDateFromString(data.draw_date);
  if (startDate.getTime() >= drawDate.getTime())
    throw new Error('Start date must be before the draw date');

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const drawResult = await client.query(`
      INSERT INTO draw (name, prize_pool, start_date, draw_date, status)
      VALUES ($1, $2, $3, $4, 'Upcoming')
      RETURNING *
    `, [data.name, data.prize_amount, startDate, drawDate]);

    const draw = drawResult.rows[0];

    // NOTE: businesses are NOT enrolled at create. Enrollment happens at OPEN
    // (openDrawService), which is the single point a business joins a draw and
    // runs after the month-end charges, so only paid businesses get in. Creating
    // a campaign early or creating several has no effect on who participates.

    await client.query('COMMIT');
    invalidatePublicBusinessData();
    return draw;
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
};

export const getDrawBusinessesService = async (
  drawId: number,
  page = 1,
  limit = 25,
  search = '',
  sector = '',
) => {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const params: (string | number)[] = [drawId];
  const filters: string[] = [];

  if (search) filters.push(`b.name ILIKE $${params.push('%' + search + '%')}`);
  if (sector) filters.push(`b.sector = $${params.push(sector)}`);

  const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

  const [rows, count] = await Promise.all([
    pool.query(`
      SELECT
        b.id, b.name, b.sector, b.logo_url,
        de.fee_at_entry, de.created_at AS joined_at,
        (de.paused_at IS NOT NULL) AS is_paused
      FROM draw_entry de
      JOIN business b ON b.id = de.business_id
      WHERE de.draw_id = $1 ${whereExtra}
      ORDER BY b.name ASC
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
    `, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM draw_entry de JOIN business b ON b.id = de.business_id WHERE de.draw_id = $1 ${whereExtra}`,
      params.slice(0, params.length - 2),
    ),
  ]);

  return { rows: rows.rows, total: count.rows[0].total };
};

// Open a draw inside an EXISTING transaction: flip to Open, enrol the currently-paid
// businesses (the single enrolment point), and log the audit event. The caller must have
// already verified the draw is Upcoming and that no other draw is Open (the close hand-off
// guarantees this by closing the current Open draw first, in the same transaction).
//
// Enrollment happens HERE — the single point a business joins a draw. Open runs from the 1st,
// a full week after the charge on the 24th, so payment had Stripe's whole retry window to
// clear. STRICTLY PAID businesses get in:
//  - status Active/Trialing only. Past_Due/Incomplete are NOT enrolled (no grace): their
//    charge failed and did not recover in the buffer week. The moment a late payment lands,
//    invoice.payment_succeeded recovers them - flips Active and enrolls them into this
//    campaign mid-flight (they paid for it).
//  - current_period_end >= NOW() for EVERYONE: founding members are in every campaign that
//    opens inside their prepaid year (what makes "12 monthly campaigns" true for any
//    purchase day), and for regular subs this closes the timing hole where a subscription
//    cancelled on the 24th still shows a stale Active status because Stripe's deleted
//    webhook has not landed yet - its period ended on the 24th, so it is excluded anyway.
const openDrawInTx = async (client: import('pg').PoolClient, drawId: number, actorUserId: number | null): Promise<void> => {
  // prize_revealed = TRUE on open: a live campaign's prize is public fact. Sticky on
  // purpose - if a reopen later reverts this draw to Upcoming, the already-seen prize
  // must not vanish back behind the teaser.
  await client.query(`UPDATE draw SET status = 'Open', opened_at = NOW(), prize_revealed = TRUE WHERE id = $1`, [drawId]);
  // Apply staged plan changes (founding-to-regular hand-off) at the campaign boundary,
  // BEFORE enrollment snapshots tier/fee. A founding member who started a regular plan
  // during their final prepaid month keeps founding terms through that campaign; the new
  // plan's tier/fee were parked in pending_* and take effect here, as this campaign opens.
  await client.query(`
    UPDATE subscription
    SET entries_per_location         = pending_entries_per_location,
        fee_at_entry                 = COALESCE(pending_fee_at_entry, fee_at_entry),
        pending_entries_per_location = NULL,
        pending_fee_at_entry         = NULL,
        updated_at                   = NOW()
    WHERE pending_entries_per_location IS NOT NULL
  `);
  // Promote staged location changes at the same boundary: locations added during the
  // previous campaign go live now, removed ones stop serving now. The running campaign
  // was never touched — that is the whole point of staging.
  await client.query(`
    UPDATE business_location
    SET is_active = TRUE, activate_at_open = FALSE, updated_at = NOW()
    WHERE activate_at_open = TRUE
  `);
  const detached = await client.query(`
    UPDATE business_location
    SET is_active = FALSE, deactivate_at_open = FALSE, manager_user_id = NULL, updated_at = NOW()
    WHERE deactivate_at_open = TRUE
    RETURNING manager_user_id
  `);
  // Same demotion rule as an immediate location delete (business.service): a detached
  // manager who owns no business and manages no other active location drops back to
  // 'User', and their sessions are revoked so the next sign-in re-syncs the role.
  const managerIds = [...new Set(
    detached.rows.map((r) => r.manager_user_id as number | null).filter((id): id is number => id != null),
  )];
  if (managerIds.length > 0) {
    await client.query(`
      UPDATE "user" u SET role = 'User'
      WHERE u.id = ANY($1::int[])
        AND u.role != 'Admin'
        AND NOT EXISTS (SELECT 1 FROM business WHERE user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM business_location WHERE manager_user_id = u.id AND is_active = TRUE)
    `, [managerIds]);
    await client.query(`DELETE FROM refresh_token WHERE user_id = ANY($1::int[])`, [managerIds]);
    for (const id of managerIds) invalidateUserAuth(id);
  }
  await client.query(`
    INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, cap_at_entry, min_transaction_at_entry)
    SELECT d.id, b.id, COALESCE(s.fee_at_entry, 0), s.entries_per_location, b.min_transaction_amount
    FROM draw d
    -- Eligibility lives in the shared ENROLLMENT_ELIGIBLE_SQL constant so the admin
    -- "next campaign ready" preview uses the IDENTICAL rule and can never drift.
    JOIN subscription s ON ${ENROLLMENT_ELIGIBLE_SQL}
    JOIN business b ON b.id = s.business_id
    WHERE d.id = $1
    ON CONFLICT (draw_id, business_id) DO NOTHING
  `, [drawId]);
  // Refresh the threshold snapshot for PRE-OPEN joiners (the free-trial join button and
  // admin adds insert draw_entry rows weeks before the open). A business can legitimately
  // change its threshold right up to this boundary (changes only become pending once IN an
  // open draw), which would leave the join-time snapshot stale for the entire campaign in
  // per-campaign analytics. "At entry" means "as the campaign went live".
  await client.query(`
    UPDATE draw_entry de
    SET min_transaction_at_entry = b.min_transaction_amount
    FROM business b
    WHERE b.id = de.business_id AND de.draw_id = $1
      AND de.min_transaction_at_entry IS DISTINCT FROM b.min_transaction_amount
  `, [drawId]);
  // Opt-outs are one campaign only: consume the flag so the business is back in next time.
  // EXCEPT for cancelling subscriptions: their skip came from a charged-window cancel and
  // must survive the open so the plan page keeps saying "you skipped the campaign you paid
  // for, no refund" (not "you were never charged"). Enrollment-wise it is moot - their
  // period ends before the following open - and resume clears both flags together.
  await client.query(`
    UPDATE subscription SET skip_next_campaign = FALSE, updated_at = NOW()
    WHERE skip_next_campaign = TRUE AND cancel_at_period_end = FALSE
  `);
  await logDrawAudit(client, drawId, 'opened', actorUserId);
};

// After a campaign opens, tell every founding member for whom THIS is the final campaign
// covered by their prepaid year: their term won't cover the next campaign, so they must
// start a regular plan before this month ends to be in it. Runs AFTER the open commits
// and is non-fatal — a mail failure must never affect draw state.
const notifyFoundingFinalCampaign = async (drawId: number): Promise<void> => {
  try {
    const pool = getPool();
    // This campaign is a founding member's FINAL one when their year ends before the next
    // campaign opens (founders are in every campaign that opens inside their year).
    const nextOpensAt = nextCampaignOpensNy();
    const result = await pool.query(`
      SELECT u.email, b.name, s.current_period_end
      FROM draw_entry de
      JOIN business b ON b.id = de.business_id
      JOIN "user" u ON u.id = b.user_id
      JOIN subscription s ON s.business_id = b.id
      JOIN founding_member fm ON fm.business_id = b.id
      WHERE de.draw_id = $1
        AND s.stripe_subscription_id IS NULL
        AND s.current_period_end < $2
    `, [drawId, nextOpensAt]);

    for (const row of result.rows) {
      try {
        await sendFoundingFinalCampaignEmail(row.email, row.name, {
          termEnd: new Date(row.current_period_end),
          nextCampaignOpensAt: nextOpensAt,
        });
      } catch (err: unknown) {
        console.error(`[Draw] founding final-campaign email to ${row.email} failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err: unknown) {
    console.error('[Draw] founding final-campaign notice query failed (non-fatal):', err instanceof Error ? err.message : err);
  }
};

export const openDrawService = async (drawId: number, actorUserId: number | null): Promise<void> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serialize ALL draw open/close operations so two draws can never be Open at once. A
    // transaction-level advisory lock blocks any concurrent open/close until this one commits,
    // so the "already Open?" check below cannot race under READ COMMITTED.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('winnbell:draw_state_change'))`);

    // Lock the draw row first to prevent concurrent opens
    const check = await client.query(
      `SELECT id, status FROM draw WHERE id = $1 FOR UPDATE`,
      [drawId],
    );
    if (check.rows.length === 0) throw new Error('Draw not found');
    if (check.rows[0].status.toUpperCase() !== 'UPCOMING') throw new Error('Only Upcoming draws can be opened');

    // Existence check for an already-Open draw (plain FOR UPDATE, not SKIP LOCKED — SKIP LOCKED
    // would hide a concurrently-locked Open row, the opposite of what a guard needs).
    const openCheck = await client.query(`SELECT id FROM draw WHERE status = 'Open' FOR UPDATE`);
    if (openCheck.rows.length > 0) throw new Error('A draw is already Open. Close it before opening another.');

    await openDrawInTx(client, drawId, actorUserId);
    await client.query('COMMIT');
    invalidatePublicBusinessData();
    await notifyFoundingFinalCampaign(drawId);
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
};

export const closeDrawService = async (drawId: number, actorUserId: number | null): Promise<void> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Same lock as openDrawService: serialize open/close so an open and a close (which also opens
    // the next Upcoming draw) can never interleave and leave zero or two Open draws.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('winnbell:draw_state_change'))`);

    const check = await client.query(`SELECT id, status FROM draw WHERE id = $1 FOR UPDATE`, [drawId]);

    if (check.rows.length === 0) throw new Error('Draw not found');
    if (check.rows[0].status.toUpperCase() !== 'OPEN') throw new Error('Draw is not Open');

    // Always keep exactly one Open draw. Closing the current one atomically opens the next
    // Upcoming draw (earliest draw_date). If there is no Upcoming draw to take over, the close
    // is blocked entirely so the platform is never left with zero Open draws — this is the
    // safeguard against an accidental close. It is all one transaction, so any failure here
    // rolls the close back and the current draw stays Open.
    const nextUpcoming = await client.query(
      `SELECT id FROM draw WHERE status = 'Upcoming' ORDER BY draw_date ASC LIMIT 1 FOR UPDATE`,
    );
    if (nextUpcoming.rows.length === 0) throw new Error('NO_UPCOMING_DRAW');
    const nextDrawId = nextUpcoming.rows[0].id as number;

    await client.query(`UPDATE draw SET status = 'Closed', closed_at = NOW() WHERE id = $1`, [drawId]);
    await logDrawAudit(client, drawId, 'closed', actorUserId);

    // NOTE: the old draw-time "drop unpaid businesses" deletion is gone. Enrollment at
    // open is strictly paid-only now (no Past_Due grace), so draw_entry only ever holds
    // businesses that paid for the campaign — including those whose subscription ended
    // or failed LATER in the month (e.g. a failed charge on the 24th for the NEXT
    // campaign must not eject them from the one they already paid for).

    // Apply any pending threshold changes that businesses set during the active campaign
    await client.query(`
      UPDATE business
      SET min_transaction_amount         = pending_min_transaction_amount,
          pending_min_transaction_amount = NULL
      WHERE pending_min_transaction_amount IS NOT NULL
    `);

    // Hand off: open the next Upcoming draw in the SAME transaction so there is never a gap.
    await openDrawInTx(client, nextDrawId, actorUserId);

    await client.query('COMMIT');
    invalidatePublicBusinessData();
    await notifyFoundingFinalCampaign(nextDrawId);
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
  // Legal archive: snapshot the Official Rules that governed the just-closed campaign
  // (name, dates, prize, jurisdictions in force) as a PDF in R2. Deliberately OUTSIDE the
  // try/catch and after the release: it runs only when the close committed, it never
  // throws (full internal catch + CRITICAL log), and even a latent bug in it could not
  // trigger safeRollback on a committed transaction or turn a successful close into a 500.
  await snapshotOfficialRulesForDraw(drawId);
};

export const reopenDrawService = async (drawId: number, actorUserId: number | null): Promise<void> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize with open/close: without this lock a concurrent openDrawService can slip in after
    // the swap's revert step and leave TWO Open draws.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('winnbell:draw_state_change'))`);

    const check = await client.query(
      `SELECT id, status, winner_confirmed FROM draw WHERE id = $1 FOR UPDATE`,
      [drawId],
    );
    if (check.rows.length === 0) throw new Error('Draw not found');
    if (check.rows[0].status.toUpperCase() !== 'CLOSED') throw new Error('Draw is not Closed');
    if (check.rows[0].winner_confirmed === true) throw new Error('Cannot reopen a draw whose winner has been confirmed');

    // Closing a draw auto-opens the next Upcoming one, so there is normally exactly one Open
    // draw when an admin reopens. To preserve the "always one Open" invariant, reopening does an
    // atomic SWAP: revert that auto-opened draw back to Upcoming (un-enrol it) and reopen this one.
    // The swap is only safe while the auto-opened draw has NO activity yet (no tickets) — i.e. the
    // close is being undone before anything happened on the new draw. If it already has any tickets,
    // we block, because reverting it would strand real entries.
    const openRows = await client.query(`SELECT id FROM draw WHERE status = 'Open' FOR UPDATE`);
    for (const row of openRows.rows) {
      if (row.id === drawId) continue; // defensive: this draw is Closed, so it won't be here
      const activity = await client.query(`SELECT 1 FROM ticket WHERE draw_id = $1 LIMIT 1`, [row.id]);
      if (activity.rows.length > 0) throw new Error('NEXT_DRAW_HAS_ACTIVITY');
      // Revert the auto-opened draw to its exact pre-open state: Upcoming, no enrolment, no opened_at.
      await client.query(`DELETE FROM draw_entry WHERE draw_id = $1`, [row.id]);
      await client.query(`UPDATE draw SET status = 'Upcoming', opened_at = NULL WHERE id = $1`, [row.id]);
      await logDrawAudit(client, row.id, 'reverted_to_upcoming', actorUserId, { reason: 'reopen_swap', reopened_draw_id: drawId });
    }

    // A reopened draw accepts new entries again, which invalidates the frozen selection
    // order snapshotted at the first pick. Wipe it so the next close+pick generates a fresh
    // permutation, and audit-log the wipe so the trail shows the order was cleared here,
    // never silently reshuffled.
    const clearedOrder = await client.query(`DELETE FROM draw_winner_order WHERE draw_id = $1`, [drawId]);
    if ((clearedOrder.rowCount ?? 0) > 0) {
      await logDrawAudit(client, drawId, 'winner_order_cleared', actorUserId, { entry_count: clearedOrder.rowCount });
    }

    await client.query(
      `UPDATE draw
       SET status = 'Open',
           opened_at = COALESCE(opened_at, NOW()),
           prize_revealed = TRUE,
           closed_at = NULL,
           winner_user_id = NULL,
           winner_ticket_id = NULL
       WHERE id = $1`,
      [drawId],
    );
    await logDrawAudit(client, drawId, 'reopened', actorUserId);

    await client.query('COMMIT');
    invalidatePublicBusinessData();
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
};

export const pickDrawWinnerService = async (drawId: number, applyPenalty: boolean, reason: string | undefined, actorUserId: number | null): Promise<PickedWinner | PickExhausted> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(
      `SELECT id, status, prize_pool, winner_user_id, winner_ticket_id, winner_confirmed
       FROM draw WHERE id = $1 FOR UPDATE`,
      [drawId],
    );

    if (check.rows.length === 0) throw new Error('Draw not found');
    if (check.rows[0].status.toUpperCase() !== 'CLOSED') throw new Error('Draw is not Closed');
    if (check.rows[0].winner_confirmed === true) throw new Error('Winner has already been confirmed for this draw');

    const prizePool: number = check.rows[0].prize_pool;

    // If there is an unconfirmed candidate, reject it and clear it before picking again.
    // Rejections live ONLY in draw_rejected_winner (normalized, FK-safe, append-only) - the
    // pick query below excludes them via NOT EXISTS, so no array bookkeeping on the draw row.
    const prevTicketId: number | null = check.rows[0].winner_ticket_id;
    const prevUserId: number | null = check.rows[0].winner_user_id;
    if (prevTicketId !== null) {
      // Disqualifying the current candidate requires a documented reason (legal/regulatory trail).
      const disqualifyReason = (reason ?? '').trim();
      if (!disqualifyReason) {
        throw new Error('A reason is required to disqualify the current winner.');
      }
      await client.query(
        `UPDATE draw SET winner_user_id = NULL, winner_ticket_id = NULL WHERE id = $1`,
        [drawId],
      );
      const penalty = applyPenalty && prevUserId !== null ? 12 : 0;
      // Always quarantine the rejected ticket - the entry is invalid regardless of penalty
      await client.query(
        `UPDATE ticket SET is_quarantined = TRUE, quarantine_reason = 'admin_rejected_winner', quarantined_at = NOW() WHERE id = $1`,
        [prevTicketId],
      );
      if (penalty > 0) {
        await client.query(`UPDATE "user" SET risk_score = risk_score + $2 WHERE id = $1`, [prevUserId, penalty]);
      }
      // Log rejection (always) with the admin's documented reason — append-only record. This row
      // is also what excludes the ticket from every future pick of this draw.
      await client.query(
        `INSERT INTO draw_rejected_winner (draw_id, ticket_id, user_id, rejected_by_user_id, risk_penalty, reason) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [drawId, prevTicketId, prevUserId, actorUserId, penalty, disqualifyReason],
      );
      await logDrawAudit(client, drawId, 'winner_rejected', actorUserId, { ticket_id: prevTicketId, user_id: prevUserId, penalty, reason: disqualifyReason });
    }

    // The selection order is FROZEN per closed draw: the first pick snapshots every ticket
    // eligible at that moment into draw_winner_order as one random permutation, and every
    // pick (including this one) takes the topmost entry of that list that is still eligible
    // and not rejected. The list is never reshuffled, so rejecting a candidate can only
    // advance to the next pre-drawn entry, never re-roll the draw. Generating the permutation
    // is a full sort of the eligible set; at a very large draw this can exceed the pool's
    // default 10s statement_timeout, so raise it for THIS transaction only (SET LOCAL reverts
    // at COMMIT/ROLLBACK). This is a once-a-month admin operation and does not block normal
    // user traffic, so a slower run is acceptable.
    await client.query(`SET LOCAL statement_timeout = '60s'`);

    // The draw row is locked FOR UPDATE above, so concurrent picks cannot both generate.
    // Generation ranks EVERY eligible ticket with one uniform shuffle, but stores only the
    // reachable prefix: positions up to the first auto-valid entry (validation can never
    // walk past it), capped at WINNER_ORDER_BATCH. The audit row records both the stored
    // count and the size of the full pool the ranking was drawn from.
    const orderExists = await client.query(
      `SELECT 1 FROM draw_winner_order WHERE draw_id = $1 LIMIT 1`,
      [drawId],
    );
    if (orderExists.rows.length === 0) {
      // ONE statement performs the shuffle, stores the prefix, and reports both counts, so
      // the audited eligible_count is derived from the exact snapshot that was shuffled -
      // it can never disagree with the stored ranking (a separate COUNT could drift if a
      // background quarantine landed between the two statements).
      const generated = await client.query(`
        -- MATERIALIZED: ranked is referenced multiple times (cutoff + insert + count) and
        -- MUST be evaluated exactly once - a re-evaluation would produce a second, different
        -- shuffle and apply one permutation's cutoff to another. PostgreSQL already
        -- guarantees this for a multi-referenced CTE containing a volatile function, but the
        -- fairness of the draw must not hinge on an optimizer rule, so it is stated explicitly.
        WITH ranked AS MATERIALIZED (
          SELECT t.id AS ticket_id, t.entry_source,
                 row_number() OVER (ORDER BY random()) AS position
          FROM ticket t
          JOIN "user" u ON t.activated_by_user_id = u.id AND u.risk_score < 20 AND u.is_active = TRUE
          WHERE t.draw_id = $1
            AND t.status = 'Activated'
            AND t.is_quarantined = FALSE
            AND NOT EXISTS (
              SELECT 1 FROM draw_rejected_winner drw
              WHERE drw.draw_id = t.draw_id AND drw.ticket_id = t.id
            )
        ),
        cutoff AS (
          SELECT LEAST(
            GREATEST(COALESCE((SELECT MIN(position) FROM ranked WHERE entry_source::text = ANY($2)), $3), $4),
            $3
          ) AS cut
        ),
        ins AS (
          INSERT INTO draw_winner_order (draw_id, ticket_id, position)
          SELECT $1, ticket_id, position FROM ranked WHERE position <= (SELECT cut FROM cutoff)
          RETURNING 1
        )
        SELECT
          (SELECT COUNT(*)::int FROM ranked) AS eligible,
          (SELECT COUNT(*)::int FROM ins) AS stored
      `, [drawId, AUTO_VALID_SOURCES, WINNER_ORDER_BATCH, WINNER_ORDER_MIN]);
      await logDrawAudit(client, drawId, 'winner_order_generated', actorUserId, {
        entry_count: generated.rows[0].stored,
        eligible_count: generated.rows[0].eligible,
        method: 'uniform_random_full_shuffle_bounded_prefix',
      });
    }

    const ticketResult = await client.query(WINNER_PICK_SQL, [drawId]);

    if (ticketResult.rows.length === 0) {
      // The stored list is exhausted: every drawn position is rejected or no longer eligible.
      // COMMIT here so the rejection above (if any) is durably recorded - the admin's
      // documented reason must never be lost to a rollback. The draw is left with NO
      // candidate; drawing the next batch is a separate, explicitly admin-approved action
      // (extendDrawWinnerOrderService), never automatic.
      const totalRes = await client.query(
        `SELECT COUNT(*)::int AS total FROM draw_winner_order WHERE draw_id = $1`,
        [drawId],
      );
      await client.query('COMMIT');
      invalidatePublicBusinessData();
      if (applyPenalty && prevTicketId !== null && prevUserId !== null) {
        try {
          const { syncUserQuarantineState } = await import('../risk/risk.service.js');
          await syncUserQuarantineState(prevUserId, drawId);
        } catch (err) {
          console.error('[pickDrawWinnerService] syncUserQuarantineState failed:', err);
        }
      }
      return { exhausted: true, queueTotal: totalRes.rows[0].total };
    }

    const winner = ticketResult.rows[0];
    const winnerId: number = winner.activated_by_user_id;
    const winnerTicketId: number = winner.ticket_id;

    await client.query(
      `UPDATE draw SET winner_user_id = $1, winner_ticket_id = $2 WHERE id = $3`,
      [winnerId, winnerTicketId, drawId],
    );
    await logDrawAudit(client, drawId, 'winner_picked', actorUserId, { ticket_id: winnerTicketId, user_id: winnerId });

    await client.query('COMMIT');
    invalidatePublicBusinessData();

    // Sync quarantine state for rejected user (outside transaction, only if penalty applied)
    if (applyPenalty && prevTicketId !== null && prevUserId !== null) {
      try {
        const { syncUserQuarantineState } = await import('../risk/risk.service.js');
        await syncUserQuarantineState(prevUserId, drawId);
      } catch (err) {
        console.error('[pickDrawWinnerService] syncUserQuarantineState failed:', err);
      }
    }

    return mapPickedWinnerRow(winner, prizePool);
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
};

// Admin-approved continuation of the drawing. Only callable once the stored list is truly
// exhausted (every drawn position rejected or no longer eligible): appends the NEXT randomly
// drawn batch after the current max position - same uniform shuffle and cutoff rules as
// generation, existing rows never touched - and promotes the top of the new batch to
// candidate. This is never triggered automatically; the button click IS the admin approval,
// and both the extension (with pool size) and the pick are audit-logged.
export const extendDrawWinnerOrderService = async (drawId: number, actorUserId: number | null): Promise<PickedWinner> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(
      `SELECT id, status, prize_pool, winner_ticket_id, winner_confirmed
       FROM draw WHERE id = $1 FOR UPDATE`,
      [drawId],
    );
    if (check.rows.length === 0) throw new Error('Draw not found');
    if (check.rows[0].status.toUpperCase() !== 'CLOSED') throw new Error('Draw is not Closed');
    if (check.rows[0].winner_confirmed === true) throw new Error('Winner has already been confirmed for this draw');
    const prizePool: number = check.rows[0].prize_pool;

    await client.query(`SET LOCAL statement_timeout = '60s'`);

    const orderExists = await client.query(
      `SELECT 1 FROM draw_winner_order WHERE draw_id = $1 LIMIT 1`,
      [drawId],
    );
    if (orderExists.rows.length === 0) throw new Error('No list has been drawn for this draw yet. Use Pick Winner first.');

    // Guard: the current list must be truly exhausted. If any stored position is still
    // eligible (including the current candidate), extending would let an admin grow the pool
    // of alternates while a decision is pending - refuse.
    const stillEligible = await client.query(WINNER_PICK_SQL, [drawId]);
    if (stillEligible.rows.length > 0) throw new Error('The current list still has an eligible entry to review.');

    // ONE statement draws the batch, appends it, and reports both counts from the exact
    // snapshot that was shuffled (mirrors generation - the audited remaining-pool size can
    // never disagree with the drawn batch).
    const extended = await client.query(`
      -- MATERIALIZED: same single-evaluation guarantee as generation (cutoff + insert +
      -- count must see the SAME shuffle); stated explicitly rather than relying on the
      -- optimizer rule.
      WITH ranked AS MATERIALIZED (
        SELECT t.id AS ticket_id, t.entry_source,
               row_number() OVER (ORDER BY random()) AS rn
        FROM ticket t
        JOIN "user" u ON t.activated_by_user_id = u.id AND u.risk_score < 20 AND u.is_active = TRUE
        WHERE t.draw_id = $1
          AND t.status = 'Activated'
          AND t.is_quarantined = FALSE
          AND NOT EXISTS (
            SELECT 1 FROM draw_rejected_winner drw
            WHERE drw.draw_id = t.draw_id AND drw.ticket_id = t.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM draw_winner_order dwo
            WHERE dwo.draw_id = $1 AND dwo.ticket_id = t.id
          )
      ),
      cutoff AS (
        SELECT LEAST(
          GREATEST(COALESCE((SELECT MIN(rn) FROM ranked WHERE entry_source::text = ANY($2)), $3), $4),
          $3
        ) AS cut
      ),
      offset_base AS (
        SELECT COALESCE(MAX(position), 0) AS base FROM draw_winner_order WHERE draw_id = $1
      ),
      ins AS (
        INSERT INTO draw_winner_order (draw_id, ticket_id, position)
        SELECT $1, ticket_id, (SELECT base FROM offset_base) + rn
        FROM ranked WHERE rn <= (SELECT cut FROM cutoff)
        RETURNING 1
      )
      SELECT
        (SELECT COUNT(*)::int FROM ranked) AS eligible,
        (SELECT COUNT(*)::int FROM ins) AS stored
    `, [drawId, AUTO_VALID_SOURCES, WINNER_ORDER_BATCH, WINNER_ORDER_MIN]);
    if (extended.rows[0].stored === 0) throw new Error('No eligible entries remain in this draw');
    await logDrawAudit(client, drawId, 'winner_order_extended', actorUserId, {
      entry_count: extended.rows[0].stored,
      eligible_count: extended.rows[0].eligible,
      method: 'uniform_random_continuation_remaining_entries',
    });

    const ticketResult = await client.query(WINNER_PICK_SQL, [drawId]);
    if (ticketResult.rows.length === 0) throw new Error('No eligible entries remain in this draw');

    const winner = ticketResult.rows[0];
    await client.query(
      `UPDATE draw SET winner_user_id = $1, winner_ticket_id = $2 WHERE id = $3`,
      [winner.activated_by_user_id, winner.ticket_id, drawId],
    );
    await logDrawAudit(client, drawId, 'winner_picked', actorUserId, { ticket_id: winner.ticket_id, user_id: winner.activated_by_user_id });

    await client.query('COMMIT');
    invalidatePublicBusinessData();

    return mapPickedWinnerRow(winner, prizePool);
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
};

export const confirmWinnerService = async (drawId: number, actorUserId: number | null): Promise<{
  winnerId: number;
  winnerName: string;
  winnerEmail: string;
  ticketCode: string;
  businessName: string | null;
  locationName: string | null;
  prizePool: number;
  receiptIdentifier: string | null;
  transactionAmount: number | null;
  transactionDate: string | null;
  receiptImageUrl: string | null;
  entrySource: string | null;
  imageValidationStatus: string | null;
  riskScore: number;
}> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(
      `SELECT id, status, prize_pool, winner_user_id, winner_ticket_id, winner_confirmed
       FROM draw WHERE id = $1 FOR UPDATE`,
      [drawId],
    );

    if (check.rows.length === 0) throw new Error('Draw not found');
    if (check.rows[0].status.toUpperCase() !== 'CLOSED') throw new Error('Draw is not Closed');
    if (check.rows[0].winner_user_id === null || check.rows[0].winner_ticket_id === null) {
      throw new Error('No candidate winner has been picked yet');
    }
    if (check.rows[0].winner_confirmed === true) throw new Error('Winner has already been confirmed');

    const prizePool: number = check.rows[0].prize_pool;
    const winnerTicketId: number = check.rows[0].winner_ticket_id;
    const winnerId: number = check.rows[0].winner_user_id;

    const winnerRes = await client.query(`
      SELECT
        t.code,
        t.receipt_identifier,
        t.transaction_amount,
        t.transaction_date,
        t.receipt_image_url,
        t.entry_source,
        t.image_validation_status,
        u.full_name,
        u.email,
        u.risk_score,
        u.is_active,
        t.is_quarantined,
        b.name AS business_name,
        bl.name AS location_name
      FROM ticket t
      JOIN "user" u ON u.id = t.activated_by_user_id
      LEFT JOIN business b ON b.id = t.business_id
      LEFT JOIN business_location bl ON bl.id = t.location_id
      WHERE t.id = $1
    `, [winnerTicketId]);

    if (winnerRes.rows.length === 0) throw new Error('Winner ticket not found');

    const winner = winnerRes.rows[0];

    // Re-verify eligibility at CONFIRM time: between pick and confirm the candidate can be
    // deactivated, quarantined, or risk-bumped (independent admin actions). Confirming an
    // ineligible candidate must be impossible - reject and let the admin pick again.
    if (winner.is_active !== true || winner.is_quarantined === true || Number(winner.risk_score) >= 20) {
      throw new Error('WINNER_NO_LONGER_ELIGIBLE');
    }

    await client.query(
      `UPDATE draw SET winner_confirmed = TRUE WHERE id = $1`,
      [drawId],
    );
    await logDrawAudit(client, drawId, 'winner_confirmed', actorUserId, { ticket_id: winnerTicketId, user_id: winnerId });

    await client.query('COMMIT');
    invalidatePublicBusinessData();

    // Run decay outside transaction so failure does not roll back confirmation
    try {
      const { unquarantinedUserIds } = await decayAllUserRiskScores();
      if (unquarantinedUserIds.length > 0) {
        // The just-confirmed draw is over, so its quarantine state is irrelevant. Re-validate
        // these now-lower-risk users' entries ONLY in the current open draw (freshly opened, so
        // very few tickets), in ONE bulk query instead of one call per user (pool-safe at scale).
        // If no draw is open, the subquery is NULL and zero rows match (safe no-op).
        await getPool().query(
          `UPDATE ticket SET is_quarantined = FALSE, quarantine_reason = NULL, quarantined_at = NULL
           WHERE draw_id = ${OPEN_DRAW_ID_SUBQUERY}
             AND activated_by_user_id = ANY($1::int[])
             AND is_quarantined = TRUE
             AND quarantine_reason = 'high_risk_user'`,
          [unquarantinedUserIds],
        );
      }
    } catch (err) {
      console.error('[confirmWinnerService] decayAllUserRiskScores failed (winner confirmation succeeded):', err);
    }

    return {
      winnerId,
      winnerName: winner.full_name,
      winnerEmail: winner.email,
      ticketCode: winner.code,
      businessName: winner.business_name,
      locationName: winner.location_name,
      prizePool,
      receiptIdentifier: winner.receipt_identifier ?? null,
      transactionAmount: winner.transaction_amount ? parseFloat(winner.transaction_amount) : null,
      transactionDate: winner.transaction_date ?? null,
      receiptImageUrl: winner.receipt_image_url ?? null,
      entrySource: winner.entry_source ?? null,
      imageValidationStatus: winner.image_validation_status ?? null,
      riskScore: winner.risk_score ?? 0,
    };
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
};

export const getAdminOverviewService = async () => {
  const pool = getPool();

  const [usersRes, bizRes, subRes, drawRes, ticketRes, flaggedRes] = await Promise.all([
    // total_users = CONSUMERS ONLY (role 'User') - the headline metric, consistent with the
    // Growth dashboard and investor metrics. Business/manager accounts are staff/owner
    // plumbing and are broken out separately so the caption always adds up.
    // MANAGER MODELING: location managers are role='Business' accounts that own NO business
    // row (linked via business_location.manager_user_id; the 'Manager' enum value is unused
    // by the app). Owner vs manager therefore splits on business ownership, which keeps
    // business_users + manager_users exactly equal to the Business-role total.
    pool.query(`
      SELECT
        SUM(CASE WHEN u.role='User' THEN 1 ELSE 0 END) AS total_users,
        SUM(CASE WHEN u.role='User' THEN 1 ELSE 0 END) AS regular_users,
        SUM(CASE WHEN u.role='Business' AND EXISTS (SELECT 1 FROM business b WHERE b.user_id = u.id) THEN 1 ELSE 0 END) AS business_users,
        SUM(CASE WHEN u.role='Manager' OR (u.role='Business' AND NOT EXISTS (SELECT 1 FROM business b WHERE b.user_id = u.id)) THEN 1 ELSE 0 END) AS manager_users
      FROM "user" u WHERE u.role != 'Admin'`),
    pool.query(`SELECT COUNT(DISTINCT b.id) AS total, COUNT(DISTINCT s.business_id) AS active FROM business b LEFT JOIN subscription s ON s.business_id = b.id AND s.status IN ('Active', 'Trialing')`),
    pool.query(`SELECT COUNT(*) AS active_subs, COALESCE(SUM(fee_at_entry), 0) AS total_fees FROM subscription WHERE status = 'Active'`),
    pool.query(`SELECT id, name, prize_pool, draw_date FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1`),
    pool.query(`SELECT COUNT(*) AS total_tickets, SUM(CASE WHEN is_quarantined = FALSE AND activated_by_user_id IS NOT NULL THEN 1 ELSE 0 END) AS activated FROM ticket WHERE draw_id=(SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1)`),
    pool.query(`SELECT COUNT(*) AS flagged_users FROM "user" WHERE risk_score >= 20 AND role != 'Admin'`),
  ]);

  return {
    users: usersRes.rows[0],
    businesses: bizRes.rows[0],
    subscriptions: subRes.rows[0],
    currentDraw: drawRes.rows[0] ?? null,
    currentDrawTickets: ticketRes.rows[0],
    attention: {
      flagged_users: Number(flaggedRes.rows[0]?.flagged_users ?? 0),
    },
  };
};

// ---------------------------------------------------------------------------
// USER_SEGMENT_PREDICATES
// ---------------------------------------------------------------------------
// Single source of truth for every user-triage segment threshold.
// Both getUserAnalyticsSummaryService (COUNT...FILTER) and getAllUsersService
// (WHERE AND clause) embed these strings verbatim so the thresholds are
// never duplicated.
//
// All segments implicitly apply only to non-Admin users; the outer query
// always carries `u.role != 'Admin'` as a baseline condition.
//
// Segment definitions:
//   high_risk    - risk_score >= 20 (same threshold as riskLevel='high' filter)
//   medium_risk  - risk_score in [10,19] (same as riskLevel='medium')
//   suspended    - account deactivated by admin
//   unverified   - User-role only; phone not yet verified.
//                  Business/Manager accounts are exempt from the phone-verify
//                  requirement and must NOT be flagged here.
//   new_7d       - registered within the last 7 days
//   active_30d   - has at least one valid (non-quarantined, cap-rule) entry
//                  with activated_at in the last 30 days
//
// NOTE: high_risk and medium_risk have no index on risk_score today.
// A btree index on "user"(risk_score) would speed up the ORDER BY risk_score DESC
// sort used in the segment list view. Deferred post-launch (tracked).
// ---------------------------------------------------------------------------
export type UserSegment = 'high_risk' | 'medium_risk' | 'suspended' | 'unverified' | 'new_7d' | 'active_30d';
const VALID_USER_SEGMENTS = new Set<UserSegment>([
  'high_risk', 'medium_risk', 'suspended', 'unverified', 'new_7d', 'active_30d',
]);

const USER_SEGMENT_PREDICATES: Record<UserSegment, string> = {
  high_risk:   `u.risk_score >= 20`,
  medium_risk: `u.risk_score >= 10 AND u.risk_score < 20`,
  suspended:   `u.is_active = FALSE`,
  unverified:  `u.role = 'User' AND u.is_phone_verified = FALSE`,
  new_7d:      `u.created_at >= NOW() - INTERVAL '7 days'`,
  active_30d:  `EXISTS (
    SELECT 1 FROM ticket t
    WHERE t.activated_by_user_id = u.id
      AND t.is_quarantined = FALSE
      AND t.activated_by_user_id IS NOT NULL
      AND t.activated_at >= NOW() - INTERVAL '30 days'
  )`,
};

export const getUserAnalyticsSummaryService = async (): Promise<{
  total: number;
  users: number;
  businesses: number;
  managers: number;
  high_risk: number;
  medium_risk: number;
  suspended: number;
  unverified: number;
  new_7d: number;
  active_30d: number;
}> => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      COUNT(*)::int                                                                AS total,
      COUNT(*) FILTER (WHERE u.role = 'User')::int                               AS users,
      -- Owner vs manager splits on business OWNERSHIP: managers are Business-role accounts
      -- with no business row (the 'Manager' enum value is unused by the app).
      COUNT(*) FILTER (WHERE u.role = 'Business' AND EXISTS (SELECT 1 FROM business b WHERE b.user_id = u.id))::int AS businesses,
      COUNT(*) FILTER (WHERE u.role = 'Manager' OR (u.role = 'Business' AND NOT EXISTS (SELECT 1 FROM business b WHERE b.user_id = u.id)))::int AS managers,
      COUNT(*) FILTER (WHERE ${USER_SEGMENT_PREDICATES.high_risk})::int          AS high_risk,
      COUNT(*) FILTER (WHERE ${USER_SEGMENT_PREDICATES.medium_risk})::int        AS medium_risk,
      COUNT(*) FILTER (WHERE ${USER_SEGMENT_PREDICATES.suspended})::int          AS suspended,
      COUNT(*) FILTER (WHERE ${USER_SEGMENT_PREDICATES.unverified})::int         AS unverified,
      COUNT(*) FILTER (WHERE ${USER_SEGMENT_PREDICATES.new_7d})::int             AS new_7d,
      COUNT(*) FILTER (WHERE ${USER_SEGMENT_PREDICATES.active_30d})::int         AS active_30d
    FROM "user" u
    WHERE u.role != 'Admin'
  `);
  const row = result.rows[0];
  return {
    total:       Number(row?.total       ?? 0),
    users:       Number(row?.users       ?? 0),
    businesses:  Number(row?.businesses  ?? 0),
    managers:    Number(row?.managers    ?? 0),
    high_risk:   Number(row?.high_risk   ?? 0),
    medium_risk: Number(row?.medium_risk ?? 0),
    suspended:   Number(row?.suspended   ?? 0),
    unverified:  Number(row?.unverified  ?? 0),
    new_7d:      Number(row?.new_7d      ?? 0),
    active_30d:  Number(row?.active_30d  ?? 0),
  };
};

export const getAllUsersService = async (params: {
  page: number;
  limit: number;
  search?: string;
  role?: string;
  riskLevel?: 'high' | 'medium' | 'low';
  segment?: string;
}) => {
  const pool = getPool();
  const { page, limit, search, role, riskLevel } = params;
  const offset = (page - 1) * limit;

  // Whitelist the segment value — invalid strings are silently ignored (treated as absent)
  // so a client sending an unknown value never triggers a 400; it just gets unfiltered results.
  const segment: UserSegment | undefined = VALID_USER_SEGMENTS.has(params.segment as UserSegment)
    ? (params.segment as UserSegment)
    : undefined;

  const conditions: string[] = [`u.role != 'Admin'`];
  const values: unknown[] = [];
  let idx = 1;

  if (search) {
    conditions.push(`(u.full_name ILIKE $${idx} OR u.email ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }
  if (role) {
    const normalizedRole = role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
    // Owner vs manager splits on business OWNERSHIP (the 'Manager' enum value is unused by
    // the app - managers are Business-role accounts with no business row). Self-contained
    // EXISTS subqueries: this WHERE is shared with the COUNT query, which has no LATERAL b.
    if (normalizedRole === 'Manager') {
      conditions.push(`(u.role = 'Manager' OR (u.role = 'Business' AND NOT EXISTS (SELECT 1 FROM business b2 WHERE b2.user_id = u.id)))`);
    } else if (normalizedRole === 'Business') {
      conditions.push(`(u.role = 'Business' AND EXISTS (SELECT 1 FROM business b2 WHERE b2.user_id = u.id))`);
    } else {
      conditions.push(`u.role = $${idx}`);
      values.push(normalizedRole);
      idx++;
    }
  }
  if (riskLevel === 'high') {
    conditions.push(`u.risk_score >= 20`);
  } else if (riskLevel === 'medium') {
    conditions.push(`u.risk_score >= 10 AND u.risk_score < 20`);
  } else if (riskLevel === 'low') {
    conditions.push(`u.risk_score < 10`);
  }

  // When a segment is active, AND the matching predicate into the conditions list.
  // riskLevel and segment can both be present — they simply AND together (no conflict).
  if (segment) {
    conditions.push(USER_SEGMENT_PREDICATES[segment]);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  // Default order: risk_score DESC, created_at DESC (preserves pre-existing behaviour).
  // For risk segments, keep worst-first (ORDER BY risk_score DESC, created_at DESC).
  // For all other segments, order by created_at DESC to surface the most relevant rows.
  const orderBy = (segment === 'high_risk' || segment === 'medium_risk')
    ? `ORDER BY u.risk_score DESC, u.created_at DESC`
    : `ORDER BY u.created_at DESC`;

  const [rowsRes, countRes] = await Promise.all([
    pool.query(
      `SELECT u.id, u.full_name, u.email, u.role, u.is_active, u.is_email_verified, u.created_at,
          u.risk_score, u.risk_last_flagged_at,
          b.id AS business_id, b.name AS business_name, (s2.status IN ('Active', 'Trialing')) AS business_active,
          (SELECT COUNT(*) FROM ticket t WHERE t.activated_by_user_id = u.id AND t.is_quarantined = FALSE
           AND t.draw_id = ${OPEN_DRAW_ID_SUBQUERY}
          ) AS entry_count,
          (SELECT MAX(t2.activated_at) FROM ticket t2 WHERE t2.activated_by_user_id = u.id) AS last_active_at
       FROM "user" u
       LEFT JOIN LATERAL (SELECT id, name FROM business WHERE user_id = u.id ORDER BY id LIMIT 1) b ON true
       LEFT JOIN subscription s2 ON s2.business_id = b.id
       ${where}
       ${orderBy}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(*) FROM "user" u ${where}`,
      values,
    ),
  ]);

  const total = parseInt(countRes.rows[0].count, 10);
  return {
    rows: rowsRes.rows,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

export const adminSetUserRiskService = async (userId: number, riskScore: number): Promise<void> => {
  const pool = getPool();
  // Clamp to valid range, never touch Admins
  const clamped = Math.max(0, Math.min(99, riskScore));
  await pool.query(
    `UPDATE "user" SET risk_score = $1, risk_last_flagged_at = CASE WHEN $1 > 0 THEN NOW() ELSE risk_last_flagged_at END
     WHERE id = $2 AND role != 'Admin'`,
    [clamped, userId],
  );
  // Sync quarantine for all draws that haven't been confirmed yet (Open and Closed without a confirmed winner)
  const drawResult = await pool.query(
    `SELECT id FROM draw WHERE status IN ('Open', 'Closed') AND winner_confirmed IS NOT TRUE`,
  );
  if (drawResult.rows.length > 0) {
    const { syncUserQuarantineState } = await import('../risk/risk.service.js');
    await Promise.all(drawResult.rows.map(row => syncUserQuarantineState(userId, row.id)));
  }
};

export const updateUserRoleService = async (userId: number, role: string) => {
  const allowed = ['User', 'Business'];
  if (!allowed.includes(role)) throw new Error('Invalid role');
  const pool = getPool();
  // Epoch bump + cache flush = the change bites on the target's NEXT request, not after
  // the 60s guard cache / 1h token expiry. They re-login and get a token with the new role.
  await pool.query(
    `UPDATE "user" SET role=$1, token_epoch = token_epoch + 1 WHERE id=$2 AND role!='Admin'`,
    [role, userId],
  );
  invalidateUserAuth(userId);
};

export const toggleUserActiveService = async (userId: number, isActive: boolean) => {
  const pool = getPool();
  // Deactivation must kill live sessions instantly (epoch check runs on every request).
  // Reactivation bumps too - harmless, the user just signs in again.
  await pool.query(
    `UPDATE "user" SET is_active=$1, token_epoch = token_epoch + 1 WHERE id=$2 AND role!='Admin'`,
    [isActive, userId],
  );
  invalidateUserAuth(userId);
};

export const getPlatformSettingsService = async (): Promise<{
  global_entry_cap: number | null;
  allowed_states: string[];
  founding_member_cap: number;
  founding_phase_active: boolean;
}> => {
  const settings = await getPlatformSettings();
  return {
    global_entry_cap: (settings.global_entry_cap as number | undefined) ?? null,
    // Empty array = no region restriction (matches evaluateRegionRestriction semantics)
    allowed_states: settings.allowed_states ?? [],
    founding_member_cap: settings.founding_member_cap ?? 30,
    founding_phase_active: settings.founding_phase_active ?? true,
  };
};

export const getFoundingMembersTakenCount = async (): Promise<number> => {
  const pool = getPool();
  const result = await pool.query(`SELECT COUNT(*)::int AS taken FROM founding_member`);
  return result.rows[0]?.taken ?? 0;
};

export const updatePlatformSettingsService = async (
  global_entry_cap: number | null,
  allowed_states?: string[],
  founding_member_cap?: number,
  founding_phase_active?: boolean,
): Promise<void> => {
  const pool = getPool();
  // Use COALESCE($n, col) so omitted fields keep their current value.
  // allowed_states: undefined = keep current; [] = explicitly clear (no restriction).
  // Note: founding_phase_active=false works correctly because false ?? null = false (not null).
  await pool.query(
    `INSERT INTO platform_settings (id, global_entry_cap, allowed_states, founding_member_cap, founding_phase_active, updated_at)
     VALUES (1, $1, $2, COALESCE($3, 30), COALESCE($4, TRUE), NOW())
     ON CONFLICT (id) DO UPDATE
       SET global_entry_cap      = $1,
           allowed_states        = COALESCE($2, platform_settings.allowed_states),
           founding_member_cap   = COALESCE($3, platform_settings.founding_member_cap),
           founding_phase_active = COALESCE($4, platform_settings.founding_phase_active),
           updated_at            = NOW()`,
    [global_entry_cap, allowed_states ?? null, founding_member_cap ?? null, founding_phase_active ?? null],
  );
  invalidatePlatformSettings();
  invalidatePublicBusinessData();
};

export const getPromoCodesService = async () => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT pc.id, pc.code, pc.is_active, pc.max_uses, pc.created_at,
            COUNT(pe.id)::int AS use_count
     FROM promotional_code pc
     LEFT JOIN promotional_entry pe ON pe.code = pc.code
     GROUP BY pc.id
     ORDER BY pc.created_at DESC`,
  );
  return result.rows;
};

export const createPromoCodeService = async (
  code: string,
  maxUses?: number | null,
): Promise<{ id: number; code: string }> => {
  const pool = getPool();
  const normalized = code.toUpperCase().trim();
  if (!normalized || normalized.length < 3 || normalized.length > 100) {
    throw new Error('Code must be between 3 and 100 characters.');
  }
  if (!/^[A-Z0-9_-]+$/.test(normalized)) {
    throw new Error('Code may only contain letters, numbers, hyphens, and underscores.');
  }
  if (maxUses !== undefined && maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
    throw new Error('max_uses must be a positive integer or null (unlimited).');
  }
  try {
    const result = await pool.query(
      `INSERT INTO promotional_code (code, max_uses) VALUES ($1, $2) RETURNING id, code`,
      [normalized, maxUses ?? null],
    );
    return result.rows[0];
  } catch (err: unknown) {
    if (err instanceof Error && (err as Error & { code?: string }).code === '23505') throw new Error('A promo code with that name already exists.');
    throw err;
  }
};

export const deactivatePromoCodeService = async (id: number): Promise<void> => {
  const pool = getPool();
  await pool.query(`UPDATE promotional_code SET is_active = false WHERE id = $1`, [id]);
};

export const getAdminAnalyticsService = async (businessId?: number, drawId?: number) => {
  const pool = getPool();
  // $1 = optional business filter, $2 = optional draw filter. NULL = no filter.
  const biz = businessId ?? null;
  const draw = drawId ?? null;

  const [
    entrySrcRes,
    fraudRes,
    quarantineRes,
    quarantineReasonsRes,
    repeatRes,
    userGrowthRes,
  ] = await Promise.all([
    pool.query(
      `SELECT entry_source, COUNT(*) AS count
       FROM ticket
       WHERE is_quarantined = FALSE AND activated_by_user_id IS NOT NULL
         AND ($1::int IS NULL OR business_id = $1)
         AND ($2::int IS NULL OR draw_id = $2)
       GROUP BY entry_source`,
      [biz, draw],
    ),
    // Free/AMOE entry counts come from the ticket table (entry_source='free') via
    // entrySourceMix below. free_ticket_usage is now a one-row-per-user eligibility
    // tracker (no rejected rows), so it is no longer queried for analytics.
    pool.query(
      `SELECT
         SUM(CASE WHEN u.risk_score >= 20 THEN 1 ELSE 0 END) AS high_risk,
         SUM(CASE WHEN u.risk_score >= 10 AND u.risk_score < 20 THEN 1 ELSE 0 END) AS medium_risk,
         SUM(CASE WHEN u.risk_score < 10 THEN 1 ELSE 0 END) AS low_risk
       FROM "user" u
       WHERE u.role = 'User'
         AND ($1::int IS NULL OR EXISTS (
           SELECT 1 FROM ticket t WHERE t.activated_by_user_id = u.id AND t.business_id = $1
         ))
         AND ($2::int IS NULL OR EXISTS (
           SELECT 1 FROM ticket t WHERE t.activated_by_user_id = u.id AND t.draw_id = $2
         ))`,
      [biz, draw],
    ),
    pool.query(
      `SELECT
         SUM(CASE WHEN is_quarantined = TRUE THEN 1 ELSE 0 END) AS quarantined,
         SUM(CASE WHEN is_quarantined = FALSE AND activated_by_user_id IS NOT NULL THEN 1 ELSE 0 END) AS accepted,
         COUNT(*) AS total
       FROM ticket
       WHERE ($1::int IS NULL OR business_id = $1)
         AND ($2::int IS NULL OR draw_id = $2)`,
      [biz, draw],
    ),
    pool.query(
      `SELECT quarantine_reason, COUNT(*) AS count
       FROM ticket
       WHERE is_quarantined = TRUE AND quarantine_reason IS NOT NULL
         AND ($1::int IS NULL OR business_id = $1)
         AND ($2::int IS NULL OR draw_id = $2)
       GROUP BY quarantine_reason
       ORDER BY count DESC`,
      [biz, draw],
    ),
    pool.query(
      `SELECT
         COUNT(*) AS users_with_submissions,
         ROUND(AVG(submission_count)::numeric, 1) AS avg_submissions_per_user,
         SUM(CASE WHEN submission_count >= 2 THEN 1 ELSE 0 END) AS users_2_plus,
         SUM(CASE WHEN business_count >= 2 THEN 1 ELSE 0 END) AS multi_business_users
       FROM (
         SELECT activated_by_user_id,
                COUNT(*) AS submission_count,
                COUNT(DISTINCT business_id) AS business_count
         FROM ticket
         WHERE is_quarantined = FALSE AND activated_by_user_id IS NOT NULL
           AND ($1::int IS NULL OR business_id = $1)
           AND ($2::int IS NULL OR draw_id = $2)
         GROUP BY activated_by_user_id
       ) sub`,
      [biz, draw],
    ),
    pool.query(
      `SELECT
         SUM(CASE WHEN u.created_at >= DATE_TRUNC('week', NOW()) THEN 1 ELSE 0 END) AS new_this_week,
         SUM(CASE WHEN u.created_at >= DATE_TRUNC('month', NOW()) THEN 1 ELSE 0 END) AS new_this_month,
         COUNT(*) AS total
       FROM "user" u
       WHERE u.role != 'Admin'
         AND ($1::int IS NULL OR EXISTS (
           SELECT 1 FROM ticket t WHERE t.activated_by_user_id = u.id AND t.business_id = $1
         ))
         AND ($2::int IS NULL OR EXISTS (
           SELECT 1 FROM ticket t WHERE t.activated_by_user_id = u.id AND t.draw_id = $2
         ))`,
      [biz, draw],
    ),
  ]);

  const entrySrcMap: Record<string, number> = {};
  for (const row of entrySrcRes.rows) {
    entrySrcMap[row.entry_source] = parseInt(row.count);
  }
  // The 'code' entry mode was removed from the product: legacy code tickets are
  // excluded so the total always equals the sum of the reported sources.
  const entryTotal = ['receipt', 'free', 'promo', 'referral']
    .reduce((a, k) => a + (entrySrcMap[k] ?? 0), 0);

  return {
    entrySourceMix: {
      receipt: entrySrcMap['receipt'] ?? 0,
      free: entrySrcMap['free'] ?? 0,
      promo: entrySrcMap['promo'] ?? 0,
      referral: entrySrcMap['referral'] ?? 0,
      total: entryTotal,
    },
    fraud: {
      high_risk: parseInt(fraudRes.rows[0].high_risk) || 0,
      medium_risk: parseInt(fraudRes.rows[0].medium_risk) || 0,
      low_risk: parseInt(fraudRes.rows[0].low_risk) || 0,
    },
    validation: {
      quarantined: parseInt(quarantineRes.rows[0].quarantined) || 0,
      accepted: parseInt(quarantineRes.rows[0].accepted) || 0,
      total: parseInt(quarantineRes.rows[0].total) || 0,
      quarantine_reasons: quarantineReasonsRes.rows.map((r) => ({
        reason: r.quarantine_reason as string,
        count: parseInt(r.count),
      })),
    },
    repeatBehavior: {
      users_with_submissions: parseInt(repeatRes.rows[0].users_with_submissions) || 0,
      avg_submissions_per_user: parseFloat(repeatRes.rows[0].avg_submissions_per_user) || 0,
      users_2_plus: parseInt(repeatRes.rows[0].users_2_plus) || 0,
      multi_business_users: parseInt(repeatRes.rows[0].multi_business_users) || 0,
    },
    userGrowth: {
      new_this_week: parseInt(userGrowthRes.rows[0].new_this_week) || 0,
      new_this_month: parseInt(userGrowthRes.rows[0].new_this_month) || 0,
      total: parseInt(userGrowthRes.rows[0].total) || 0,
    },
  };
};

export const getEntryVolumeService = async (drawId?: number, businessId?: number) => {
  const pool = getPool();
  const draw = drawId ?? null;
  const biz = businessId ?? null;
  const result = await pool.query(
    `SELECT
       DATE_TRUNC('day', created_at)::date AS date,
       COUNT(*) AS count
     FROM ticket
     WHERE is_quarantined = FALSE
       AND activated_by_user_id IS NOT NULL
       AND ($1::int IS NULL OR draw_id = $1)
       AND ($2::int IS NULL OR business_id = $2)
     GROUP BY DATE_TRUNC('day', created_at)
     ORDER BY DATE_TRUNC('day', created_at) ASC`,
    [draw, biz],
  );
  return result.rows.map((r) => ({
    date: r.date as string,
    count: parseInt(r.count),
  }));
};

export const getCampaignComparisonService = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      d.id,
      d.name,
      d.status,
      d.prize_pool AS prize_amount,
      d.draw_date,
      COALESCE(tc.total_entries, 0) AS total_entries,
      COALESCE(tc.quarantined, 0) AS quarantined,
      COALESCE(de.business_count, 0) AS business_count
    FROM draw d
    LEFT JOIN (
      SELECT draw_id,
             COUNT(*) FILTER (WHERE is_quarantined = FALSE AND activated_by_user_id IS NOT NULL)::int AS total_entries,
             COUNT(*) FILTER (WHERE is_quarantined = TRUE)::int AS quarantined
      FROM ticket GROUP BY draw_id
    ) tc ON tc.draw_id = d.id
    LEFT JOIN (
      SELECT draw_id, COUNT(*) AS business_count FROM draw_entry GROUP BY draw_id
    ) de ON de.draw_id = d.id
    ORDER BY d.draw_date DESC
  `);
  return result.rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    status: r.status as string,
    prize_amount: parseFloat(r.prize_amount) || 0,
    draw_date: r.draw_date as string,
    total_entries: parseInt(r.total_entries),
    quarantined: parseInt(r.quarantined),
    business_count: parseInt(r.business_count),
  }));
};

export const duplicateDrawService = async (drawId: number) => {
  const pool = getPool();
  const existing = await pool.query(`SELECT name, prize_pool FROM draw WHERE id = $1`, [drawId]);
  if (!existing.rows[0]) throw new Error('Draw not found');
  const { name, prize_pool } = existing.rows[0];
  // Land the copy in next month's campaign slot, normalised to the standard month
  // boundaries (1st -> last day, midnight NY) like every other draw.
  const inThirtyDays = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const targetDrawDate = drawDateFromString(inThirtyDays);
  // One campaign per month: a second draw with the same draw_date would make the
  // "next Upcoming" ordering non-deterministic at close/open time.
  const clash = await pool.query(`SELECT id FROM draw WHERE draw_date = $1`, [targetDrawDate]);
  if (clash.rows.length > 0) throw new Error('A campaign already exists for that month');
  const result = await pool.query(
    `INSERT INTO draw (name, prize_pool, start_date, draw_date, status)
     VALUES ($1, $2, $3, $4, 'Upcoming')
     RETURNING id, name, prize_pool AS prize_amount, start_date, draw_date, status`,
    [`${name} (Copy)`, prize_pool, drawStartDateFromString(inThirtyDays), targetDrawDate],
  );
  invalidatePublicBusinessData();
  return result.rows[0];
};

export const getLocationBreakdownService = async (params: {
  businessId?: number;
  search?: string;
  page: number;
  limit: number;
}) => {
  const pool = getPool();
  const { businessId, search, page, limit } = params;
  const biz = businessId ?? null;
  const q = search?.trim() || null;
  const offset = (page - 1) * limit;

  const [rowsRes, countRes] = await Promise.all([
    pool.query(
      `SELECT
         b.id AS business_id,
         b.name AS business_name,
         s_loc.entries_per_location AS entries_per_location,
         b.min_transaction_amount AS threshold,
         bl.id AS location_id,
         COALESCE(bl.name, 'Main Location') AS location_name,
         bl.address,
         COUNT(t.id) AS total_tickets,
         SUM(CASE WHEN t.is_quarantined = FALSE AND t.activated_by_user_id IS NOT NULL THEN 1 ELSE 0 END) AS activated,
         SUM(CASE WHEN t.is_quarantined = TRUE THEN 1 ELSE 0 END) AS quarantined,
         SUM(CASE WHEN t.entry_source = 'receipt' THEN 1 ELSE 0 END) AS receipt_tickets,
         ROUND(AVG(CASE WHEN t.transaction_amount IS NOT NULL THEN t.transaction_amount END)::numeric, 2) AS avg_transaction,
         ROUND(
           100.0 * SUM(CASE WHEN t.transaction_amount IS NOT NULL
             AND b.min_transaction_amount IS NOT NULL
             AND t.transaction_amount >= b.min_transaction_amount
             AND t.transaction_amount <= b.min_transaction_amount * 1.2
             THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN t.entry_source = 'receipt' THEN 1 ELSE 0 END), 0),
           1
         ) AS pct_just_above_threshold
       FROM business b
       JOIN business_location bl ON bl.business_id = b.id AND bl.is_active = TRUE
       LEFT JOIN subscription s_loc ON s_loc.business_id = b.id
       LEFT JOIN ticket t ON t.location_id = bl.id
       WHERE ($1::int IS NULL OR b.id = $1)
         AND ($2::text IS NULL OR b.name ILIKE '%' || $2 || '%' OR bl.name ILIKE '%' || $2 || '%')
       GROUP BY b.id, b.name, s_loc.entries_per_location, b.min_transaction_amount, bl.id, bl.name, bl.address
       ORDER BY b.name, COALESCE(bl.name, 'Main Location')
       LIMIT $3 OFFSET $4`,
      [biz, q, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(*) AS total
       FROM business b
       JOIN business_location bl ON bl.business_id = b.id AND bl.is_active = TRUE
       WHERE ($1::int IS NULL OR b.id = $1)
         AND ($2::text IS NULL OR b.name ILIKE '%' || $2 || '%' OR bl.name ILIKE '%' || $2 || '%')`,
      [biz, q],
    ),
  ]);

  const total = parseInt(countRes.rows[0].total) || 0;
  return {
    rows: rowsRes.rows.map((r) => ({
      business_id: r.business_id as number,
      business_name: r.business_name as string,
      entries_per_location: r.entries_per_location ? parseInt(r.entries_per_location) : null,
      threshold: r.threshold ? parseFloat(r.threshold) : null,
      location_id: r.location_id as number,
      location_name: r.location_name as string,
      address: r.address as string | null,
      total_tickets: parseInt(r.total_tickets) || 0,
      activated: parseInt(r.activated) || 0,
      quarantined: parseInt(r.quarantined) || 0,
      receipt_tickets: parseInt(r.receipt_tickets) || 0,
      avg_transaction: r.avg_transaction ? parseFloat(r.avg_transaction) : null,
      pct_just_above_threshold: r.pct_just_above_threshold ? parseFloat(r.pct_just_above_threshold) : null,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

export const addBusinessToDrawService = async (drawId: number, businessId: number): Promise<void> => {
  const pool = getPool();
  const drawCheck = await pool.query(`SELECT id, status FROM draw WHERE id = $1`, [drawId]);
  if (!drawCheck.rows[0]) throw new Error('Draw not found');
  const drawStatus = drawCheck.rows[0].status as string;
  if (drawStatus !== 'Upcoming' && drawStatus !== 'Open') throw new Error('Can only add businesses to Upcoming or Open draws');

  const subCheck = await pool.query(
    `SELECT s.fee_at_entry,
            -- Plan-less business (manual/free-trial add): snapshot the CURRENT global entry
            -- cap so the capacity displays (business analytics, admin totals) show a number.
            -- Display-only semantics: enforcement always reads the LIVE plan/global values
            -- at submission time, so a later Settings change still governs acceptance even
            -- though this snapshot keeps showing what the cap was when the business was added.
            COALESCE(s.entries_per_location, (SELECT global_entry_cap FROM platform_settings WHERE id = 1)) AS cap_for_entry,
            b.min_transaction_amount
     FROM business b LEFT JOIN subscription s ON s.business_id = b.id AND s.status IN ('Active', 'Trialing')
     WHERE b.id = $1 LIMIT 1`,
    [businessId],
  );
  const feeAtEntry = subCheck.rows[0]?.fee_at_entry ?? 0;
  const capAtEntry = subCheck.rows[0]?.cap_for_entry ?? null;
  const minTxAtEntry = subCheck.rows[0]?.min_transaction_amount ?? null;

  await pool.query(
    `INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, cap_at_entry, min_transaction_at_entry)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (draw_id, business_id) DO NOTHING`,
    [drawId, businessId, feeAtEntry, capAtEntry, minTxAtEntry],
  );
  invalidatePublicBusinessData();
};

export const removeBusinessFromDrawService = async (drawId: number, businessId: number): Promise<void> => {
  const pool = getPool();
  const drawCheck = await pool.query(`SELECT id, status FROM draw WHERE id = $1`, [drawId]);
  if (!drawCheck.rows[0]) throw new Error('Draw not found');
  const drawStatus = drawCheck.rows[0].status as string;
  if (drawStatus === 'Closed') throw new Error('Cannot remove businesses from a closed draw');
  // Removing a business from a LIVE campaign would leave its already-issued tickets
  // drawable with no enrolled business behind them (the known H2 broken intermediate
  // state). Forbid it outright: quarantine the business instead if it misbehaves.
  if (drawStatus === 'Open') throw new Error('Cannot remove a business from a live campaign. Quarantine it instead - customer entries already issued must stay valid.');
  await pool.query(
    `DELETE FROM draw_entry WHERE draw_id = $1 AND business_id = $2`,
    [drawId, businessId],
  );
  invalidatePublicBusinessData();
};

export const pauseBusinessInDrawService = async (
  drawId: number,
  businessId: number,
  paused: boolean,
  actorUserId: number,
): Promise<{ paused: boolean }> => {
  const pool = getPool();

  // Verify the enrollment exists (404 if not).
  const entryCheck = await pool.query(
    `SELECT de.id, d.status FROM draw_entry de JOIN draw d ON d.id = de.draw_id WHERE de.draw_id = $1 AND de.business_id = $2`,
    [drawId, businessId],
  );
  if (!entryCheck.rows[0]) throw Object.assign(new Error('Business is not enrolled in this draw'), { statusCode: 404 });

  const drawStatus = entryCheck.rows[0].status as string;
  if (drawStatus === 'Closed') throw Object.assign(new Error('Cannot change participation on a closed campaign.'), { statusCode: 400 });

  // The UPDATEs re-check the draw status atomically (FROM draw ... status != 'Closed') so a
  // draw closing between the SELECT above and this statement can never be mutated - the
  // pre-check exists only to produce clean 404/400 messages. Idempotent: already-paused is a
  // no-op (paused_at IS NULL predicate).
  if (paused) {
    await pool.query(
      `UPDATE draw_entry de SET paused_at = NOW(), paused_by_user_id = $3
       FROM draw d
       WHERE de.draw_id = $1 AND de.business_id = $2 AND d.id = de.draw_id
         AND d.status != 'Closed' AND de.paused_at IS NULL`,
      [drawId, businessId, actorUserId],
    );
  } else {
    await pool.query(
      `UPDATE draw_entry de SET paused_at = NULL, paused_by_user_id = NULL
       FROM draw d
       WHERE de.draw_id = $1 AND de.business_id = $2 AND d.id = de.draw_id
         AND d.status != 'Closed'`,
      [drawId, businessId],
    );
  }

  invalidatePublicBusinessData();
  // Report the ACTUAL resulting state (truthful even if a concurrent close made the
  // guarded UPDATE match zero rows).
  const state = await pool.query(
    `SELECT (paused_at IS NOT NULL) AS paused FROM draw_entry WHERE draw_id = $1 AND business_id = $2`,
    [drawId, businessId],
  );
  return { paused: state.rows[0]?.paused === true };
};

export const getBusinessDetailService = async (businessId: number) => {
  const pool = getPool();

  const [bizRes, locationsRes, campaignRes] = await Promise.all([
    pool.query(`
      SELECT
        b.id,
        b.name,
        b.legal_name,
        b.sector,
        b.description,
        b.min_transaction_amount,
        b.website_url,
        b.logo_url,
        b.receipt_example_image_url,
        b.created_at,
        u.id AS owner_id,
        u.full_name AS owner_name,
        u.email AS owner_email,
        u.risk_score AS owner_risk_score,
        u.risk_flags AS owner_risk_flags,
        u.is_active AS owner_is_active,
        s.status AS subscription_status,
        s.fee_at_entry,
        s.entries_per_location,
        s.current_period_end,
        EXISTS (
          SELECT 1 FROM draw_entry de
          JOIN draw d ON d.id = de.draw_id
          WHERE de.business_id = b.id AND d.status = 'Open'
        ) AS in_open_draw
      FROM business b
      LEFT JOIN "user" u ON u.id = b.user_id
      LEFT JOIN subscription s ON s.business_id = b.id
      WHERE b.id = $1
    `, [businessId]),

    pool.query(`
      SELECT
        bl.id,
        bl.name,
        bl.address,
        bl.suite,
        bl.phone,
        bl.latitude,
        bl.longitude,
        bl.is_active,
        COUNT(t.id) FILTER (WHERE t.is_quarantined = FALSE AND t.activated_by_user_id IS NOT NULL) AS activated_tickets,
        COUNT(t.id) FILTER (WHERE t.is_quarantined = true) AS quarantined_tickets
      FROM business_location bl
      LEFT JOIN ticket t ON t.location_id = bl.id
      WHERE bl.business_id = $1
      GROUP BY bl.id
      ORDER BY bl.is_active DESC, bl.name ASC
    `, [businessId]),

    pool.query(`
      SELECT
        d.id AS draw_id,
        COALESCE(d.name, 'Unknown') AS draw_name,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE t.is_quarantined)::int AS quarantined
      FROM ticket t
      LEFT JOIN draw d ON d.id = t.draw_id
      WHERE t.business_id = $1
      GROUP BY d.id, d.name
      ORDER BY d.id DESC NULLS LAST
    `, [businessId]),
  ]);

  if (!bizRes.rows[0]) return null;

  const campaignSummary = campaignRes.rows.map((r: { draw_id: number | null; draw_name: string; count: number; quarantined: number }) => ({
    draw_id: r.draw_id,
    draw_name: r.draw_name,
    count: r.count,
    quarantined: r.quarantined,
  }));

  return {
    business: bizRes.rows[0],
    locations: locationsRes.rows,
    campaignSummary,
  };
};

export const getBusinessEntriesService = async (
  businessId: number,
  drawId: number | null,
  page: number,
  limit: number,
) => {
  const pool = getPool();
  const offset = (page - 1) * limit;
  const params: (number)[] = [businessId, limit, offset];
  const drawClause = drawId ? `AND t.draw_id = $${params.push(drawId)}` : '';

  const countParams: (number)[] = [businessId];
  const countDrawClause = drawId ? `AND draw_id = $${countParams.push(drawId)}` : '';

  const [rowsRes, countRes] = await Promise.all([
    pool.query(`
      SELECT
        t.id, t.code, t.status, t.entry_source, t.activated_at,
        t.is_quarantined, t.quarantine_reason, t.risk_flags,
        t.receipt_image_url, t.image_validation_status,
        t.risk_score_delta, t.transaction_amount,
        d.name AS draw_name, d.id AS draw_id,
        u.full_name AS user_name, u.email AS user_email, u.id AS user_id,
        bl.name AS location_name
      FROM ticket t
      LEFT JOIN draw d ON d.id = t.draw_id
      LEFT JOIN "user" u ON u.id = t.activated_by_user_id
      LEFT JOIN business_location bl ON bl.id = t.location_id
      WHERE t.business_id = $1 ${drawClause}
      ORDER BY t.activated_at DESC NULLS LAST
      LIMIT $2 OFFSET $3
    `, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM ticket WHERE business_id = $1 ${countDrawClause}`,
      countParams,
    ),
  ]);

  return { rows: rowsRes.rows, total: countRes.rows[0].total };
};

// ── Admin Entries page: cross-business receipt-review queue + stats ──────────────
// Powers /admin/entries: a global view of receipt entries (the only source with images to
// approve/reject), optionally scoped to one campaign, with a stats header and a paginated,
// status-filtered list. Admin-facing, so risk/quarantine detail IS surfaced (unlike the
// business-facing analytics). 'review' is the actionable queue: images still pending OCR,
// OCR errors, date-unreadable holds, and open contests - everything an admin can act on.
export type AdminEntriesStatus = 'review' | 'all' | 'passed' | 'failed' | 'quarantined';

export const getAdminEntriesService = async (
  drawId: number | null,
  status: AdminEntriesStatus,
  page: number,
  limit: number,
) => {
  const pool = getPool();
  const offset = (page - 1) * limit;

  // Status predicate, reused (with the right column prefix) by both the rows and count
  // queries. All three columns are ticket-only, so a bare name is unambiguous even under
  // the joins in the rows query; passing 't.' keeps it explicit there.
  const statusPredicate = (p: string): string => {
    switch (status) {
      case 'review':
        return `AND (${p}image_validation_status IN ('pending','ocr_error')
                     OR ${p}quarantine_reason IN ('date_unreadable_review','contest_pending'))`;
      case 'passed':      return `AND ${p}image_validation_status = 'passed'`;
      // 'failed' matches the Rejected stat exactly (only genuine OCR rejections). Provider
      // errors (ocr_error) are not rejections; they surface under Quarantined / All.
      case 'failed':      return `AND ${p}image_validation_status = 'failed'`;
      case 'quarantined': return `AND ${p}is_quarantined = TRUE`;
      case 'all':
      default:            return '';
    }
  };

  // Stats: one aggregate pass over receipt entries in scope. FILTER keeps it to a single scan.
  const statsParams: number[] = [];
  const statsDrawClause = drawId ? `AND draw_id = $${statsParams.push(drawId)}` : '';
  const statsRes = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE is_quarantined = FALSE)::int AS active,
       COUNT(*) FILTER (WHERE image_validation_status IN ('pending','ocr_error')
                           OR quarantine_reason IN ('date_unreadable_review','contest_pending'))::int AS awaiting_review,
       COUNT(*) FILTER (WHERE image_validation_status = 'passed')::int AS verified,
       COUNT(*) FILTER (WHERE image_validation_status = 'failed')::int AS rejected,
       COUNT(*) FILTER (WHERE quarantine_reason = 'date_unreadable_review')::int AS held_date,
       COUNT(*) FILTER (WHERE is_quarantined = TRUE)::int AS quarantined,
       COUNT(*) FILTER (WHERE receipt_image_url IS NOT NULL)::int AS with_image
     FROM ticket
     WHERE entry_source = 'receipt' ${statsDrawClause}`,
    statsParams,
  );

  // Rows: newest first, joined for the display columns the page shows.
  const rowParams: number[] = [limit, offset];
  const rowDrawClause = drawId ? `AND t.draw_id = $${rowParams.push(drawId)}` : '';
  const rowsRes = await pool.query(
    `SELECT
       t.id, t.code, t.entry_source, t.activated_at,
       t.is_quarantined, t.quarantine_reason, t.risk_flags,
       t.receipt_image_url, t.image_validation_status,
       t.risk_score_delta, t.transaction_amount, t.receipt_identifier,
       to_char(t.transaction_date, 'YYYY-MM-DD') AS transaction_date,
       d.name AS draw_name, d.id AS draw_id,
       u.id AS user_id, u.full_name AS user_name, u.email AS user_email, u.risk_score AS user_risk_score,
       b.name AS business_name,
       bl.name AS location_name
     FROM ticket t
     LEFT JOIN draw d ON d.id = t.draw_id
     LEFT JOIN "user" u ON u.id = t.activated_by_user_id
     LEFT JOIN business b ON b.id = t.business_id
     LEFT JOIN business_location bl ON bl.id = t.location_id
     WHERE t.entry_source = 'receipt' ${rowDrawClause} ${statusPredicate('t.')}
     ORDER BY t.activated_at DESC NULLS LAST
     LIMIT $1 OFFSET $2`,
    rowParams,
  );

  // Total for pagination, honoring the same draw + status filter.
  const countParams: number[] = [];
  const countDrawClause = drawId ? `AND draw_id = $${countParams.push(drawId)}` : '';
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM ticket
     WHERE entry_source = 'receipt' ${countDrawClause} ${statusPredicate('')}`,
    countParams,
  );

  return { stats: statsRes.rows[0], rows: rowsRes.rows, total: countRes.rows[0].total };
};

export const adminImageDecisionService = async (
  ticketId: number,
  decision: 'approve' | 'reject',
): Promise<void> => {
  const pool = getPool();
  const { updateUserRiskScore, syncUserQuarantineState } = await import('../risk/risk.service.js');

  // Read the immutable receipt coordinates first (business + identifier never change for a ticket)
  // so the advisory lock can be keyed exactly like the submission and OCR paths.
  const coord = await pool.query(
    `SELECT business_id, receipt_identifier FROM ticket WHERE id = $1`,
    [ticketId],
  );
  if (!coord.rows[0]) throw new Error('Ticket not found');
  const coordBusinessId: number = coord.rows[0].business_id;
  const coordIdentifier: string = coord.rows[0].receipt_identifier ?? '';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Advisory lock BEFORE any row lock (same acquisition order as submission + OCR) so an admin
    // decision can't race a concurrent OCR resolution / submission of the same receipt into a
    // unique-index violation or a half-applied supersede. Namespace 4, key business|identifier.
    await client.query(
      `SELECT pg_advisory_xact_lock(4, hashtext($1::text || '|' || $2::text))`,
      [String(coordBusinessId), coordIdentifier],
    );

    const ticketRes = await client.query(
      `SELECT id, activated_by_user_id, draw_id, image_validation_status, is_quarantined, quarantine_reason
       FROM ticket WHERE id = $1 FOR UPDATE`,
      [ticketId],
    );
    if (!ticketRes.rows[0]) throw new Error('Ticket not found');

    const {
      activated_by_user_id: userId, draw_id: drawId, image_validation_status: prevStatus,
      is_quarantined: isQuarantined, quarantine_reason: quarantineReason,
    } = ticketRes.rows[0];
    if (!userId) throw new Error('Ticket has no associated user');

    const overrideable = ['passed', 'failed', 'ocr_error', 'pending'];
    if (!overrideable.includes(prevStatus)) throw new Error(`Cannot override image decision for status: ${prevStatus}`);

    // A ticket can sit at status 'passed' while HELD out of the pool with no reward ever
    // applied: content checks passed but the entry did not (yet) earn a standing slot.
    //   date_unreadable_review - cross-day claim whose scan printed no legible date; held
    //     for exactly this human decision.
    //   contest_not_won - valid image that lost its contest slot.
    // For these, approve is a RELEASE (not a double-approve) and reject must not "reverse"
    // a -3 reward that was never granted.
    const heldWithoutReward =
      isQuarantined === true &&
      prevStatus === 'passed' &&
      (quarantineReason === 'date_unreadable_review' || quarantineReason === 'contest_not_won');

    // Idempotency: prevent double-approve or double-reject from farming risk score
    if (decision === 'approve' && prevStatus === 'passed' && !heldWithoutReward) {
      throw new Error('Image is already approved');
    }
    if (decision === 'reject' && prevStatus === 'failed') throw new Error('Image is already rejected');

    if (decision === 'approve') {
      // Reverse the +2 penalty if previously failed, then apply -3 reward. (Releasing a held
      // ticket grants the plain -3: a human just verified the receipt, which outranks the
      // deferred-reward laundering guard the automatic pass applies.)
      const ticketDeltaChange = prevStatus === 'failed' ? -5 : -3;
      const userDelta = prevStatus === 'failed' ? -5 : -3;

      // Admin approval outranks any competing claim on the same receipt. While this ticket
      // sat rejected/quarantined its receipt number was released (partial unique index), so
      // another user may hold an active or OCR-pending ticket for it. Silently quarantine
      // that competing group (anchor + siblings, shadowban style - its owner sees nothing)
      // BEFORE un-quarantining the approved ticket, or the index would reject the approval.
      // Winner tickets are never displaced (mirrors syncUserQuarantineState's protection).

      // If the competing claim already WON a draw it can never be displaced - fail up front
      // with a clear message instead of erroring mid-way on the unique index.
      const winnerConflict = await client.query(
        `SELECT 1
         FROM ticket me
         JOIN ticket o
           ON o.business_id = me.business_id
          AND o.draw_id = me.draw_id
          AND o.receipt_identifier = me.receipt_identifier
          -- Full dedup-slot key (day + doc_seq, mirroring idx_ticket_receipt_unique): only a
          -- winner holding the SAME per-day slot blocks this approval. A cross-day claim on a
          -- daily-reset check number is a different receipt and is never in conflict.
          AND o.transaction_date IS NOT DISTINCT FROM me.transaction_date
          AND o.receipt_doc_seq = me.receipt_doc_seq
          AND o.id <> me.id
          AND (o.is_quarantined = FALSE OR o.quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review'))
         JOIN draw d ON d.winner_ticket_id = o.id
         WHERE me.id = $1 AND me.receipt_identifier IS NOT NULL
         LIMIT 1`,
        [ticketId],
      );
      if (winnerConflict.rows.length > 0) {
        throw new Error('Cannot approve: another entry with this receipt already won a draw and cannot be displaced.');
      }

      await client.query(
        `WITH approved AS (
           SELECT business_id, draw_id, receipt_identifier, transaction_date, receipt_doc_seq, id
           FROM ticket
           WHERE id = $1 AND receipt_identifier IS NOT NULL
         )
         UPDATE ticket t
         SET is_quarantined    = TRUE,
             quarantine_reason = 'superseded_by_admin_decision',
             quarantined_at    = NOW()
         FROM approved a
         WHERE COALESCE(t.anchor_ticket_id, t.id) IN (
                 SELECT o.id FROM ticket o
                 WHERE o.business_id = a.business_id
                   AND o.draw_id = a.draw_id
                   AND o.receipt_identifier = a.receipt_identifier
                   -- Displace only the holder of the SAME per-day slot (day + doc_seq, the
                   -- unique-index key). Claims on other days of a daily-reset check number -
                   -- including this same user's own other-day entries - are different
                   -- receipts and must survive an approval untouched.
                   AND o.transaction_date IS NOT DISTINCT FROM a.transaction_date
                   AND o.receipt_doc_seq = a.receipt_doc_seq
                   AND o.id <> a.id
                   AND (o.is_quarantined = FALSE OR o.quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review'))
               )
           AND t.id NOT IN (SELECT winner_ticket_id FROM draw WHERE winner_ticket_id IS NOT NULL)`,
        [ticketId],
      );

      await client.query(
        `UPDATE ticket
         SET image_validation_status = 'passed',
             risk_score_delta        = risk_score_delta + $2,
             is_quarantined          = FALSE,
             quarantine_reason       = NULL,
             quarantined_at          = NULL
         WHERE id = $1`,
        [ticketId, ticketDeltaChange],
      );
      await client.query(
        `UPDATE ticket
         SET is_quarantined = FALSE, quarantine_reason = NULL, quarantined_at = NULL
         WHERE anchor_ticket_id = $1
           AND quarantine_reason IN ('ocr_pending', 'ocr_validation_failed', 'ocr_error_pending_review', 'contest_pending', 'contest_not_won', 'date_unreadable_review')`,
        [ticketId],
      );
      await updateUserRiskScore(userId, userDelta, client);
      await syncUserQuarantineState(userId, drawId, client);
    } else {
      // Reverse the -3 reward if previously passed, then apply +2 penalty. A held-passed
      // ticket (date_unreadable_review / contest_not_won) never received the reward, so
      // rejecting it applies the plain +2 - reversing there would over-penalize by 3.
      const ticketDeltaChange = prevStatus === 'passed' && !heldWithoutReward ? 5 : 2;
      const userDelta = ticketDeltaChange;

      await client.query(
        `UPDATE ticket
         SET image_validation_status = 'failed',
             risk_score_delta        = risk_score_delta + $2,
             is_quarantined          = TRUE,
             quarantine_reason       = 'ocr_validation_failed',
             quarantined_at          = NOW()
         WHERE id = $1`,
        [ticketId, ticketDeltaChange],
      );
      // Siblings may have quarantine_reason=NULL if a prior APPROVE un-quarantined them; a later
      // reject must still pull them back out of the draw pool, so match on the anchor alone.
      await client.query(
        `UPDATE ticket
         SET is_quarantined = TRUE, quarantine_reason = 'ocr_validation_failed', quarantined_at = NOW()
         WHERE anchor_ticket_id = $1
           AND (quarantine_reason = 'ocr_pending' OR is_quarantined = FALSE)`,
        [ticketId],
      );
      await updateUserRiskScore(userId, userDelta, client, []);
      await syncUserQuarantineState(userId, drawId, client);
    }

    await client.query('COMMIT');
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
};

// Admin map: every location in the viewport with oversight state the PUBLIC map hides
// (inactive locations, paused enrollments, unsubscribed businesses). Same hard map budget
// as the public endpoint: never more than 30 rows per response, nearest-to-center first.
export const getAdminMapLocationsService = async (
  minLat: number, maxLat: number, minLng: number, maxLng: number,
) => {
  const pool = getPool();
  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;
  const result = await pool.query(`
    SELECT
      loc.id AS location_id,
      loc.name AS location_name,
      loc.address,
      loc.latitude,
      loc.longitude,
      loc.is_active AS location_active,
      b.id AS business_id,
      b.name AS business_name,
      b.sector,
      b.logo_url,
      s.status AS subscription_status,
      EXISTS (
        SELECT 1 FROM draw_entry de JOIN draw d ON d.id = de.draw_id
        WHERE de.business_id = b.id AND d.status = 'Open' AND de.paused_at IS NULL
      ) AS is_participating,
      EXISTS (
        SELECT 1 FROM draw_entry de JOIN draw d ON d.id = de.draw_id
        WHERE de.business_id = b.id AND d.status = 'Open' AND de.paused_at IS NOT NULL
      ) AS is_paused,
      (
        SELECT COUNT(*)::int FROM ticket t
        WHERE t.business_id = b.id AND t.location_id = loc.id
          AND t.draw_id = ${OPEN_DRAW_ID_SUBQUERY}
          AND t.is_quarantined = FALSE AND t.activated_by_user_id IS NOT NULL
      ) AS entries_current
    FROM business_location loc
    JOIN business b ON b.id = loc.business_id
    LEFT JOIN subscription s ON s.business_id = b.id
    WHERE loc.latitude BETWEEN $1 AND $2
      AND loc.longitude BETWEEN $3 AND $4
    ORDER BY ((loc.latitude - $5) * (loc.latitude - $5) + (loc.longitude - $6) * (loc.longitude - $6)) ASC
    LIMIT 30
  `, [minLat, maxLat, minLng, maxLng, centerLat, centerLng]);
  return result.rows;
};

export const getDrawCandidateService = async (drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      d.winner_user_id, d.winner_ticket_id, d.winner_confirmed, d.prize_pool,
      t.code, t.receipt_identifier, t.transaction_amount, t.transaction_date,
      t.receipt_image_url, t.entry_source, t.image_validation_status,
      u.full_name, u.email, u.risk_score,
      b.name AS business_name, bl.name AS location_name,
      dwo.position AS queue_position,
      (SELECT COUNT(*)::int FROM draw_winner_order o WHERE o.draw_id = d.id) AS queue_total,
      conf.created_at AS confirmed_at, conf.actor_user_id AS confirmed_by_id,
      cu.full_name AS confirmed_by_name, cu.email AS confirmed_by_email
    FROM draw d
    LEFT JOIN ticket t ON t.id = d.winner_ticket_id
    LEFT JOIN "user" u ON u.id = d.winner_user_id
    LEFT JOIN business b ON b.id = t.business_id
    LEFT JOIN business_location bl ON bl.id = t.location_id
    LEFT JOIN draw_winner_order dwo ON dwo.draw_id = d.id AND dwo.ticket_id = d.winner_ticket_id
    -- Who confirmed the winner and when, from the append-only audit log (there is at most one
    -- 'winner_confirmed' row per draw). actor is NULL for confirmations recorded before actor
    -- tracking existed; created_at is always present.
    LEFT JOIN LATERAL (
      SELECT dal.actor_user_id, dal.created_at
      FROM draw_audit_log dal
      WHERE dal.draw_id = d.id AND dal.action = 'winner_confirmed'
      ORDER BY dal.created_at DESC
      LIMIT 1
    ) conf ON TRUE
    LEFT JOIN "user" cu ON cu.id = conf.actor_user_id
    WHERE d.id = $1
  `, [drawId]);

  const row = result.rows[0];
  if (!row || !row.winner_ticket_id) return null;

  return {
    winnerConfirmed: row.winner_confirmed === true,
    winnerId: row.winner_user_id,
    winnerName: row.full_name,
    winnerEmail: row.email,
    ticketCode: row.code,
    businessName: row.business_name ?? null,
    locationName: row.location_name ?? null,
    prizePool: parseFloat(row.prize_pool),
    receiptIdentifier: row.receipt_identifier ?? null,
    transactionAmount: row.transaction_amount ? parseFloat(row.transaction_amount) : null,
    transactionDate: row.transaction_date ?? null,
    receiptImageUrl: row.receipt_image_url ?? null,
    entrySource: row.entry_source ?? null,
    imageValidationStatus: row.image_validation_status ?? null,
    riskScore: row.risk_score ?? 0,
    // Where this candidate sits in the frozen selection order. Null for draws whose winner
    // was picked before the order existed (legacy confirmed draws).
    queuePosition: row.queue_position ?? null,
    queueTotal: row.queue_position != null ? row.queue_total : null,
    // Confirmation trail (present once winnerConfirmed is true). confirmedByName is null for
    // winners confirmed before actor tracking existed; confirmedAt is always available.
    confirmedAt: row.confirmed_at ?? null,
    confirmedById: row.confirmed_by_id ?? null,
    confirmedByName: row.confirmed_by_name ?? null,
    confirmedByEmail: row.confirmed_by_email ?? null,
  };
};

// How many locked rows the board response may carry at most.
const LOCKED_WINDOW = 150;

// The draw-order board for the review dialog: every stored position with its resolution
// state. Locked rows (not yet reached by validation) reveal their ticket code and entry
// source but NEVER identity (name/email/risk), so the admin cannot research an entrant
// before their entry becomes the top candidate. The payload is bounded by the stored-prefix
// size (WINNER_ORDER_MIN..WINNER_ORDER_BATCH rows) and the LOCKED_WINDOW display cap, with
// lockedRemaining carrying the count of stored rows beyond the window.
export const getDrawWinnerOrderService = async (drawId: number) => {
  const pool = getPool();
  const drawRes = await pool.query(
    `SELECT winner_ticket_id, winner_confirmed FROM draw WHERE id = $1`,
    [drawId],
  );
  if (drawRes.rows.length === 0) throw new Error('Draw not found');
  const currentTicketId: number | null = drawRes.rows[0].winner_ticket_id;
  const winnerConfirmed: boolean = drawRes.rows[0].winner_confirmed === true;

  const totalRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM draw_winner_order WHERE draw_id = $1`,
    [drawId],
  );
  const total: number = totalRes.rows[0].total;

  // Rejections only ever hit the current top candidate, so every rejected/skipped row sits
  // at or before the current position; the OR clause is a safety net for odd legacy states.
  const result = await pool.query(`
    SELECT dwo.position, dwo.ticket_id,
      t.code, t.entry_source,
      u.full_name, u.email, u.risk_score,
      drw.reason AS rejected_reason, drw.rejected_at
    FROM draw_winner_order dwo
    JOIN ticket t ON t.id = dwo.ticket_id
    LEFT JOIN "user" u ON u.id = t.activated_by_user_id
    LEFT JOIN draw_rejected_winner drw ON drw.draw_id = dwo.draw_id AND drw.ticket_id = dwo.ticket_id
    WHERE dwo.draw_id = $1
      AND (
        dwo.position <= COALESCE((SELECT dwo2.position FROM draw_winner_order dwo2 WHERE dwo2.draw_id = $1 AND dwo2.ticket_id = $2), 0) + $3
        OR drw.id IS NOT NULL
      )
    ORDER BY dwo.position
  `, [drawId, currentTicketId, LOCKED_WINDOW]);

  const currentRow = currentTicketId != null
    ? result.rows.find(r => Number(r.ticket_id) === Number(currentTicketId))
    : undefined;
  const currentPos: number | null = currentRow ? currentRow.position : null;

  const entries = result.rows.map(r => {
    const isRejected = r.rejected_at != null;
    let status: 'rejected' | 'current' | 'confirmed' | 'skipped' | 'locked';
    if (isRejected) status = 'rejected';
    else if (currentPos != null && r.position === currentPos) status = winnerConfirmed ? 'confirmed' : 'current';
    else if (currentPos != null && r.position < currentPos) status = 'skipped';
    else status = 'locked';

    if (status === 'locked') {
      return { position: r.position, status, ticketCode: r.code, entrySource: r.entry_source };
    }
    return {
      position: r.position,
      status,
      ticketCode: r.code,
      userName: r.full_name,
      userEmail: r.email,
      entrySource: r.entry_source,
      riskScore: r.risk_score ?? 0,
      rejectedReason: r.rejected_reason ?? null,
      rejectedAt: r.rejected_at ?? null,
    };
  });

  const includedLocked = entries.filter(e => e.status === 'locked').length;
  const lockedTotal = currentPos != null ? total - currentPos : total;
  return {
    total,
    winnerConfirmed,
    entries,
    lockedRemaining: Math.max(0, lockedTotal - includedLocked),
  };
};

export const getDrawRejectedWinnersService = async (drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      drw.id, drw.rejected_at, drw.risk_penalty, drw.reason,
      drw.rejected_by_user_id, ru.full_name AS rejected_by_name, ru.email AS rejected_by_email,
      t.id AS ticket_id, t.code, t.receipt_identifier, t.transaction_amount,
      t.transaction_date, t.receipt_image_url, t.entry_source,
      u.id AS user_id, u.full_name, u.email, u.risk_score,
      b.name AS business_name, bl.name AS location_name
    FROM draw_rejected_winner drw
    JOIN ticket t ON t.id = drw.ticket_id
    JOIN "user" u ON u.id = drw.user_id
    LEFT JOIN "user" ru ON ru.id = drw.rejected_by_user_id
    LEFT JOIN business b ON b.id = t.business_id
    LEFT JOIN business_location bl ON bl.id = t.location_id
    WHERE drw.draw_id = $1
    ORDER BY drw.rejected_at DESC
  `, [drawId]);

  return result.rows.map(r => ({
    id: r.id,
    rejectedAt: r.rejected_at,
    riskPenalty: r.risk_penalty,
    reason: r.reason ?? null,
    ticketId: r.ticket_id,
    ticketCode: r.code,
    receiptIdentifier: r.receipt_identifier ?? null,
    transactionAmount: r.transaction_amount ? parseFloat(r.transaction_amount) : null,
    transactionDate: r.transaction_date ?? null,
    receiptImageUrl: r.receipt_image_url ?? null,
    entrySource: r.entry_source ?? null,
    userId: r.user_id,
    userName: r.full_name,
    userEmail: r.email,
    userRiskScore: r.risk_score ?? 0,
    businessName: r.business_name ?? null,
    locationName: r.location_name ?? null,
    // Who performed the rejection (null only if that admin account was later deleted).
    rejectedById: r.rejected_by_user_id ?? null,
    rejectedByName: r.rejected_by_name ?? null,
    rejectedByEmail: r.rejected_by_email ?? null,
  }));
};

export const getDrawAuditLogService = async (drawId: number) => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT dal.id, dal.action, dal.metadata, dal.created_at,
            dal.actor_user_id, au.full_name AS actor_name, au.email AS actor_email
     FROM draw_audit_log dal
     LEFT JOIN "user" au ON au.id = dal.actor_user_id
     WHERE dal.draw_id = $1
     -- 2000 is a runaway backstop, not pagination: a draw's full trail must always fit in
     -- one response (a real draw produces a few dozen events at most), so the on-screen log
     -- is never a truncated version of the legal record.
     ORDER BY dal.created_at DESC LIMIT 2000`,
    [drawId],
  );
  return result.rows;
};

export const getUserDetailService = async (userId: number) => {
  const pool = getPool();

  const [userRes, entriesRes] = await Promise.all([
    pool.query(`
      SELECT
        u.id,
        u.full_name,
        u.email,
        u.role,
        u.is_active,
        u.is_email_verified,
        u.risk_score,
        u.risk_flags,
        u.risk_last_flagged_at,
        u.created_at,
        b.id AS business_id,
        b.name AS business_name,
        (s3.status IN ('Active', 'Trialing')) AS business_active
      FROM "user" u
      LEFT JOIN LATERAL (SELECT id, name FROM business WHERE user_id = u.id ORDER BY id LIMIT 1) b ON true
      LEFT JOIN subscription s3 ON s3.business_id = b.id
      WHERE u.id = $1
    `, [userId]),
    pool.query(`
      SELECT
        t.id,
        t.code,
        t.status,
        t.entry_source,
        t.activated_at,
        t.is_quarantined,
        t.quarantine_reason,
        t.risk_flags,
        t.receipt_image_url,
        t.image_validation_status,
        t.risk_score_delta,
        d.name AS draw_name,
        b.name AS business_name
      FROM ticket t
      LEFT JOIN draw d ON d.id = t.draw_id
      LEFT JOIN business b ON b.id = t.business_id
      WHERE t.activated_by_user_id = $1
      ORDER BY t.activated_at DESC
      LIMIT 50
    `, [userId]),
  ]);

  if (!userRes.rows[0]) return null;

  return {
    user: userRes.rows[0],
    entries: entriesRes.rows,
  };
};
