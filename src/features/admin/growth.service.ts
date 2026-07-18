import { getPool } from '../../shared/db/db.js';

// =============================================================================
// Growth / North-Star analytics (admin dashboard, requirements §1,3,4,5,6,7,9,11,12,13).
//
// DEFINITION OF "ACTIVE USER": a user (role 'User') who made at least one entry
// (non-quarantined, owned ticket) in the window, bucketed by created_at. There is no
// session/login event log, so every MAU/WAU/DAU/retention/engagement figure here is
// entry-activity based. Quarantined (shadow-banned) entries are excluded everywhere;
// the legacy ticket.status enum and nullable activated_at are dead and not used.
//
// All counts are computed from existing tables. Metrics that would need historical
// event logs we do not keep (true month-over-month churn, subscription upgrades)
// are computed as point-in-time snapshots and labelled as such on the client.
// =============================================================================

const pct = (part: number, whole: number): number =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

// growth rate this vs last period; null when there is no prior base to compare against
const growthRate = (current: number, previous: number): number | null =>
  previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;

const n = (v: unknown): number => Number(v ?? 0) || 0;

export const getGrowthAnalyticsService = async () => {
  const pool = getPool();

  const [
    userCore,
    activity,
    bizCore,
    founding,
    acquisition,
    bizRetention,
    revenue,
    revenueTrend,
    engagement,
    amoeOnly,
    cohorts,
    fraud,
    geoState,
    geoCity,
  ] = await Promise.all([
    // ── §3 user counts + growth base ───────────────────────────────────────────
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE role = 'User')                                                   AS total_users,
        COUNT(*) FILTER (WHERE role = 'User' AND created_at >= DATE_TRUNC('month', NOW()))       AS new_this_month,
        COUNT(*) FILTER (WHERE role = 'User'
                          AND created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
                          AND created_at <  DATE_TRUNC('month', NOW()))                          AS new_last_month
      FROM "user"
    `),

    // ── §3 MAU / WAU / DAU (entry-activity based) ──────────────────────────────
    pool.query(`
      SELECT
        COUNT(DISTINCT activated_by_user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')   AS dau,
        COUNT(DISTINCT activated_by_user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS wau,
        COUNT(DISTINCT activated_by_user_id) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS mau
      FROM ticket
      WHERE is_quarantined = FALSE AND activated_by_user_id IS NOT NULL
    `),

    // ── §1 business growth ─────────────────────────────────────────────────────
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM business)                                                                       AS total_businesses,
        (SELECT COUNT(*) FROM business WHERE created_at >= DATE_TRUNC('month', NOW()))                        AS new_businesses_this_month,
        (SELECT COUNT(*) FROM business
           WHERE created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
             AND created_at <  DATE_TRUNC('month', NOW()))                                                    AS new_businesses_last_month,
        (SELECT COUNT(DISTINCT business_id) FROM subscription WHERE status IN ('Active','Trialing'))          AS paying_businesses,
        (SELECT COUNT(*) FROM subscription
           WHERE status IN ('Active','Trialing') AND created_at >= DATE_TRUNC('month', NOW()))                AS new_paying_this_month,
        (SELECT COUNT(*) FROM subscription
           WHERE status IN ('Active','Trialing')
             AND created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
             AND created_at <  DATE_TRUNC('month', NOW()))                                                    AS new_paying_last_month
    `),

    pool.query(`SELECT COUNT(*) AS founding_members FROM founding_member`),

    // ── §4 acquisition source breakdown (from the user_acquisition table) ──────
    pool.query(`
      SELECT COALESCE(ua.source::text, 'direct') AS source, COUNT(*) AS count
      FROM "user" u
      LEFT JOIN user_acquisition ua ON ua.user_id = u.id
      WHERE u.role = 'User'
      GROUP BY COALESCE(ua.source::text, 'direct')
    `),

    // ── §5 business retention (snapshot) ───────────────────────────────────────
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('Active','Trialing') AND billing_interval = 'monthly') AS monthly_subs,
        COUNT(*) FILTER (WHERE status IN ('Active','Trialing') AND billing_interval = 'yearly')  AS yearly_subs,
        COUNT(*) FILTER (WHERE status IN ('Active','Trialing'))                                   AS active_paying,
        COUNT(*) FILTER (WHERE status = 'Cancelled')                                              AS cancelled,
        COUNT(*) FILTER (WHERE status IN ('Active','Trialing') AND cancel_at_period_end = TRUE)   AS pending_cancel
      FROM subscription
    `),

    // ── §11 revenue (MRR = monthly-equiv fee on active subs; ARR = MRR*12) ──────
    pool.query(`
      SELECT
        COALESCE(SUM(fee_at_entry), 0) AS mrr,
        COALESCE((SELECT SUM(amount) FROM founding_payment WHERE created_at >= DATE_TRUNC('month', NOW())), 0) AS founding_this_month
      FROM subscription
      WHERE status IN ('Active','Trialing')
    `),

    // ── §11 revenue trend per campaign (draw_entry fee snapshot per draw) ───────
    pool.query(`
      SELECT d.id, d.name, d.draw_date,
             COALESCE(SUM(de.fee_at_entry), 0) AS revenue,
             COUNT(de.id) AS businesses
      FROM draw d
      LEFT JOIN draw_entry de ON de.draw_id = d.id
      GROUP BY d.id, d.name, d.draw_date
      ORDER BY d.draw_date DESC
      LIMIT 6
    `),

    // ── §7 engagement this month (per active user) ─────────────────────────────
    pool.query(`
      WITH active AS (
        SELECT activated_by_user_id AS uid,
               COUNT(*) AS entries,
               COUNT(DISTINCT business_id) AS biz,
               COUNT(*) FILTER (WHERE entry_source IN ('receipt','code')) AS purchase_entries
        FROM ticket
        WHERE is_quarantined = FALSE AND activated_by_user_id IS NOT NULL
          AND created_at >= DATE_TRUNC('month', NOW())
        GROUP BY activated_by_user_id
      )
      SELECT
        COUNT(*)                                                  AS active_users,
        COALESCE(SUM(entries), 0)                                 AS total_entries,
        COALESCE(ROUND(AVG(entries)::numeric, 2), 0)              AS avg_entries,
        COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY entries), 0) AS median_entries,
        COALESCE(ROUND(AVG(biz)::numeric, 2), 0)                  AS avg_businesses,
        COUNT(*) FILTER (WHERE biz = 1)                           AS single_business_users,
        COUNT(*) FILTER (WHERE biz > 1)                           AS multi_business_users,
        COUNT(*) FILTER (WHERE entries > 20)                      AS over_20_entries,
        COUNT(*) FILTER (WHERE entries >= 30)                     AS at_30_entries,
        COUNT(*) FILTER (WHERE purchase_entries = 0)              AS amoe_only_users
      FROM active
    `),

    // placeholder slot kept for query symmetry (amoe folded above)
    pool.query(`SELECT 1`),

    // ── §6 user cohort retention M1/M2/M3 (registration month -> active in +N) ──
    pool.query(`
      WITH cohorts AS (
        SELECT id AS uid, DATE_TRUNC('month', created_at) AS cohort_month
        FROM "user" WHERE role = 'User'
      ),
      activity AS (
        SELECT DISTINCT activated_by_user_id AS uid, DATE_TRUNC('month', created_at) AS active_month
        FROM ticket
        WHERE is_quarantined = FALSE AND activated_by_user_id IS NOT NULL
      )
      SELECT
        COUNT(*) FILTER (WHERE cohort_month <= DATE_TRUNC('month', NOW()) - INTERVAL '1 month') AS eligible_m1,
        COUNT(*) FILTER (WHERE cohort_month <= DATE_TRUNC('month', NOW()) - INTERVAL '2 month') AS eligible_m2,
        COUNT(*) FILTER (WHERE cohort_month <= DATE_TRUNC('month', NOW()) - INTERVAL '3 month') AS eligible_m3,
        COUNT(*) FILTER (WHERE cohort_month <= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
                          AND EXISTS (SELECT 1 FROM activity a WHERE a.uid = c.uid
                                       AND a.active_month = c.cohort_month + INTERVAL '1 month')) AS retained_m1,
        COUNT(*) FILTER (WHERE cohort_month <= DATE_TRUNC('month', NOW()) - INTERVAL '2 month'
                          AND EXISTS (SELECT 1 FROM activity a WHERE a.uid = c.uid
                                       AND a.active_month = c.cohort_month + INTERVAL '2 month')) AS retained_m2,
        COUNT(*) FILTER (WHERE cohort_month <= DATE_TRUNC('month', NOW()) - INTERVAL '3 month'
                          AND EXISTS (SELECT 1 FROM activity a WHERE a.uid = c.uid
                                       AND a.active_month = c.cohort_month + INTERVAL '3 month')) AS retained_m3
      FROM cohorts c
    `),

    // ── §12 fraud & integrity ──────────────────────────────────────────────────
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM ticket WHERE is_quarantined = TRUE)                                  AS quarantined_entries,
        (SELECT COUNT(*) FROM draw_rejected_winner)                                                AS rejected_winners,
        (SELECT COUNT(*) FROM "user" WHERE role != 'Admin' AND is_active = FALSE)                  AS suspended_users,
        (SELECT COUNT(*) FROM "user" WHERE role = 'User' AND risk_score >= 20)                     AS high_risk_users,
        (SELECT COUNT(*) FROM receipt_threshold_attempt)                                           AS threshold_probes,
        (SELECT COUNT(*) FROM phone_otp WHERE created_at >= DATE_TRUNC('month', NOW()))            AS verifications_this_month,
        (SELECT COUNT(*) FROM ticket
           WHERE is_quarantined = FALSE AND activated_by_user_id IS NOT NULL
             AND created_at >= DATE_TRUNC('month', NOW()))                                        AS entries_this_month
    `),

    // ── §9 geography (self-declared state of residence from profile setup; city
    //    stays IP-derived - there is no user-typed city field) ────────────────────
    pool.query(`
      SELECT state, COUNT(*) AS count
      FROM "user" WHERE role = 'User' AND state IS NOT NULL
      GROUP BY state ORDER BY count DESC LIMIT 15
    `),
    pool.query(`
      SELECT city, COUNT(*) AS count
      FROM "user" WHERE role = 'User' AND city IS NOT NULL
      GROUP BY city ORDER BY count DESC LIMIT 15
    `),
  ]);

  // ── assemble ────────────────────────────────────────────────────────────────
  const totalUsers = n(userCore.rows[0].total_users);
  const newUsers = n(userCore.rows[0].new_this_month);
  const newUsersPrev = n(userCore.rows[0].new_last_month);
  const mau = n(activity.rows[0].mau);
  const wau = n(activity.rows[0].wau);
  const dau = n(activity.rows[0].dau);

  const totalBiz = n(bizCore.rows[0].total_businesses);
  const payingBiz = n(bizCore.rows[0].paying_businesses);
  const newPaying = n(bizCore.rows[0].new_paying_this_month);
  const newPayingPrev = n(bizCore.rows[0].new_paying_last_month);
  const newBiz = n(bizCore.rows[0].new_businesses_this_month);
  const newBizPrev = n(bizCore.rows[0].new_businesses_last_month);

  const acquisitionRows = acquisition.rows.map((r) => ({ source: r.source as string, count: n(r.count) }));
  const acquisitionTotal = acquisitionRows.reduce((a, b) => a + b.count, 0);
  const organicSources = new Set(['direct']); // referral/promo/flyer are "acquired"; direct = organic/unattributed
  const organicUsers = acquisitionRows.filter((r) => organicSources.has(r.source)).reduce((a, b) => a + b.count, 0);

  const activePaying = n(bizRetention.rows[0].active_paying);
  const cancelled = n(bizRetention.rows[0].cancelled);
  const churnRate = pct(cancelled, activePaying + cancelled);

  const mrr = Number(revenue.rows[0].mrr) || 0;
  const foundingThisMonth = Number(revenue.rows[0].founding_this_month) || 0;
  const arpb = payingBiz > 0 ? Math.round((mrr / payingBiz) * 100) / 100 : 0;
  // LTV estimate = ARPB / monthly churn rate (snapshot). Guarded; null when churn is 0.
  const ltv = churnRate > 0 ? Math.round((arpb / (churnRate / 100)) * 100) / 100 : null;

  const eng = engagement.rows[0];

  const elig = cohorts.rows[0];

  return {
    northStar: {
      paying_businesses: payingBiz,
      new_paying_this_month: newPaying,
      total_users: totalUsers,
      mau,
      mrr,
      business_churn_pct: churnRate,
      user_growth_pct: growthRate(newUsers, newUsersPrev),
      paying_business_growth_pct: growthRate(newPaying, newPayingPrev),
      avg_entries_per_active_user: Number(eng.avg_entries) || 0,
      pct_businesses_acquired_organically: null, // needs §2 business acquisition source (deferred)
      pct_users_acquired_organically: pct(organicUsers, acquisitionTotal),
    },
    businessGrowth: {
      total_businesses: totalBiz,
      paying_businesses: payingBiz,
      founding_members: n(founding.rows[0].founding_members),
      new_businesses_this_month: newBiz,
      new_paying_this_month: newPaying,
      business_growth_pct: growthRate(newBiz, newBizPrev),
      paying_business_growth_pct: growthRate(newPaying, newPayingPrev),
    },
    userGrowth: {
      total_users: totalUsers,
      new_this_month: newUsers,
      user_growth_pct: growthRate(newUsers, newUsersPrev),
      mau, wau, dau,
      mau_over_total_pct: pct(mau, totalUsers),
      wau_over_mau_pct: pct(wau, mau),
      dau_over_mau_pct: pct(dau, mau),
    },
    acquisition: {
      total: acquisitionTotal,
      by_source: acquisitionRows.map((r) => ({ ...r, pct: pct(r.count, acquisitionTotal) })),
    },
    businessRetention: {
      monthly_subs: n(bizRetention.rows[0].monthly_subs),
      yearly_subs: n(bizRetention.rows[0].yearly_subs),
      active_paying: activePaying,
      cancelled,
      pending_cancel: n(bizRetention.rows[0].pending_cancel),
      churn_pct: churnRate,
      active_paying_pct: pct(activePaying, totalBiz),
    },
    userRetention: {
      m1_pct: pct(n(elig.retained_m1), n(elig.eligible_m1)),
      m2_pct: pct(n(elig.retained_m2), n(elig.eligible_m2)),
      m3_pct: pct(n(elig.retained_m3), n(elig.eligible_m3)),
      eligible_m1: n(elig.eligible_m1),
      eligible_m2: n(elig.eligible_m2),
      eligible_m3: n(elig.eligible_m3),
    },
    engagement: {
      active_users: n(eng.active_users),
      total_entries: n(eng.total_entries),
      avg_entries: Number(eng.avg_entries) || 0,
      median_entries: Number(eng.median_entries) || 0,
      avg_businesses: Number(eng.avg_businesses) || 0,
      single_business_pct: pct(n(eng.single_business_users), n(eng.active_users)),
      multi_business_pct: pct(n(eng.multi_business_users), n(eng.active_users)),
      over_20_pct: pct(n(eng.over_20_entries), n(eng.active_users)),
      at_30_pct: pct(n(eng.at_30_entries), n(eng.active_users)),
      amoe_only_pct: pct(n(eng.amoe_only_users), n(eng.active_users)),
    },
    revenue: {
      mrr,
      arr: mrr * 12,
      founding_this_month: foundingThisMonth,
      revenue_this_month: mrr + foundingThisMonth,
      arpb,
      ltv_estimate: ltv,
      trend: revenueTrend.rows.map((r) => ({
        draw_id: r.id as number,
        name: r.name as string,
        draw_date: r.draw_date as string,
        revenue: Number(r.revenue) || 0,
        businesses: n(r.businesses),
      })).reverse(),
    },
    fraud: {
      quarantined_entries: n(fraud.rows[0].quarantined_entries),
      rejected_winners: n(fraud.rows[0].rejected_winners),
      suspended_users: n(fraud.rows[0].suspended_users),
      high_risk_users: n(fraud.rows[0].high_risk_users),
      threshold_probes: n(fraud.rows[0].threshold_probes),
      verifications_this_month: n(fraud.rows[0].verifications_this_month),
      entries_this_month: n(fraud.rows[0].entries_this_month),
    },
    geo: {
      by_state: geoState.rows.map((r) => ({ state: r.state as string, count: n(r.count) })),
      by_city: geoCity.rows.map((r) => ({ city: r.city as string, count: n(r.count) })),
    },
  };
};
