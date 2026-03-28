import { getPool, sql } from '../../shared/db/db.js';

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
    const locRes = await pool
      .request()
      .input('locId', sql.Int, jwtLocationId)
      .query<{ business_id: number }>(
        'SELECT business_id FROM business_location WHERE id = @locId',
      );
    const row = locRes.recordset[0];
    if (!row) throw new Error('Location not found');
    businessId = row.business_id;
    scopedLocationId = jwtLocationId;
  } else {
    const bizRes = await pool
      .request()
      .input('userId', sql.Int, userId)
      .query<{ id: number }>('SELECT id FROM business WHERE user_id = @userId');
    const row = bizRes.recordset[0];
    if (!row) throw new Error('Business not found');
    businessId = row.id;
    if (filterLocationId) scopedLocationId = filterLocationId;
  }

  const locationClause = scopedLocationId ? 'AND location_id = @locationId' : '';
  const drawClause = filterDrawId ? 'AND draw_id = @drawId' : '';

  const buildReq = () => {
    const r = pool.request().input('businessId', sql.Int, businessId);
    if (scopedLocationId) r.input('locationId', sql.Int, scopedLocationId);
    if (filterDrawId) r.input('drawId', sql.Int, filterDrawId);
    return r;
  };

  // --- Summary KPIs ---
  const summaryRes = await buildReq().query<{
    total_issued: number;
    total_activated: number;
  }>(`
    SELECT
      COUNT(*) AS total_issued,
      SUM(CASE WHEN status = 'Activated' THEN 1 ELSE 0 END) AS total_activated
    FROM ticket
    WHERE business_id = @businessId ${locationClause} ${drawClause}
  `);

  const { total_issued = 0, total_activated = 0 } = summaryRes.recordset[0] ?? {};
  const activation_rate =
    total_issued > 0 ? Math.round((total_activated / total_issued) * 100) : 0;

  // --- Daily breakdown (last 30 days) ---
  const dailyRes = await buildReq().query<{
    date: string;
    issued: number;
    activated: number;
  }>(`
    SELECT
      CONVERT(varchar(10), created_at, 23) AS date,
      COUNT(*) AS issued,
      SUM(CASE WHEN status = 'Activated' THEN 1 ELSE 0 END) AS activated
    FROM ticket
    WHERE business_id = @businessId ${locationClause} ${drawClause}
      AND created_at >= DATEADD(day, -30, GETDATE())
    GROUP BY CONVERT(varchar(10), created_at, 23)
    ORDER BY date
  `);

  // --- Monthly breakdown (last 12 months) ---
  const monthlyRes = await buildReq().query<{
    month: string;
    issued: number;
    activated: number;
  }>(`
    SELECT
      FORMAT(created_at, 'yyyy-MM') AS month,
      COUNT(*) AS issued,
      SUM(CASE WHEN status = 'Activated' THEN 1 ELSE 0 END) AS activated
    FROM ticket
    WHERE business_id = @businessId ${locationClause} ${drawClause}
      AND created_at >= DATEADD(month, -12, GETDATE())
    GROUP BY FORMAT(created_at, 'yyyy-MM')
    ORDER BY month
  `);

  // --- Per-location breakdown (unfiltered by draw so it always shows all) ---
  const locReq = pool.request().input('businessId', sql.Int, businessId);
  if (scopedLocationId) locReq.input('locationId', sql.Int, scopedLocationId);
  if (filterDrawId) locReq.input('drawId', sql.Int, filterDrawId);

  const locRes = await locReq.query<{
    location_id: number;
    location_name: string;
    issued: number;
    activated: number;
  }>(`
    SELECT
      bl.id AS location_id,
      bl.name AS location_name,
      COUNT(t.id) AS issued,
      SUM(CASE WHEN t.status = 'Activated' THEN 1 ELSE 0 END) AS activated
    FROM business_location bl
    LEFT JOIN ticket t ON t.location_id = bl.id
      AND t.business_id = @businessId
      ${filterDrawId ? 'AND t.draw_id = @drawId' : ''}
    WHERE bl.business_id = @businessId
      ${scopedLocationId ? 'AND bl.id = @locationId' : ''}
    GROUP BY bl.id, bl.name
    ORDER BY issued DESC
  `);

  // --- Per-draw breakdown (always shows all draws for this business) ---
  const drawsReq = pool.request().input('businessId', sql.Int, businessId);
  if (scopedLocationId) drawsReq.input('locationId', sql.Int, scopedLocationId);

  const drawsRes = await drawsReq.query<DrawBreakdown>(`
    SELECT
      d.id AS draw_id,
      d.name AS draw_name,
      d.prize_pool AS prize_amount,
      CONVERT(varchar(10), d.draw_date, 23) AS draw_date,
      d.status AS draw_status,
      COUNT(t.id) AS issued,
      SUM(CASE WHEN t.status = 'Activated' THEN 1 ELSE 0 END) AS activated
    FROM dbo.draw d
    LEFT JOIN ticket t ON t.draw_id = d.id
      AND t.business_id = @businessId
      ${scopedLocationId ? 'AND t.location_id = @locationId' : ''}
    GROUP BY d.id, d.name, d.prize_pool, d.draw_date, d.status
    ORDER BY d.draw_date DESC
  `);

  return {
    summary: { total_issued, total_activated, activation_rate },
    daily: dailyRes.recordset,
    monthly: monthlyRes.recordset,
    locations: locRes.recordset,
    draws: drawsRes.recordset,
  };
};
