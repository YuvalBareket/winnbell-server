import pg, { Pool, PoolClient } from 'pg';

// TIMESTAMP WITHOUT TIME ZONE values are stored as UTC in Neon but pg parses them
// using the Node.js process local timezone, which causes a shift when the server
// runs outside UTC (e.g. local dev in Israel UTC+3). Appending 'Z' forces UTC parsing.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (val: string) => new Date(val + 'Z'));

// BIGINT (ticket.id and its FK columns are 64-bit): pg returns int8 as a STRING by default,
// which silently breaks number comparisons and JSON payload types. Parse to number - safe here
// because ids stay far below Number.MAX_SAFE_INTEGER (2^53).
pg.types.setTypeParser(pg.types.builtins.INT8, (val: string) => parseInt(val, 10));

let pool: Pool;

export const connectDB = async () => {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: true } : false,
      max: 10,
      // Release idle connections after 10s — Neon terminates them after ~5 min of inactivity,
      // so keeping them shorter prevents 57P01 "connection terminated" errors on the next query.
      idleTimeoutMillis: 10000,
      // If a connection cannot be established within 5s, fail fast rather than hanging.
      connectionTimeoutMillis: 5000,
      // Kill any query that runs longer than 10s — prevents hung queries from exhausting the pool.
      statement_timeout: 10000,
    });

    // Prevent terminated Neon connections from crashing the process.
    // The pool will automatically create a fresh connection on the next query.
    pool.on('error', (err) => {
      console.error('[Pool] Idle client error (connection dropped by Neon):', err.message);
    });

    const client = await pool.connect();
    client.release();
    console.log('✅ Connected to PostgreSQL (Neon)');

    // Graceful shutdown: close all connections before exit
    const shutdown = async (signal: string) => {
      console.log(`[DB] ${signal} received, closing pool...`);
      await pool.end();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

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
