import { getPool, sql } from '../../shared/db/db.js';
import {
  ActivationResult,
  FreeTicketStatus,
  ITicket,
} from './tickets.types.js';

export const activateTicket = async (code: string, userId: number) => {
  const pool = getPool();

  // 1. Check if ticket exists and is available
  const ticketResult = await pool.request().input('code', code).query(`
      SELECT t.id, t.status, d.status as draw_status 
      FROM dbo.ticket t
      JOIN dbo.draw d ON t.draw_id = d.id
      WHERE t.code = @code
    `);

  const ticket = ticketResult.recordset[0];

  if (!ticket) throw new Error('Invalid ticket code.');
  if (ticket.status === 'Activated')
    throw new Error('This ticket has already been used.');
  if (!(ticket.draw_status !== 'Open'))
    throw new Error('The draw for this ticket is already closed.');

  // 2. Update the ticket status
  await pool.request().input('code', code).input('userId', userId).query(`
      UPDATE dbo.ticket 
      SET status = 'Activated', 
          activated_by_user_id = @userId, 
          activated_at = GETDATE()
      WHERE code = @code
    `);

  return { message: 'Ticket activated successfully!' };
};
export const getUserTicketsService = async (userId: number, drawId: number) => {
  const pool = getPool();
  const query = `
    SELECT 
      t.id, t.code, t.status, t.activated_at,
      b.name as business_name, b.sector as business_sector,
      d.name as draw_name
    FROM ticket t
   LEFT JOIN business b ON t.business_id = b.id
    JOIN draw d ON t.draw_id = d.id
    WHERE t.activated_by_user_id = @userId
    AND  t.draw_id=@drawId
    ORDER BY t.activated_at DESC
  `;

  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('drawId', sql.Int, drawId)

    .query(query);

  return result.recordset;
};
export const getBusinessTicketsService = async (
  userId: number,
  drawId: number,
) => {
  const pool = getPool();

  const query = `
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
    LEFT JOIN [user] u ON t.activated_by_user_id = u.id
    WHERE b.user_id = @userId 
    AND t.draw_id = @drawId
    ORDER BY t.created_at DESC
  `;

  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('drawId', sql.Int, drawId)
    .query(query);

  return result.recordset;
};
export const checkFreeTicketEligibility = async (
  userId: number,
): Promise<FreeTicketStatus> => {
  const pool = getPool();

  // Look for the most recent activation
  const result = await pool.request().input('userId', sql.Int, userId).query(`
      SELECT TOP 1 activated_at 
      FROM free_ticket_usage 
      WHERE user_id = @userId 
      ORDER BY activated_at DESC
    `);

  const lastUsage = result.recordset[0];

  if (!lastUsage) {
    return { canActivate: true };
  }

  const lastDate = new Date(lastUsage.activated_at);
  const nextAvailable = new Date(lastDate.getTime() + 7 * 24 * 60 * 60 * 1000);
  const canActivate = new Date() >= nextAvailable;

  return {
    canActivate,
    nextAvailableDate: !canActivate ? nextAvailable : undefined,
  };
};
export const generateGlobalUniqueCode = async (
  transaction?: sql.Transaction,
): Promise<string> => {
  // Use the transaction's request if provided, otherwise use the pool's request
  const connection = transaction || getPool();

  let isUnique = false;
  let code = '';

  while (!isUnique) {
    // Generate 8-char alphanumeric
    code = Math.random().toString(36).substring(2, 10).toUpperCase();

    // Ensure we got exactly 8 (handles edge cases where Math.random is small)
    if (code.length !== 8) continue;

    const result = await connection
      .request()
      .input('code', sql.VarChar(8), code)
      .query(`SELECT COUNT(*) as count FROM ticket WHERE code = @code`);

    if (result.recordset[0].count === 0) {
      isUnique = true;
    }
  }

  return code;
};
export const activateFreeTicket = async (
  userId: number,
): Promise<ActivationResult> => {
  const pool = getPool();
  const transaction = new sql.Transaction(pool);

  try {
    // 1. Check Eligibility
    const eligibility = await checkFreeTicketEligibility(userId);
    if (!eligibility.canActivate) {
      throw new Error(
        'Weekly limit reached. Please wait until your next available date.',
      );
    }

    // 2. Fetch the latest Active Draw
    const drawResult = await pool.request().query(`
        SELECT TOP 1 id 
        FROM draw 
        WHERE status = 'Open' AND draw_date > GETDATE() 
        ORDER BY draw_date ASC
      `);

    const activeDrawId = drawResult.recordset[0]?.id;

    if (!activeDrawId) {
      throw new Error('No active draw found. Please try again later.');
    }

    await transaction.begin();

    // 3. Log the free ticket usage
    await transaction
      .request()
      .input('userId', sql.Int, userId)
      .query(`INSERT INTO free_ticket_usage (user_id) VALUES (@userId)`);

    // 4. Generate Code
    const ticketCode = await generateGlobalUniqueCode(transaction);
    // 5. Create the ticket record (business_id set to NULL)
    const ticketResult = await transaction
      .request()
      .input('code', sql.VarChar(8), ticketCode)
      .input('status', sql.VarChar(20), 'Activated')
      .input('userId', sql.Int, userId)
      .input('drawId', sql.Int, activeDrawId).query(`
        INSERT INTO ticket (code, status, business_id, activated_by_user_id, draw_id, activated_at)
        OUTPUT INSERTED.id
        VALUES (@code, @status, NULL, @userId, @drawId, GETDATE())
      `);

    await transaction.commit();

    return {
      success: true,
      ticketId: ticketResult.recordset[0].id,
      code: ticketCode,
    };
  } catch (err) {
    await transaction.rollback();

    throw err;
  }
};

export const generateTicketService = async (
  user_id: number,
  location_id: number,
) => {
  const pool = getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // 1. Security Check: Does this user own the business OR manage this location?
    const authInfo = await transaction
      .request()
      .input('u_id', sql.Int, user_id)
      .input('l_id', sql.Int, location_id).query(`
        SELECT bl.business_id, bl.id as location_id
        FROM business_location bl
        JOIN business b ON bl.business_id = b.id
        WHERE bl.id = @l_id 
        AND (b.user_id = @u_id OR bl.user_id = @u_id) 
        AND bl.is_active = 1
      `);

    if (authInfo.recordset.length === 0) {
      throw new Error(
        'Unauthorized or inactive location. Ticket cannot be issued.',
      );
    }

    const { business_id } = authInfo.recordset[0];

    // 2. Generate unique 8-char code
    const code = await generateGlobalUniqueCode(transaction);

    // 3. Get the next Open draw
    const drawInfo = await transaction.request().query(`
        SELECT TOP 1 id FROM draw 
        WHERE status = 'Open' 
        ORDER BY draw_date ASC
    `);

    if (drawInfo.recordset.length === 0) {
      throw new Error('No active draw found. Please contact admin.');
    }
    const drawId = drawInfo.recordset[0].id;

    // 4. Insert the ticket linked to the provided location
    await transaction
      .request()
      .input('Code', sql.NVarChar(8), code)
      .input('BusinessId', sql.Int, business_id)
      .input('LocationId', sql.Int, location_id)
      .input('DrawId', sql.Int, drawId).query(`
        INSERT INTO ticket (code, status, business_id, location_id, draw_id, created_at)
        VALUES (@Code, 'Issued', @BusinessId, @LocationId, @DrawId, CURRENT_TIMESTAMP)
      `);

    await transaction.commit();
    return { code };
  } catch (error) {
    if (transaction) await transaction.rollback();
    throw error;
  }
};
