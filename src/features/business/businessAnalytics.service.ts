import { getPool } from '../../shared/db/db.js';
import { resolveScope } from './activity.service.js';

// =============================================================================
// Business Analytics — ONE category at a time (the page only loads the active tab).
// Categories: overview · acquisition · engagement · revenue.
//
// Entry-counting rule = the CAP rule the business already knows: an entry counts when it is
// NOT rejected (is_quarantined = FALSE). Quarantined = "under review", excluded from the cap and
// from every metric here. We never surface the risk/quarantine system to the business, and the
// status enum ('Issued' vs 'Activated') is irrelevant: receipt/free entries are born Activated and
// unclaimed 'Issued' codes have a NULL activated_at, so the activated_at range already excludes them.
// This matches the Campaign Dashboard (activity.service.ts) exactly.
//
// Respects location ($2 NULL = all of this business) and period [from,to). bucket = day|month.
// =============================================================================

export type AnalyticsCategory = 'overview' | 'acquisition' | 'engagement' | 'revenue';

export interface AnalyticsParams {
  from: string;   // ISO inclusive
  to: string;     // ISO exclusive
  bucket: 'day' | 'month';
}

const num = (v: unknown): number => Number(v ?? 0) || 0;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const pct = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

// ── shared internal queries ───────────────────────────────────────────────────

// participants + entries + new/returning split for the period (Overview + Engagement share this)
async function coreStats(businessId: number, loc: number | null, from: string, to: string) {
  const pool = getPool();
  const res = await pool.query(
    `WITH lifetime AS (
       -- total entries per customer at this business, all-time (not bounded by the range),
       -- so First-Time (1 entry) vs Returning (2+) does not change with the selected window
       SELECT activated_by_user_id AS uid, COUNT(*) AS lifetime_entries
       FROM ticket
       WHERE business_id=$1 AND ($2::int IS NULL OR location_id=$2) AND is_quarantined=FALSE AND activated_at IS NOT NULL
       GROUP BY activated_by_user_id
     ),
     period AS (
       SELECT activated_by_user_id AS uid, COUNT(*) AS entries
       FROM ticket
       WHERE business_id=$1 AND ($2::int IS NULL OR location_id=$2) AND is_quarantined=FALSE
         AND activated_at >= $3 AND activated_at < $4
       GROUP BY activated_by_user_id
     )
     SELECT
       COUNT(*)                                              AS total_participants,
       COALESCE(SUM(p.entries), 0)                           AS total_entries,
       COUNT(*) FILTER (WHERE l.lifetime_entries = 1)  AS new_participants,
       COUNT(*) FILTER (WHERE l.lifetime_entries >= 2) AS returning_participants
     FROM period p JOIN lifetime l ON l.uid = p.uid`,
    [businessId, loc, from, to],
  );
  const row = res.rows[0];
  return {
    total_participants: num(row.total_participants),
    total_entries: num(row.total_entries),
    new_participants: num(row.new_participants),
    returning_participants: num(row.returning_participants),
  };
}

// entries / participants / revenue time-series (Overview, Engagement, Revenue)
async function ticketSeries(businessId: number, loc: number | null, from: string, to: string, bk: 'day' | 'month') {
  const pool = getPool();
  const res = await pool.query(
    `SELECT date_trunc($5, activated_at) AS bucket,
            COUNT(*) AS entries,
            COUNT(DISTINCT activated_by_user_id) AS participants,
            COALESCE(SUM(transaction_amount),0) AS revenue
     FROM ticket
     WHERE business_id=$1 AND ($2::int IS NULL OR location_id=$2) AND is_quarantined=FALSE
       AND activated_at >= $3 AND activated_at < $4
     GROUP BY 1 ORDER BY 1`,
    [businessId, loc, from, to, bk],
  );
  return res.rows.map((r) => ({
    bucket: r.bucket as string,
    entries: num(r.entries),
    participants: num(r.participants),
    revenue: r2(num(r.revenue)),
  }));
}

