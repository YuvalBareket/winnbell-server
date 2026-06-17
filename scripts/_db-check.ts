import 'dotenv/config';
import pg from 'pg';

const main = async () => {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: true } : false,
    max: 1,
  });

  const settings = await pool.query(`SELECT allowed_states FROM platform_settings WHERE id = 1`);
  console.log('platform_settings.allowed_states =', JSON.stringify(settings.rows[0]?.allowed_states));
  console.log('');

  const users = await pool.query(
    `SELECT id, email, role, declared_state, phone_number, is_phone_verified, created_at
     FROM "user" ORDER BY created_at DESC LIMIT 10`,
  );
  console.log('Most recent users (declared_state = what region check saved at signup):');
  for (const u of users.rows) {
    console.log(
      `  id=${u.id} email=${u.email} role=${u.role} declared_state=${JSON.stringify(u.declared_state)} phone=${u.phone_number ?? '-'} verified=${u.is_phone_verified} created=${u.created_at.toISOString?.() ?? u.created_at}`,
    );
  }

  await pool.end();
};

main().catch((err) => { console.error(err); process.exit(1); });
