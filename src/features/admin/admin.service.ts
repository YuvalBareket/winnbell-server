import crypto from 'crypto';
import { getPool, sql } from '../../shared/db/db.js';

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
    FROM dbo.business b
    LEFT JOIN dbo.ticket t ON b.id = t.business_id
    GROUP BY b.id, b.name, b.sector, b.ticket_balance
  `);
  return result.recordset;
};

export const getActiveDraws = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, status
    FROM dbo.draw
    WHERE status = 'Open'
  `);
  return result.recordset;
};

export const generateBatchTickets = async (
  businessId: number,
  drawId: number,
  quantity: number,
) => {
  const pool = getPool();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const batchId = `BATCH_${businessId}_${Date.now()}`;
  const tickets = [];

  for (let i = 0; i < quantity; i++) {
    let code = '';
    for (let j = 0; j < 6; j++) {
      code += chars[crypto.randomInt(0, chars.length)];
    }
    tickets.push(code);
  }

  // Transaction needs the pool instance passed to it
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    for (const code of tickets) {
      await transaction
        .request()
        .input('code', sql.VarChar(6), code)
        .input('bid', sql.Int, businessId)
        .input('did', sql.Int, drawId)
        .input('batchId', sql.NVarChar(50), batchId).query(`
            INSERT INTO dbo.ticket (code, business_id, draw_id, batch_id, status)
            VALUES (@code, @bid, @did, @batchId, 'Issued')
        `);
    }

    await transaction
      .request()
      .input('bid', sql.Int, businessId)
      .input('qty', sql.Int, quantity)
      .query(
        'UPDATE dbo.business SET ticket_balance = ticket_balance + @qty WHERE id = @bid',
      );

    await transaction.commit();
    return { batchId, count: tickets.length };
  } catch (err) {
    await transaction.rollback();
    throw err;
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
  const result = await pool
    .request()
    .input('ownerId', sql.Int, data.owner_user_id)
    .input('name', sql.NVarChar, data.name)
    .input('sector', sql.NVarChar, data.sector)
    .input('location', sql.NVarChar, data.location)
    .input('lat', sql.Decimal(10, 8), data.latitude ?? null)
    .input('lng', sql.Decimal(11, 8), data.longitude ?? null)
    .input('terms', sql.NVarChar, data.terms_text || 'Spend to get a ticket').query(`
      INSERT INTO dbo.business (user_id, name, sector, location, latitude, longitude, terms_text)
      OUTPUT inserted.*
      VALUES (@ownerId, @name, @sector, @location, @lat, @lng, @terms)
    `);

  return result.recordset[0];
};
export const getAllDrawsService = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, prize_pool AS prize_amount, prize_percentage, draw_date, status
    FROM dbo.draw
    ORDER BY draw_date DESC
  `);
  return result.recordset;
};

export const createDrawService = async (data: {
  name: string;
  prize_percentage?: number;
  draw_date: string;
}) => {
  const pool = getPool();
  const prizePct = data.prize_percentage ?? 80.00;
  const result = await pool
    .request()
    .input('name', sql.NVarChar(100), data.name)
    .input('prizePct', sql.Decimal(5, 2), prizePct)
    .input('drawDate', sql.DateTime, new Date(data.draw_date))
    .query(`
      INSERT INTO dbo.draw (name, prize_pool, prize_percentage, draw_date, status)
      OUTPUT inserted.*
      VALUES (@name, 0, @prizePct, @drawDate, 'Upcoming')
    `);
  return result.recordset[0];
};

export const openDrawService = async (drawId: number): Promise<void> => {
  const pool = getPool();
  const check = await pool
    .request()
    .input('drawId', sql.Int, drawId)
    .query(`SELECT id, status FROM dbo.draw WHERE id = @drawId`);

  if (check.recordset.length === 0) {
    throw new Error('Draw not found');
  }
  if (check.recordset[0].status.toUpperCase() !== 'UPCOMING') {
    throw new Error('Only Upcoming draws can be opened');
  }

  await pool
    .request()
    .input('drawId', sql.Int, drawId)
    .query(`UPDATE dbo.draw SET status = 'Open' WHERE id = @drawId`);
};

export const closeDrawService = async (drawId: number): Promise<void> => {
  const pool = getPool();
  const check = await pool
    .request()
    .input('drawId', sql.Int, drawId)
    .query(`SELECT id, status FROM dbo.draw WHERE id = @drawId`);

  if (check.recordset.length === 0) {
    throw new Error('Draw not found');
  }
  if (check.recordset[0].status.toUpperCase() !== 'OPEN') {
    throw new Error('Draw is not Open');
  }

  await pool
    .request()
    .input('drawId', sql.Int, drawId)
    .query(`UPDATE dbo.draw SET status = 'Closed', closed_at = GETDATE() WHERE id = @drawId`);
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
  const check = await pool
    .request()
    .input('drawId', sql.Int, drawId)
    .query(`SELECT id, status, prize_pool FROM dbo.draw WHERE id = @drawId`);

  if (check.recordset.length === 0) {
    throw new Error('Draw not found');
  }
  if (check.recordset[0].status.toUpperCase() !== 'CLOSED') {
    throw new Error('Draw is not Closed');
  }

  const prizePool: number = check.recordset[0].prize_pool;

  const ticketResult = await pool
    .request()
    .input('drawId', sql.Int, drawId)
    .query(`
      SELECT TOP 1
        t.id AS ticket_id,
        t.code,
        t.activated_by_user_id,
        u.full_name,
        u.email,
        b.name AS business_name,
        bl.name AS location_name
      FROM ticket t
      JOIN [user] u ON t.activated_by_user_id = u.id
      LEFT JOIN business b ON t.business_id = b.id
      LEFT JOIN business_location bl ON t.location_id = bl.id
      WHERE t.draw_id = @drawId AND t.status = 'Activated'
      ORDER BY NEWID()
    `);

  if (ticketResult.recordset.length === 0) {
    throw new Error('No activated tickets in this draw');
  }

  const winner = ticketResult.recordset[0];
  const winnerId: number = winner.activated_by_user_id;
  const winnerTicketId: number = winner.ticket_id;

  await pool
    .request()
    .input('winnerId', sql.Int, winnerId)
    .input('winnerTicketId', sql.Int, winnerTicketId)
    .input('drawId', sql.Int, drawId)
    .query(`UPDATE dbo.draw SET winner_user_id = @winnerId, winner_ticket_id = @winnerTicketId WHERE id = @drawId`);

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
