import { getPool } from '../../shared/db/db.js';
import { publicCache } from '../../shared/cache/cache.js';

export const getActiveDrawService = async () => {
  const CACHE_KEY = 'draws:active';
  const cached = publicCache.get<Record<string, unknown>[]>(CACHE_KEY);
  if (cached !== undefined) return cached;

  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, prize_pool AS prize_amount, draw_date, status
    FROM draw
    WHERE status = 'Open'
    ORDER BY draw_date ASC
  `);
  publicCache.set(CACHE_KEY, result.rows, 60);
  return result.rows;
};

export const getDrawHistoryService = async () => {
  const CACHE_KEY = 'draws:history';
  const cached = publicCache.get<Record<string, unknown>[]>(CACHE_KEY);
  if (cached !== undefined) return cached;

  const pool = getPool();
  const result = await pool.query(`
    SELECT
      d.id,
      d.name,
      d.prize_pool AS prize_amount,
      d.draw_date,
      d.status,
      d.closed_at,
      wt.code AS winning_ticket_code,
      CASE WHEN u.full_name IS NOT NULL THEN CONCAT(SPLIT_PART(u.full_name, ' ', 1), ' ', LEFT(SPLIT_PART(u.full_name, ' ', 2), 1), '.') END AS winner_name,
      b.name AS winner_business_name,
      bl.name AS winner_location_name,
      COUNT(t.id) AS entry_count
    FROM draw d
    LEFT JOIN ticket wt ON wt.id = d.winner_ticket_id AND d.winner_confirmed = TRUE
    LEFT JOIN "user" u ON wt.activated_by_user_id = u.id
    LEFT JOIN business b ON wt.business_id = b.id
    LEFT JOIN business_location bl ON wt.location_id = bl.id
    LEFT JOIN ticket t ON t.draw_id = d.id
    GROUP BY d.id, wt.id, u.id, b.id, bl.id
    ORDER BY d.draw_date DESC
    LIMIT 50
  `);
  publicCache.set(CACHE_KEY, result.rows, 300);
  return result.rows;
};

export const getDrawByIdService = async (drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, prize_pool AS prize_amount, draw_date, status
    FROM draw
    WHERE id = $1
  `, [drawId]);
  return result.rows[0] ?? null;
};

export const getDrawResultService = async (drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      d.id,
      d.name,
      d.prize_pool AS prize_amount,
      d.draw_date,
      d.status,
      d.closed_at,
      wt.code AS winning_ticket_code,
      CASE WHEN u.full_name IS NOT NULL THEN CONCAT(SPLIT_PART(u.full_name, ' ', 1), ' ', LEFT(SPLIT_PART(u.full_name, ' ', 2), 1), '.') END AS winner_name,
      b.name AS winner_business_name,
      bl.name AS winner_location_name
    FROM draw d
    LEFT JOIN ticket wt ON wt.id = d.winner_ticket_id AND d.winner_confirmed = TRUE
    LEFT JOIN "user" u ON wt.activated_by_user_id = u.id
    LEFT JOIN business b ON wt.business_id = b.id
    LEFT JOIN business_location bl ON wt.location_id = bl.id
    WHERE d.id = $1
  `, [drawId]);
  if (!result.rows[0]) throw new Error('Draw not found');
  return result.rows[0];
};
