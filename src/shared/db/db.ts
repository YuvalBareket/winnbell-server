import pg, { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// TIMESTAMP WITHOUT TIME ZONE values are stored as UTC in Neon but pg parses them
// using the Node.js process local timezone, which causes a shift when the server
// runs outside UTC (e.g. local dev in Israel UTC+3). Appending 'Z' forces UTC parsing.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (val: string) => new Date(val + 'Z'));

let pool: Pool;

export const connectDB = async () => {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Neon serverless Postgres requires SSL; rejectUnauthorized is true by default when using
      // the full Neon connection string which includes `sslmode=require`.
      ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: true } : false,
      max: 10,
      idleTimeoutMillis: 30000,
    });
    const client = await pool.connect();
    client.release();
    console.log('✅ Connected to PostgreSQL (Neon)');
    return pool;
  } catch (err) {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  }
};

export const getPool = (): Pool => {
  if (!pool) {
    throw new Error('Database pool has not been initialized. Call connectDB first.');
  }
  return pool;
};

export type { Pool, PoolClient };
