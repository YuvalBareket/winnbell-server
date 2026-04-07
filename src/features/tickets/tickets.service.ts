import { getPool, PoolClient } from '../../shared/db/db.js';
import {
  ActivationResult,
  FreeTicketStatus,
  ITicket,
} from './tickets.types.js';

export const activateTicket = async (code: string, userId: number) => {
  const pool = getPool();

  const checkResult = await pool.query(`
    SELECT t.id, t.status, d.status as draw_status
    FROM ticket t
    JOIN draw d ON t.draw_id = d.id
    WHERE t.code = $1
  `, [code]);

  const ticket = checkResult.rows[0];
  if (!ticket) throw new Error('Invalid ticket code.');
  if (ticket.draw_status?.toUpperCase() !== 'OPEN') throw new Error('The draw for this ticket is already closed.');

  const updateResult = await pool.query(`
    UPDATE ticket
    SET status = 'Activated',
        activated_by_user_id = $1,
        activated_at = NOW()
    WHERE code = $2 AND status = 'Issued'
  `, [userId, code]);

  if (updateResult.rowCount === 0) throw new Error('This ticket has already been used.');

  return { message: 'Ticket activated successfully!' };
};

export const getUserTicketsService = async (userId: number, drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      t.id, t.code, t.status, t.activated_at,
      b.name as business_name, b.sector as business_sector, b.logo_url,
      bl.name as location_name,
      d.name as draw_name
    FROM ticket t
    LEFT JOIN business b ON t.business_id = b.id
    LEFT JOIN business_location bl ON t.location_id = bl.id
    JOIN draw d ON t.draw_id = d.id
    WHERE t.activated_by_user_id = $1
    AND t.draw_id = $2
    ORDER BY t.activated_at DESC
  `, [userId, drawId]);
  return result.rows;
};

export const getBusinessTicketsService = async (userId: number, drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      t.id,
      t.code,
      t.status,
      t.activated_at,
      bl.name as location_name,
      u.full_name as activated_by_user,
      u.email as activated_by_email
    FROM ticket t
    INNER JOIN business b ON t.business_id = b.id
    LEFT JOIN business_location bl ON t.location_id = bl.id
    LEFT JOIN "user" u ON t.activated_by_user_id = u.id
    WHERE b.user_id = $1
    AND t.draw_id = $2
    ORDER BY t.created_at DESC
  `, [userId, drawId]);
  return result.rows;
};

export const getLocationTicketsService = async (userId: number, drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      t.id,
      t.code,
      t.status,
      t.activated_at,
      bl.name as location_name,
      u_act.full_name as activated_by_user,
      u_act.email as activated_by_email
    FROM ticket t
    INNER JOIN business_location bl ON t.location_id = bl.id
    LEFT JOIN "user" u_act ON t.activated_by_user_id = u_act.id
    WHERE bl.manager_user_id = $1
    AND t.draw_id = $2
    ORDER BY t.created_at DESC
  `, [userId, drawId]);
  return result.rows;
};

export const checkFreeTicketEligibility = async (userId: number): Promise<FreeTicketStatus> => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT activated_at
    FROM free_ticket_usage
    WHERE user_id = $1
    ORDER BY activated_at DESC
    LIMIT 1
  `, [userId]);

  const lastUsage = result.rows[0];

  if (!lastUsage) return { canActivate: true };

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const lastDate = new Date(lastUsage.activated_at);
  const usedThisWeek = lastDate >= weekStart;

  if (!usedThisWeek) return { canActivate: true };

  const nextSunday = new Date(weekStart);
  nextSunday.setDate(weekStart.getDate() + 7);

  return { canActivate: false, nextAvailableDate: nextSunday };
};

export const generateGlobalUniqueCode = async (client?: PoolClient): Promise<string> => {
  const MAX_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = Math.random().toString(36).substring(2, 10).toUpperCase();
    if (code.length !== 8) continue;

    const result = client
      ? await client.query(`SELECT COUNT(*) as count FROM ticket WHERE code = $1`, [code])
      : await getPool().query(`SELECT COUNT(*) as count FROM ticket WHERE code = $1`, [code]);

    if (parseInt(result.rows[0].count) === 0) return code;
  }
  throw new Error('Failed to generate a unique ticket code. Please try again.');
};

export const activateFreeTicket = async (userId: number): Promise<ActivationResult> => {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check eligibility with FOR UPDATE to prevent concurrent activations
    const eligibilityResult = await client.query(`
      SELECT activated_at
      FROM free_ticket_usage
      WHERE user_id = $1
      ORDER BY activated_at DESC
      LIMIT 1
      FOR UPDATE
    `, [userId]);

    const lastUsage = eligibilityResult.rows[0];
    if (lastUsage) {
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      weekStart.setHours(0, 0, 0, 0);
      const usedThisWeek = new Date(lastUsage.activated_at) >= weekStart;
      if (usedThisWeek) throw new Error('Weekly limit reached. Please wait until your next available date.');
    }

    const drawResult = await client.query(`
      SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1
    `);

    const activeDrawId = drawResult.rows[0]?.id;
    if (!activeDrawId) throw new Error('No active draw found. Please try again later.');

    await client.query(`INSERT INTO free_ticket_usage (user_id) VALUES ($1)`, [userId]);

    const ticketCode = await generateGlobalUniqueCode(client);

    const ticketResult = await client.query(`
      INSERT INTO ticket (code, status, business_id, activated_by_user_id, draw_id, activated_at)
      VALUES ($1, 'Activated', NULL, $2, $3, NOW())
      RETURNING id
    `, [ticketCode, userId, activeDrawId]);

    await client.query('COMMIT');

    return {
      success: true,
      ticketId: ticketResult.rows[0].id,
      code: ticketCode,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const generateTicketService = async (user_id: number, location_id: number) => {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const authInfo = await client.query(`
      SELECT bl.business_id, bl.id as location_id
      FROM business_location bl
      JOIN business b ON bl.business_id = b.id
      WHERE bl.id = $1
        AND (b.user_id = $2 OR bl.manager_user_id = $2)
        AND bl.is_active = true
        AND b.is_active = true
    `, [location_id, user_id]);

    if (authInfo.rows.length === 0) {
      throw new Error('Unauthorized or inactive location. Ticket cannot be issued.');
    }

    const { business_id } = authInfo.rows[0];

    const code = await generateGlobalUniqueCode(client);

    const drawInfo = await client.query(`
      SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1
    `);

    if (drawInfo.rows.length === 0) throw new Error('No active draw found. Please contact admin.');
    const drawId = drawInfo.rows[0].id;

    await client.query(`
      INSERT INTO ticket (code, status, business_id, location_id, draw_id, created_at)
      VALUES ($1, 'Issued', $2, $3, $4, NOW())
    `, [code, business_id, location_id, drawId]);

    await client.query('COMMIT');
    return { code };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
