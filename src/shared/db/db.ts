import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

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
