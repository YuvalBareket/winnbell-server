import crypto from 'crypto';
import { getPool } from '../../shared/db/db.js';

export const getBusinessesWithStats = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
        b.id,
        b.name,
        b.sector,
        b.ticket_balance,
        COUNT(t.id) AS total_tickets_created,
        SUM(CASE WHEN t.status = 'Activated' THEN 1 ELSE 0 END) AS total_activated
    FROM business b
    LEFT JOIN ticket t ON b.id = t.business_id
    GROUP BY b.id, b.name, b.sector, b.ticket_balance
  `);
  return result.rows;
};

export const getActiveDraws = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, status
    FROM draw
    WHERE status = 'Open'
  `);
  return result.rows;
};

export const generateBatchTickets = async (businessId: number, drawId: number, quantity: number) => {
  const pool = getPool();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const batchId = `BATCH_${businessId}_${Date.now()}`;
  const tickets: string[] = [];

  for (let i = 0; i < quantity; i++) {
    let code = '';
    for (let j = 0; j < 6; j++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
    tickets.push(code);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const code of tickets) {
      await client.query(
        `INSERT INTO ticket (code, business_id, draw_id, batch_id, status) VALUES ($1, $2, $3, $4, 'Issued')`,
        [code, businessId, drawId, batchId],
      );
    }
    await client.query(
      `UPDATE business SET ticket_balance = ticket_balance + $1 WHERE id = $2`,
      [quantity, businessId],
    );
    await client.query('COMMIT');
    return { batchId, count: tickets.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const createBusinessService = async (data: {
  owner_user_id: number;
  name: string;
  sector: string;
  location: string;
  latitude?: number;
  longitude?: number;
  terms_text?: string;
}) => {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO business (user_id, name, sector, location, latitude, longitude, terms_text)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [
    data.owner_user_id,
    data.name,
    data.sector,
    data.location,
    data.latitude ?? null,
    data.longitude ?? null,
    data.terms_text || 'Spend to get a ticket',
  ]);
  return result.rows[0];
};

export const getAllDrawsService = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, prize_pool AS prize_amount, prize_percentage, draw_date, status
    FROM draw
    ORDER BY draw_date DESC
  `);
  return result.rows;
};

export const createDrawService = async (data: {
  name: string;
  prize_percentage?: number;
  draw_date: string;
}) => {
  const pool = getPool();
  const prizePct = data.prize_percentage ?? 80.00;
  const result = await pool.query(`
    INSERT INTO draw (name, prize_pool, prize_percentage, draw_date, status)
    VALUES ($1, 0, $2, $3, 'Upcoming')
    RETURNING *
  `, [data.name, prizePct, new Date(data.draw_date)]);
  return result.rows[0];
};

export const openDrawService = async (drawId: number): Promise<void> => {
  const pool = getPool();
  const check = await pool.query(`SELECT id, status FROM draw WHERE id = $1`, [drawId]);

  if (check.rows.length === 0) throw new Error('Draw not found');
  if (check.rows[0].status.toUpperCase() !== 'UPCOMING') throw new Error('Only Upcoming draws can be opened');

  await pool.query(`UPDATE draw SET status = 'Open' WHERE id = $1`, [drawId]);

  // All subscribed businesses go live when a draw opens
  await pool.query(`UPDATE business SET is_participating = true WHERE is_subscribed = true`);
};

export const closeDrawService = async (drawId: number): Promise<void> => {
  const pool = getPool();
  const check = await pool.query(`SELECT id, status FROM draw WHERE id = $1`, [drawId]);

  if (check.rows.length === 0) throw new Error('Draw not found');
  if (check.rows[0].status.toUpperCase() !== 'OPEN') throw new Error('Draw is not Open');

  await pool.query(`UPDATE draw SET status = 'Closed', closed_at = NOW() WHERE id = $1`, [drawId]);
};

export const pickDrawWinnerService = async (drawId: number): Promise<{
  winnerId: number;
  winnerName: string;
  winnerEmail: string;
  ticketCode: string;
  businessName: string | null;
  locationName: string | null;
  prizePool: number;
}> => {
  const pool = getPool();
  const check = await pool.query(`SELECT id, status, prize_pool FROM draw WHERE id = $1`, [drawId]);

  if (check.rows.length === 0) throw new Error('Draw not found');
  if (check.rows[0].status.toUpperCase() !== 'CLOSED') throw new Error('Draw is not Closed');

  const prizePool: number = check.rows[0].prize_pool;

  const ticketResult = await pool.query(`
    SELECT
      t.id AS ticket_id,
      t.code,
      t.activated_by_user_id,
      u.full_name,
      u.email,
      b.name AS business_name,
      bl.name AS location_name
    FROM ticket t
    JOIN "user" u ON t.activated_by_user_id = u.id
    LEFT JOIN business b ON t.business_id = b.id
    LEFT JOIN business_location bl ON t.location_id = bl.id
    WHERE t.draw_id = $1 AND t.status = 'Activated'
    ORDER BY random()
    LIMIT 1
  `, [drawId]);

  if (ticketResult.rows.length === 0) throw new Error('No activated tickets in this draw');

  const winner = ticketResult.rows[0];
  const winnerId: number = winner.activated_by_user_id;
  const winnerTicketId: number = winner.ticket_id;

  await pool.query(
    `UPDATE draw SET winner_user_id = $1, winner_ticket_id = $2 WHERE id = $3`,
    [winnerId, winnerTicketId, drawId],
  );

  return {
    winnerId,
    winnerName: winner.full_name,
    winnerEmail: winner.email,
    ticketCode: winner.code,
    businessName: winner.business_name,
    locationName: winner.location_name,
    prizePool,
  };
};

export const getAdminOverviewService = async () => {
  const pool = getPool();

  const [usersRes, bizRes, subRes, drawRes, ticketRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total_users, SUM(CASE WHEN role='Business' THEN 1 ELSE 0 END) AS business_users, SUM(CASE WHEN role='User' THEN 1 ELSE 0 END) AS regular_users FROM "user" WHERE role != 'Admin'`),
    pool.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN is_subscribed=true THEN 1 ELSE 0 END) AS active FROM business`),
    pool.query(`SELECT COUNT(*) AS active_subs, COALESCE(SUM(fee_at_entry),0) AS total_fees FROM subscription s LEFT JOIN draw_entry de ON de.business_id=s.business_id AND de.draw_id=(SELECT id FROM draw WHERE UPPER(status)='OPEN' ORDER BY draw_date ASC LIMIT 1) WHERE UPPER(s.status)='ACTIVE'`),
    pool.query(`SELECT id, name, prize_pool, draw_date FROM draw WHERE UPPER(status)='OPEN' ORDER BY draw_date ASC LIMIT 1`),
    pool.query(`SELECT COUNT(*) AS total_tickets, SUM(CASE WHEN UPPER(status)='ACTIVATED' THEN 1 ELSE 0 END) AS activated FROM ticket WHERE draw_id=(SELECT id FROM draw WHERE UPPER(status)='OPEN' ORDER BY draw_date ASC LIMIT 1)`),
  ]);

  return {
    users: usersRes.rows[0],
    businesses: bizRes.rows[0],
    subscriptions: subRes.rows[0],
    currentDraw: drawRes.rows[0] ?? null,
    currentDrawTickets: ticketRes.rows[0],
  };
};

export const getAllUsersService = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT u.id, u.full_name, u.email, u.role, u.is_active, u.is_email_verified, u.created_at,
      b.id AS business_id, b.name AS business_name, b.is_subscribed AS business_active
    FROM "user" u
    LEFT JOIN business b ON b.user_id = u.id
    WHERE u.role != 'Admin'
    ORDER BY u.created_at DESC
  `);
  return result.rows;
};

export const updateUserRoleService = async (userId: number, role: string) => {
  const allowed = ['User', 'Business'];
  if (!allowed.includes(role)) throw new Error('Invalid role');
  const pool = getPool();
  await pool.query(
    `UPDATE "user" SET role=$1 WHERE id=$2 AND role!='Admin'`,
    [role, userId],
  );
};

export const toggleUserActiveService = async (userId: number, isActive: boolean) => {
  const pool = getPool();
  await pool.query(
    `UPDATE "user" SET is_active=$1 WHERE id=$2 AND role!='Admin'`,
    [isActive, userId],
  );
};
