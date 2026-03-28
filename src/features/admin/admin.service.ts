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
    SELECT id, name, prize_name, status 
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
      INSERT INTO dbo.business (owner_user_id, name, sector, location, latitude, longitude, terms_text)
      OUTPUT inserted.*
      VALUES (@ownerId, @name, @sector, @location, @lat, @lng, @terms)
    `);

  return result.recordset[0];
};
export const getAllDrawsService = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, prize_name, prize_amount, draw_date, status 
    FROM dbo.draw 
    ORDER BY draw_date DESC
  `);
  return result.recordset;
};

export const createDrawService = async (data: {
  name: string;
  prize_name: string;
  prize_amount: number;
  draw_date: string;
}) => {
  const pool = getPool();
  const result = await pool
    .request()
    .input('name', sql.NVarChar(100), data.name)
    .input('prizeName', sql.NVarChar(100), data.prize_name)
    .input('prizeAmount', sql.Decimal(12, 2), data.prize_amount)
    .input('drawDate', sql.DateTime, new Date(data.draw_date))
    .query(`
      INSERT INTO dbo.draw (name, prize_name, prize_amount, draw_date, status)
      OUTPUT inserted.*
      VALUES (@name, @prizeName, @prizeAmount, @drawDate, 'Open')
    `);
  return result.recordset[0];
};
