import { getPool } from '../../shared/db/db.js';

export interface DrawBreakdown {
  draw_id: number;
  draw_name: string;
  prize_amount: number;
  draw_date: string;
  draw_status: string;
  issued: number;
  activated: number;
}

export interface StatsResult {
  summary: {
    total_issued: number;
    total_activated: number;
    activation_rate: number;
  };
  daily: Array<{ date: string; issued: number; activated: number }>;
  monthly: Array<{ month: string; issued: number; activated: number }>;
  locations: Array<{
    location_id: number;
    location_name: string;
    issued: number;
    activated: number;
  }>;
  draws: DrawBreakdown[];
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

  // --- Summary KPIs ---
  const summaryRes = await pool.query(`
    SELECT
      COUNT(*) AS total_issued,
      SUM(CASE WHEN status = 'Activated' THEN 1 ELSE 0 END) AS total_activated
    FROM ticket
    WHERE business_id = $1 ${locationClause} ${drawClause}
  `, baseParams);

  const { total_issued = 0, total_activated = 0 } = summaryRes.rows[0] ?? {};
  const activation_rate =
    total_issued > 0 ? Math.round((total_activated / total_issued) * 100) : 0;

  // --- Daily breakdown (last 30 days) ---
  const dailyRes = await pool.query(`
    SELECT
      TO_CHAR(created_at, 'YYYY-MM-DD') AS date,
      COUNT(*) AS issued,
      SUM(CASE WHEN status = 'Activated' THEN 1 ELSE 0 END) AS activated
    FROM ticket
    WHERE business_id = $1 ${locationClause} ${drawClause}
      AND created_at >= NOW() - INTERVAL '30 days'
    GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
    ORDER BY date
  `, baseParams);

  // --- Monthly breakdown (last 12 months) ---
  const monthlyRes = await pool.query(`
    SELECT
      TO_CHAR(created_at, 'YYYY-MM') AS month,
      COUNT(*) AS issued,
      SUM(CASE WHEN status = 'Activated' THEN 1 ELSE 0 END) AS activated
    FROM ticket
    WHERE business_id = $1 ${locationClause} ${drawClause}
      AND created_at >= NOW() - INTERVAL '12 months'
    GROUP BY TO_CHAR(created_at, 'YYYY-MM')
    ORDER BY month
  `, baseParams);

  // --- Per-location breakdown ---
  const locParams: unknown[] = [businessId];
  const locLocParam = scopedLocationId ? (locParams.push(scopedLocationId), locParams.length) : null;
  const locDrawParam = filterDrawId ? (locParams.push(filterDrawId), locParams.length) : null;

  const locRes = await pool.query(`
    SELECT
      bl.id AS location_id,
      bl.name AS location_name,
      COUNT(t.id) AS issued,
      SUM(CASE WHEN t.status = 'Activated' THEN 1 ELSE 0 END) AS activated
    FROM business_location bl
    LEFT JOIN ticket t ON t.location_id = bl.id
      AND t.business_id = $1
      ${locDrawParam ? `AND t.draw_id = $${locDrawParam}` : ''}
    WHERE bl.business_id = $1
      ${locLocParam ? `AND bl.id = $${locLocParam}` : ''}
    GROUP BY bl.id, bl.name
    ORDER BY issued DESC
  `, locParams);

  // --- Per-draw breakdown ---
  const drawsParams: unknown[] = [businessId];
  const drawsLocParam = scopedLocationId ? (drawsParams.push(scopedLocationId), drawsParams.length) : null;

  const drawsRes = await pool.query(`
    SELECT
      d.id AS draw_id,
      d.name AS draw_name,
      d.prize_pool AS prize_amount,
      TO_CHAR(d.draw_date, 'YYYY-MM-DD') AS draw_date,
      d.status AS draw_status,
      COUNT(t.id) AS issued,
      SUM(CASE WHEN t.status = 'Activated' THEN 1 ELSE 0 END) AS activated
    FROM draw d
    LEFT JOIN ticket t ON t.draw_id = d.id
      AND t.business_id = $1
      ${drawsLocParam ? `AND t.location_id = $${drawsLocParam}` : ''}
    WHERE UPPER(d.status) IN ('OPEN', 'CLOSED')
    GROUP BY d.id, d.name, d.prize_pool, d.draw_date, d.status
    ORDER BY d.draw_date DESC
  `, drawsParams);

  return {
    summary: { total_issued, total_activated, activation_rate },
    daily: dailyRes.rows,
    monthly: monthlyRes.rows,
    locations: locRes.rows,
    draws: drawsRes.rows,
  };
};
