import { getPool } from '../../shared/db/db.js';

export interface DrawBreakdown {
  draw_id: number;
  draw_name: string;
  draw_date: string;
  draw_status: string;
  entries: number;
  revenue: number;
}

export interface CustomerGrowthPoint {
  month: string;
  new_customers: number;
  total_customers: number;
}

export interface StatsResult {
  summary: {
    total_entries: number;
    total_revenue: number;
    avg_transaction: number;
  };
  daily: Array<{ date: string; entries: number; revenue: number }>;
  monthly: Array<{ month: string; entries: number; revenue: number }>;
  locations: Array<{
    location_id: number;
    location_name: string;
    entries: number;
    revenue: number;
  }>;
  draws: DrawBreakdown[];
  customer_growth: CustomerGrowthPoint[];
}

export const getBusinessStats = async (
  userId: number,
  jwtLocationId: number | null | undefined,
  filterLocationId?: number,
  filterDrawId?: number,
): Promise<StatsResult> => {
  const pool = getPool();

  let businessId: number;
  let scopedLocationId: number | null = null;

  if (jwtLocationId) {
    const locRes = await pool.query(
      'SELECT business_id FROM business_location WHERE id = $1',
      [jwtLocationId],
    );
    const row = locRes.rows[0];
    if (!row) throw new Error('Location not found');
    businessId = row.business_id;
    scopedLocationId = jwtLocationId;
  } else {
    const bizRes = await pool.query('SELECT id FROM business WHERE user_id = $1', [userId]);
    const row = bizRes.rows[0];
    if (!row) throw new Error('Business not found');
    businessId = row.id;
    if (filterLocationId) scopedLocationId = filterLocationId;
  }

  // Build param array and clause helpers
  const baseParams: unknown[] = [businessId];
  const locParam = scopedLocationId ? (baseParams.push(scopedLocationId), baseParams.length) : null;
  const drawParam = filterDrawId ? (baseParams.push(filterDrawId), baseParams.length) : null;

  const locationClause = locParam ? `AND location_id = $${locParam}` : '';
  const drawClause = drawParam ? `AND draw_id = $${drawParam}` : '';

  // --- Per-location breakdown (needs its own param array) ---
  const locParams: unknown[] = [businessId];
  const locLocParam = scopedLocationId ? (locParams.push(scopedLocationId), locParams.length) : null;
  const locDrawParam = filterDrawId ? (locParams.push(filterDrawId), locParams.length) : null;

  // --- Per-draw breakdown (needs its own param array) ---
  const drawsParams: unknown[] = [businessId];
  const drawsLocParam = scopedLocationId ? (drawsParams.push(scopedLocationId), drawsParams.length) : null;

  // --- Customer growth (needs its own param array) ---
  const growthParams: unknown[] = [businessId];
  const growthLocParam = scopedLocationId ? (growthParams.push(scopedLocationId), growthParams.length) : null;

  // Run all 5 independent queries in parallel
  const [summaryRes, dailyRes, monthlyRes, locRes, drawsRes, growthRes] = await Promise.all([
    // Summary KPIs
    pool.query(`
      SELECT
        COUNT(*) AS total_entries,
        COALESCE(SUM(transaction_amount), 0) AS total_revenue,
        COALESCE(AVG(transaction_amount), 0) AS avg_transaction
      FROM ticket
      WHERE business_id = $1 ${locationClause} ${drawClause}
        AND entry_source = 'receipt'
        AND is_quarantined = FALSE
    `, baseParams),

    // Daily breakdown (last 30 days)
    pool.query(`
      SELECT
        TO_CHAR(created_at, 'YYYY-MM-DD') AS date,
        COUNT(*) AS entries,
        COALESCE(SUM(transaction_amount), 0) AS revenue
      FROM ticket
      WHERE business_id = $1 ${locationClause} ${drawClause}
        AND entry_source = 'receipt'
        AND is_quarantined = FALSE
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
      ORDER BY date
    `, baseParams),

    // Monthly breakdown (last 12 months)
    pool.query(`
      SELECT
        TO_CHAR(created_at, 'YYYY-MM') AS month,
        COUNT(*) AS entries,
        COALESCE(SUM(transaction_amount), 0) AS revenue
      FROM ticket
      WHERE business_id = $1 ${locationClause} ${drawClause}
        AND entry_source = 'receipt'
        AND is_quarantined = FALSE
        AND created_at >= NOW() - INTERVAL '12 months'
      GROUP BY TO_CHAR(created_at, 'YYYY-MM')
      ORDER BY month
    `, baseParams),

    // Per-location breakdown
    pool.query(`
      SELECT
        bl.id AS location_id,
        bl.name AS location_name,
        COUNT(t.id) AS entries,
        COALESCE(SUM(t.transaction_amount), 0) AS revenue
      FROM business_location bl
      LEFT JOIN ticket t ON t.location_id = bl.id
        AND t.business_id = $1
        AND t.entry_source = 'receipt'
        AND t.is_quarantined = FALSE
        ${locDrawParam ? `AND t.draw_id = $${locDrawParam}` : ''}
      WHERE bl.business_id = $1
        ${locLocParam ? `AND bl.id = $${locLocParam}` : ''}
      GROUP BY bl.id, bl.name
      ORDER BY entries DESC
    `, locParams),

    // Per-draw breakdown
    pool.query(`
      SELECT
        d.id AS draw_id,
        d.name AS draw_name,
        TO_CHAR(d.draw_date, 'YYYY-MM-DD') AS draw_date,
        d.status AS draw_status,
        COUNT(t.id) AS entries,
        COALESCE(SUM(t.transaction_amount), 0) AS revenue
      FROM draw d
      LEFT JOIN ticket t ON t.draw_id = d.id
        AND t.business_id = $1
        AND t.entry_source = 'receipt'
        ${drawsLocParam ? `AND t.location_id = $${drawsLocParam}` : ''}
      WHERE d.status IN ('Open', 'Closed')
      GROUP BY d.id, d.name, d.draw_date, d.status
      ORDER BY d.draw_date DESC
    `, drawsParams),

    // Customer growth (new unique customers per month, last 12 months)
    pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', first_submission), 'YYYY-MM') AS month,
        COUNT(*) AS new_customers,
        SUM(COUNT(*)) OVER (ORDER BY DATE_TRUNC('month', first_submission)) AS total_customers
      FROM (
        SELECT activated_by_user_id, MIN(created_at) AS first_submission
        FROM ticket
        WHERE business_id = $1
          AND entry_source = 'receipt'
          AND activated_by_user_id IS NOT NULL
          ${growthLocParam ? `AND location_id = $${growthLocParam}` : ''}
        GROUP BY activated_by_user_id
      ) first_subs
      WHERE DATE_TRUNC('month', first_submission) >= DATE_TRUNC('month', NOW() - INTERVAL '11 months')
      GROUP BY DATE_TRUNC('month', first_submission)
      ORDER BY month
    `, growthParams),
  ]);

  const { total_entries = 0, total_revenue = 0, avg_transaction = 0 } = summaryRes.rows[0] ?? {};

  return {
    summary: {
      total_entries: Number(total_entries),
      total_revenue: parseFloat(total_revenue),
      avg_transaction: parseFloat(avg_transaction),
    },
    daily: dailyRes.rows.map(r => ({
      date: r.date,
      entries: Number(r.entries),
      revenue: parseFloat(r.revenue),
    })),
    monthly: monthlyRes.rows.map(r => ({
      month: r.month,
      entries: Number(r.entries),
      revenue: parseFloat(r.revenue),
    })),
    locations: locRes.rows.map(r => ({
      location_id: r.location_id,
      location_name: r.location_name,
      entries: Number(r.entries),
      revenue: parseFloat(r.revenue),
    })),
    draws: drawsRes.rows.map(r => ({
      draw_id: r.draw_id,
      draw_name: r.draw_name,
      draw_date: r.draw_date,
      draw_status: r.draw_status,
      entries: Number(r.entries),
      revenue: parseFloat(r.revenue),
    })),
    customer_growth: growthRes.rows.map(r => ({
      month: r.month,
      new_customers: Number(r.new_customers),
      total_customers: Number(r.total_customers),
    })),
  };
};
