/**
 * One-off migration: add registration_ip to "user" and claim_ip to free_ticket_usage.
 * Run once: node migrate_bot_protection.mjs
 */
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  await pool.query(`
    ALTER TABLE "user"
      ADD COLUMN IF NOT EXISTS registration_ip INET NULL;
  `);
  console.log('✓  user.registration_ip added');

  await pool.query(`
    ALTER TABLE free_ticket_usage
      ADD COLUMN IF NOT EXISTS claim_ip INET NULL;
  `);
  console.log('✓  free_ticket_usage.claim_ip added');

  console.log('\nMigration complete.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exit(1);
} finally {
  await pool.end();
}
