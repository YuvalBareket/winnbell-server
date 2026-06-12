import 'dotenv/config';
import pg from 'pg';
const main = async () => {
  const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 1 });
  const r = await p.query(`SELECT id, email FROM "user" WHERE email != LOWER(email)`);
  console.log('mixed-case emails:', JSON.stringify(r.rows));
  if (r.rows.length > 0) {
    // Only safe to lowercase when no lowercase twin exists
    const fixed = await p.query(`
      UPDATE "user" u SET email = LOWER(email)
      WHERE email != LOWER(email)
        AND NOT EXISTS (SELECT 1 FROM "user" t WHERE t.email = LOWER(u.email))
      RETURNING id, email`);
    console.log('normalized:', JSON.stringify(fixed.rows));
  }
  await p.end();
};
main().catch((e) => { console.error(e); process.exit(1); });
