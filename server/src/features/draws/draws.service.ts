import { getPool } from '../../shared/db/db.js';

export const getActiveDrawService = async () => {
  const pool = getPool();
  const query = `SELECT  * FROM draw WHERE status = 'Open'
  AND draw_date>CAST(GETDATE() AS date)
  ORDER BY draw_date ASC`;
  const result = await pool.request().query(query);
  return result.recordset;
};
