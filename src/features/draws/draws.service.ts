import { getPool } from '../../shared/db/db.js';

export const getActiveDrawService = async () => {
  const pool = getPool();
  const query = `SELECT id, name, prize_name, prize_amount, draw_date, status
  FROM draw
  WHERE status = 'Open' AND draw_date > CAST(GETDATE() AS date)
  ORDER BY draw_date ASC`;
  const result = await pool.request().query(query);
  return result.recordset;
};
