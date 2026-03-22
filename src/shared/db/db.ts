import sql from 'mssql';
import dotenv from 'dotenv';

dotenv.config();

const sqlConfig: sql.config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  server: process.env.DB_SERVER || 'localhost',
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
  options: {
    encrypt: true,
    trustServerCertificate: true,
  },
};

// Create a variable to hold the pool instance
let pool: sql.ConnectionPool;

export const connectDB = async () => {
  try {
    // Assign the connected pool to our variable
    pool = await sql.connect(sqlConfig);
    console.log('✅ Connected to SQL Server');
    return pool;
  } catch (err) {
    console.error('❌ Database connection failed:', err);
    process.exit(1);
  }
};

// Now getPool returns the active connection pool instance
export const getPool = () => {
  if (!pool) {
    throw new Error(
      'Database pool has not been initialized. Call connectDB first.',
    );
  }
  return pool;
};

// Export the library as well for Types/Transactions
export { sql };