// ── 1. OVERVIEW ───────────────────────────────────────────────────────────────
export const getOverviewAnalytics = async (
  userId: number, jwtLocationId: number | null | undefined, filterLocationId: number | undefined, p: AnalyticsParams,
) => {
  const { businessId, scopedLocationId } = await resolveScope(userId, jwtLocationId, filterLocationId);
  const empty = {
    total_participants: 0, total_entries: 0, avg_entries_per_participant: 0,
    new_participants: 0, returning_participants: 0, new_pct: 0, returning_pct: 0,
    entry_cap: { used: 0, cap: null as number | null, pct: 0 }, series: [] as ReturnType<typeof num>[] & unknown[],
  };
  if (businessId == null) return { ...empty, series: [] };
  const loc = scopedLocationId;
  const pool = getPool();

  const [core, capRes, series] = await Promise.all([
    coreStats(businessId, loc, p.from, p.to),
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM ticket t
            WHERE t.business_id=$1 AND ($2::int IS NULL OR t.location_id=$2) AND t.is_quarantined=FALSE
              AND t.draw_id=(SELECT id FROM draw WHERE status='Open' ORDER BY draw_date ASC LIMIT 1)) AS used,
         (SELECT s.entries_per_location FROM subscription s WHERE s.business_id=$1) AS per_loc,
         (SELECT COUNT(*) FROM business_location WHERE business_id=$1 AND is_active=TRUE) AS loc_count`,
      [businessId, loc],
    ),
    ticketSeries(businessId, loc, p.from, p.to, p.bucket === 'month' ? 'month' : 'day'),
  ]);

  const perLoc = capRes.rows[0]?.per_loc != null ? Number(capRes.rows[0].per_loc) : null;
  const locCount = num(capRes.rows[0]?.loc_count);
  const entryCap = perLoc != null ? perLoc * (loc ? 1 : Math.max(locCount, 1)) : null;
  const used = num(capRes.rows[0]?.used);
  const { total_participants, total_entries, new_participants, returning_participants } = core;

  return {
    total_participants, total_entries,
    avg_entries_per_participant: total_participants > 0 ? r2(total_entries / total_participants) : 0,
    new_participants, returning_participants,
    new_pct: pct(new_participants, new_participants + returning_participants),
    returning_pct: pct(returning_participants, new_participants + returning_participants),
    entry_cap: { used, cap: entryCap, pct: pct(used, entryCap ?? 0) },
    series,
  };
};

// ── 2. ACQUISITION ────────────────────────────────────────────────────────────
export const getAcquisitionAnalytics = async (
  userId: number, jwtLocationId: number | null | undefined, filterLocationId: number | undefined, p: AnalyticsParams,
) => {
  const { businessId, scopedLocationId } = await resolveScope(userId, jwtLocationId, filterLocationId);
  if (businessId == null) {
    return { new_users_acquired: 0, business_discovery: 0, profile_views: 0, conversion_pct: 0, acquisitionSeries: [] };
  }
  const loc = scopedLocationId;
  const a = [businessId, loc, p.from, p.to] as const;
  const bk = p.bucket === 'month' ? 'month' : 'day';
  const pool = getPool();

  const [acquired, discovery, views, participants, viewedThenEntered, acqNew, acqViews] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS n FROM "user" u
       JOIN user_acquisition ua ON ua.user_id = u.id
       JOIN business_location bl ON bl.id = ua.location_id
       WHERE bl.business_id=$1 AND ($2::int IS NULL OR bl.id=$2) AND u.created_at >= $3 AND u.created_at < $4`, [...a]),
    pool.query(
      `WITH firstpart AS (
         SELECT activated_by_user_id AS uid, MIN(activated_at) AS first_at FROM ticket
         WHERE business_id=$1 AND ($2::int IS NULL OR location_id=$2) AND is_quarantined=FALSE AND activated_at IS NOT NULL
         GROUP BY activated_by_user_id)
       SELECT COUNT(*) AS n FROM firstpart fp JOIN "user" u ON u.id = fp.uid
       WHERE fp.first_at >= $3 AND fp.first_at < $4 AND u.created_at < fp.first_at
         -- exclude customers YOU brought to Winnbell (counted in "Joined Winnbell via You"),
         -- so they are never also counted as an existing user "New to Your Shop"
         AND NOT EXISTS (
           SELECT 1 FROM user_acquisition ua JOIN business_location bl ON bl.id = ua.location_id
           WHERE ua.user_id = u.id AND bl.business_id = $1 AND ($2::int IS NULL OR bl.id = $2)
         )`, [...a]),
    pool.query(
      `SELECT COUNT(DISTINCT user_id) AS n FROM business_profile_view
       WHERE business_id=$1 AND ($2::int IS NULL OR location_id=$2) AND last_viewed_at >= $3 AND last_viewed_at < $4`, [...a]),
    pool.query(
      `SELECT COUNT(DISTINCT activated_by_user_id) AS n FROM ticket
       WHERE business_id=$1 AND ($2::int IS NULL OR location_id=$2) AND is_quarantined=FALSE
         AND activated_at >= $3 AND activated_at < $4`, [...a]),
    // Conversion numerator: customers who entered in the period AND had viewed the profile BEFORE
    // that entry. Subset of the participants above, so conversion is always <= 100%.
    pool.query(
      `SELECT COUNT(DISTINCT t.activated_by_user_id) AS n FROM ticket t
       WHERE t.business_id=$1 AND ($2::int IS NULL OR t.location_id=$2) AND t.is_quarantined=FALSE
         AND t.activated_at >= $3 AND t.activated_at < $4
         AND EXISTS (
           SELECT 1 FROM business_profile_view v
           WHERE v.user_id = t.activated_by_user_id AND v.business_id=$1
             AND ($2::int IS NULL OR v.location_id=$2) AND v.first_viewed_at <= t.activated_at
         )`, [...a]),
    pool.query(
      `SELECT to_char(date_trunc($5, u.created_at), 'YYYY-MM-DD"T"HH24:MI:SS') AS bucket, COUNT(*) AS new_users
       FROM "user" u JOIN user_acquisition ua ON ua.user_id=u.id JOIN business_location bl ON bl.id=ua.location_id
       WHERE bl.business_id=$1 AND ($2::int IS NULL OR bl.id=$2) AND u.created_at >= $3 AND u.created_at < $4
       GROUP BY 1 ORDER BY 1`, [businessId, loc, p.from, p.to, bk]),
    pool.query(
      `SELECT to_char(date_trunc($5, last_viewed_at), 'YYYY-MM-DD"T"HH24:MI:SS') AS bucket, COUNT(DISTINCT user_id) AS profile_views
       FROM business_profile_view WHERE business_id=$1 AND ($2::int IS NULL OR location_id=$2) AND last_viewed_at >= $3 AND last_viewed_at < $4
       GROUP BY 1 ORDER BY 1`, [businessId, loc, p.from, p.to, bk]),
  ]);

  const acqMap = new Map<string, { bucket: string; new_users: number; profile_views: number }>();
  for (const row of acqNew.rows) acqMap.set(String(row.bucket), { bucket: String(row.bucket), new_users: num(row.new_users), profile_views: 0 });
  for (const row of acqViews.rows) {
    const b = String(row.bucket);
    const e = acqMap.get(b) ?? { bucket: b, new_users: 0, profile_views: 0 };
    e.profile_views = num(row.profile_views); acqMap.set(b, e);
  }
  const profileViews = num(views.rows[0].n);
  return {
    new_users_acquired: num(acquired.rows[0].n),
    business_discovery: num(discovery.rows[0].n),
    profile_views: profileViews,
    conversion_pct: pct(num(viewedThenEntered.rows[0].n), num(participants.rows[0].n)),
    acquisitionSeries: [...acqMap.values()].sort((x, y) => (x.bucket < y.bucket ? -1 : 1)),
  };
};

