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

export const getFunnelAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const days = ALLOWED_DAYS.includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const pool = getPool();

    const [totals, reasons, daily, transitions] = await Promise.all([
      pool.query(
        `SELECT event_type, COUNT(*)::int AS n
         FROM funnel_event
         WHERE occurred_at >= CURRENT_DATE - $1::int
         GROUP BY 1`,
        [days],
      ),
      pool.query(
        `SELECT COALESCE(reason_code, 'unknown_error') AS reason, COUNT(*)::int AS n
         FROM funnel_event
         WHERE event_type = 'submission_rejected' AND occurred_at >= CURRENT_DATE - $1::int
         GROUP BY 1 ORDER BY 2 DESC`,
        [days],
      ),
      pool.query(
        `SELECT occurred_at::date::text AS day,
                COUNT(*) FILTER (WHERE event_type = 'account_created')::int    AS accounts,
                COUNT(*) FILTER (WHERE event_type = 'submission_accepted')::int AS submissions
         FROM funnel_event
         WHERE occurred_at >= CURRENT_DATE - $1::int
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
    ]);

    const totalsMap: Record<string, number> = {};
    for (const row of totals.rows as Array<{ event_type: string; n: number }>) {
      totalsMap[row.event_type] = row.n;
    }

    res.json({
      days,
      totals: totalsMap,
      rejectionReasons: reasons.rows,
      daily: daily.rows,
      transitions: transitions.rows,
    });
  } catch (err) {
    console.error('[admin] funnel analytics failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ message: 'Failed to load funnel analytics.' });
  }
};
