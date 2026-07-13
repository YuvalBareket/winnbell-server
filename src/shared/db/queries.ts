import type { Pool, PoolClient } from 'pg';

// The subquery string for embedding inside larger SQL statements to reference the current
// open draw's id. This is a constant SQL fragment, not user input — safe for interpolation.
export const OPEN_DRAW_ID_SUBQUERY =
  `(SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1)`;

// Standalone helper: resolve the current open draw id via a single query.
// Returns null when no draw is open.
export async function getOpenDrawId(q: Pool | PoolClient): Promise<number | null> {
  const res = await (q as Pool).query(
    `SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1`,
  );
  return res.rows[0]?.id ?? null;
}