// ── 3. ENGAGEMENT ─────────────────────────────────────────────────────────────
export const getEngagementAnalytics = async (
  userId: number, jwtLocationId: number | null | undefined, filterLocationId: number | undefined, p: AnalyticsParams,
) => {
  const { businessId, scopedLocationId } = await resolveScope(userId, jwtLocationId, filterLocationId);
  if (businessId == null) {
    return { repeat_participation_pct: 0, avg_entries_per_user: 0, returning_participant_count: 0, loyal_customers: 0, series: [] };
  }
  const loc = scopedLocationId;
  const pool = getPool();
  const [core, loyal, series] = await Promise.all([
    coreStats(businessId, loc, p.from, p.to),
    pool.query(
      `SELECT COUNT(*) AS n FROM (
         SELECT activated_by_user_id FROM ticket
         WHERE business_id=$1 AND ($2::int IS NULL OR location_id=$2) AND is_quarantined=FALSE
           AND activated_at >= ($3::timestamp - INTERVAL '60 days') AND activated_at < $3::timestamp
         GROUP BY activated_by_user_id HAVING COUNT(*) >= 2) x`, [businessId, loc, p.to]),
    ticketSeries(businessId, loc, p.from, p.to, p.bucket === 'month' ? 'month' : 'day'),
  ]);
  const { total_participants, total_entries, returning_participants } = core;
  return {
    repeat_participation_pct: pct(returning_participants, total_participants),
    avg_entries_per_user: total_participants > 0 ? r2(total_entries / total_participants) : 0,
    returning_participant_count: returning_participants,
    loyal_customers: num(loyal.rows[0].n),
    series,
  };
};

