/**
 * Diagnostic: shows current allowed_states and runs the real region logic
 * against sample IPs via ipinfo.io.
 *
 * Run from server/:  npx tsx scripts/verify-region-check.ts
 */
import 'dotenv/config';
import pg from 'pg';
import { getRegionFromIp } from '../src/features/auth/auth.service.js';

const main = async () => {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: true } : false,
    max: 1,
  });

  const settings = await pool.query(`SELECT allowed_states FROM platform_settings WHERE id = 1`);
  const allowed: string[] = settings.rows[0]?.allowed_states ?? [];
  console.log('platform_settings.allowed_states =', JSON.stringify(allowed));
  console.log('IPINFO_TOKEN configured:', !!process.env.IPINFO_TOKEN);
  console.log('');

  const samples: Array<[string, string]> = [
    ['4.2.2.2',         'US backbone (Level3)'],
    ['128.227.1.1',     'University of Florida (US/FL)'],
    ['199.44.62.1',     'Georgia Tech-ish (US/GA)'],
    ['82.80.1.1',       'Israel (IL)'],
    ['::1',             'localhost (detection should fail -> fail open)'],
  ];

  for (const [ip, label] of samples) {
    const region = await getRegionFromIp(ip);
    let blocked: boolean;
    if (allowed.length === 0) blocked = false;
    else if (!region.country) blocked = false;
    else if (region.country !== 'US') blocked = true;
    else if (!region.stateCode) blocked = false;
    else blocked = !allowed.includes(region.stateCode);
    console.log(
      `${ip.padEnd(15)} ${label.padEnd(45)} -> country=${String(region.country).padEnd(5)} state=${String(region.stateCode).padEnd(5)} blocked=${blocked}`,
    );
  }

  await pool.end();
};

main().catch((err) => { console.error(err); process.exit(1); });
