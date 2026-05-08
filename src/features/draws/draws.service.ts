import { getPool } from '../../shared/db/db.js';

export const getActiveDrawService = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, prize_pool AS prize_amount, draw_date, status
    FROM draw
    WHERE status = 'Open'
    ORDER BY draw_date ASC
  `);
  return result.rows;
};

export const getDrawHistoryService = async () => {
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
      u.full_name AS winner_name,
      b.name AS winner_business_name,
      bl.name AS winner_location_name,
      COUNT(t.id) AS entry_count
    FROM draw d
    LEFT JOIN ticket wt ON wt.id = d.winner_ticket_id
    LEFT JOIN "user" u ON wt.activated_by_user_id = u.id
    LEFT JOIN business b ON wt.business_id = b.id
    LEFT JOIN business_location bl ON wt.location_id = bl.id
    LEFT JOIN ticket t ON t.draw_id = d.id
    GROUP BY d.id, wt.id, u.id, b.id, bl.id
    ORDER BY d.draw_date DESC
  `);
  return result.rows;
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
      u.full_name AS winner_name,
      b.name AS winner_business_name,
      bl.name AS winner_location_name
    FROM draw d
    LEFT JOIN ticket wt ON wt.id = d.winner_ticket_id
    LEFT JOIN "user" u ON wt.activated_by_user_id = u.id
    LEFT JOIN business b ON wt.business_id = b.id
    LEFT JOIN business_location bl ON wt.location_id = bl.id
    WHERE d.id = $1
  `, [drawId]);
  if (!result.rows[0]) throw new Error('Draw not found');
  return result.rows[0];
};