// ── 4. REVENUE IMPACT ─────────────────────────────────────────────────────────
export const getRevenueAnalytics = async (
  userId: number, jwtLocationId: number | null | undefined, filterLocationId: number | undefined, p: AnalyticsParams,
) => {
  const { businessId, scopedLocationId } = await resolveScope(userId, jwtLocationId, filterLocationId);
  if (businessId == null) {
    return { total_qualifying_revenue: 0, threshold: 0, avg_purchase_amount: 0, revenue_change_pct: null, series: [] };
  }
  const loc = scopedLocationId;
  const a = [businessId, loc, p.from, p.to] as const;
  const pool = getPool();
  const [revenue, threshold, draws, series] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(transaction_amount),0) AS total_revenue,
              COALESCE(AVG(transaction_amount),0) AS avg_purchase
       FROM ticket WHERE business_id=$1 AND ($2::int IS NULL OR location_id=$2) AND is_quarantined=FALSE
         AND activated_at >= $3 AND activated_at < $4`, [...a]),
    pool.query(`SELECT min_transaction_amount FROM business WHERE id=$1`, [businessId]),
    // "Compared to Last Draw": qualifying sales of the two most recent draws this business ran in
    // (newest first). Inherently draw-to-draw, so it ignores the [from,to) duration filter.
    pool.query(
      `SELECT COALESCE(SUM(t.transaction_amount),0) AS rev
       FROM ticket t JOIN draw d ON d.id = t.draw_id
       WHERE t.business_id=$1 AND ($2::int IS NULL OR t.location_id=$2) AND t.is_quarantined=FALSE
       GROUP BY t.draw_id, d.draw_date
       ORDER BY d.draw_date DESC
       LIMIT 2`, [businessId, loc]),
    ticketSeries(businessId, loc, p.from, p.to, p.bucket === 'month' ? 'month' : 'day'),
  ]);
  const totalRevenue = r2(num(revenue.rows[0].total_revenue));
  const avgPurchase = r2(num(revenue.rows[0].avg_purchase));
  const thr = r2(num(threshold.rows[0]?.min_transaction_amount));
  // current draw vs previous draw. null when the business has fewer than 2 draws, or the
  // previous draw had no qualifying sales to compare against.
  const curDraw = num(draws.rows[0]?.rev);
  const prevDraw = num(draws.rows[1]?.rev);
  const revenueChangePct = draws.rows.length >= 2 && prevDraw > 0 ? r2(((curDraw - prevDraw) / prevDraw) * 100) : null;
  return {
    total_qualifying_revenue: totalRevenue,
    threshold: thr,
    avg_purchase_amount: avgPurchase,
    revenue_change_pct: revenueChangePct,
    series,
  };
};
