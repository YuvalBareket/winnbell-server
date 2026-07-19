/**
 * seed-ux-personas.cjs — UX testing session seed (2026-07-02)
 *
 * Creates ~27 persona accounts covering every distinct account state, opens a
 * July 2026 draw via the real admin API, and writes e2e/ux-500/personas.json
 * with minted internal JWTs for browser auth injection.
 *
 * Idempotent: safe to re-run (upserts by email / unique keys).
 * Run: node scripts/seed-ux-personas.cjs   (cwd = server/)
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const API = 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('JWT_SECRET missing'); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true } });
const PW = 'Wbll-UX#2026!';
const NOW = Date.now();
const day = 86400000;

// Manhattan-ish coords for map testing
const COORDS = [
  [40.7580, -73.9855], [40.7484, -73.9857], [40.7306, -73.9866],
  [40.7128, -74.0060], [40.7614, -73.9776], [40.7527, -73.9772],
  [40.7295, -73.9965], [40.7411, -73.9897], [40.7677, -73.9718],
];

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

async function q(text, params) { return pool.query(text, params); }

async function upsertUser(key, { fullName, role = 'User', phoneVerified = true, phone, riskScore = 0, referralCode = null }) {
  const email = `ux.${key}@e2e.winnbell.com`;
  const hash = await bcrypt.hash(PW, 10);
  const r = await q(
    `INSERT INTO "user" (email, full_name, password_hash, role, is_active, is_email_verified,
                         phone_number, is_phone_verified, risk_score, referral_code, declared_state, city,
                         date_of_birth, gender, state)
     VALUES ($1,$2,$3,$4,TRUE,TRUE,$5,$6,$7,$8,'NY','New York','1995-06-15','Prefer not to say','FL')
     ON CONFLICT (email) DO UPDATE SET
       full_name=$2, role=$4, is_active=TRUE, phone_number=$5, is_phone_verified=$6,
       risk_score=$7, referral_code=COALESCE($8, "user".referral_code),
       date_of_birth=COALESCE("user".date_of_birth, EXCLUDED.date_of_birth),
       gender=COALESCE("user".gender, EXCLUDED.gender),
       state=COALESCE("user".state, EXCLUDED.state)
     RETURNING id, email, full_name, role, is_phone_verified`,
    [email, fullName, hash, role, phone ?? null, phoneVerified, riskScore, referralCode],
  );
  const u = r.rows[0];
  await q(`INSERT INTO user_acquisition (user_id, source) VALUES ($1,'direct') ON CONFLICT (user_id) DO NOTHING`, [u.id]);
  return u;
}

async function ensureBusiness(ownerId, { name, sector = 'Food', description, minAmount = 20 }) {
  const r = await q(
    `INSERT INTO business (user_id, name, sector, description, min_transaction_amount, terms_text)
     SELECT $1,$2,$3,$4,$5,'Standard campaign terms apply. One entry per qualifying purchase.'
     WHERE NOT EXISTS (SELECT 1 FROM business WHERE user_id=$1)
     RETURNING id`,
    [ownerId, name, sector, description, minAmount],
  );
  if (r.rows[0]) return r.rows[0].id;
  return (await q(`SELECT id FROM business WHERE user_id=$1`, [ownerId])).rows[0].id;
}

async function ensureLocation(bizId, name, address, [lat, lon]) {
  const r = await q(
    `INSERT INTO business_location (business_id, name, address, latitude, longitude, is_active)
     SELECT $1,$2,$3,$4,$5,TRUE
     WHERE NOT EXISTS (SELECT 1 FROM business_location WHERE business_id=$1 AND name=$2)
     RETURNING id`,
    [bizId, name, address, lat, lon],
  );
  if (r.rows[0]) return r.rows[0].id;
  return (await q(`SELECT id FROM business_location WHERE business_id=$1 AND name=$2`, [bizId, name])).rows[0].id;
}

async function ensureSubscription(bizId, { status = 'Active', perLoc = 250, fee = 250 }) {
  await q(
    `INSERT INTO subscription (business_id, status, entries_per_location, fee_at_entry, current_period_end)
     VALUES ($1,$2,$3,$4, NOW() + INTERVAL '29 days')
     ON CONFLICT (business_id) DO UPDATE SET status=$2, entries_per_location=$3, fee_at_entry=$4`,
    [bizId, status, perLoc, fee],
  );
}

async function enroll(drawId, bizId, fee = 250) {
  await q(`INSERT INTO draw_entry (draw_id, business_id, fee_at_entry) VALUES ($1,$2,$3)
           ON CONFLICT (draw_id, business_id) DO NOTHING`, [drawId, bizId, fee]);
}

let ticketSeq = 0;
async function ticket({ userId, bizId = null, locId = null, drawId, source = 'receipt', amount = null,
                        daysAgo = 0, quarantined = false, reason = null, receiptId = null }) {
  ticketSeq++;
  const when = new Date(NOW - daysAgo * day - (ticketSeq % 12) * 3600000);
  for (let i = 0; i < 5; i++) {
    try {
      const r = await q(
        `INSERT INTO ticket (code, status, entry_source, business_id, location_id, draw_id,
                             activated_by_user_id, activated_at, created_at,
                             receipt_identifier, transaction_amount, transaction_date,
                             is_quarantined, quarantine_reason, quarantined_at, image_validation_status)
         VALUES ($1,'Activated',$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,'not_required')
         RETURNING id`,
        [code(), source, bizId, locId, drawId, userId, when,
         source === 'receipt' ? (receiptId ?? `UX-${code(6)}`) : null,
         amount, source === 'receipt' ? when.toISOString().slice(0, 10) : null,
         quarantined, reason, quarantined ? when : null],
      );
      return r.rows[0].id;
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  throw new Error('ticket code collision x5');
}

function mintToken(user, locationId = null) {
  return jwt.sign({ id: user.id, role: user.role, location_id: locationId }, JWT_SECRET, { expiresIn: '7d' });
}

(async () => {
  const out = {};
  const add = (key, u, extra = {}) => {
    out[key] = {
      key, id: u.id, email: u.email, role: u.role,
      location_id: extra.location_id ?? null,
      token: mintToken(u, extra.location_id ?? null),
      user: {
        id: u.id, fullName: u.full_name, email: u.email, role: u.role,
        location_id: extra.location_id ?? null,
        business_id: extra.business_id ?? null,
        requiresBusinessSetup: extra.requiresBusinessSetup ?? false,
        businessIsActive: extra.businessIsActive ?? false,
        businessLogoUrl: null,
        isPhoneVerified: u.is_phone_verified,
        created_at: new Date().toISOString(),
      },
    };
  };

  // ── Admins ──────────────────────────────────────────────────────────────────
  const admin1 = await upsertUser('admin1', { fullName: 'Ava Admin', role: 'Admin', phone: '+15550000001' });
  const admin2 = await upsertUser('admin2', { fullName: 'Adam Admin', role: 'Admin', phone: '+15550000002' });
  add('admin1', admin1); add('admin2', admin2);

  // ── Open July draw via real admin API (runs enrollment + cache invalidation) ─
  let open = (await q(`SELECT id, name FROM draw WHERE status='Open' ORDER BY draw_date ASC LIMIT 1`)).rows[0];
  if (!open) {
    const adminToken = out.admin1.token;
    const created = await fetch(`${API}/admin/draw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'July 2026', prize_amount: 5000, draw_date: '2026-07-15' }),
    });
    if (!created.ok) throw new Error(`create draw: ${created.status} ${await created.text()}`);
    const draw = await created.json();
    const opened = await fetch(`${API}/admin/draws/${draw.id}/open`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!opened.ok) throw new Error(`open draw: ${opened.status} ${await opened.text()}`);
    open = { id: draw.id, name: draw.name };
  }
  const DRAW = open.id;
  console.log(`Open draw: #${DRAW} ${open.name}`);

  // ── Closed June draw with a confirmed winner (for winner UX) ────────────────
  let june = (await q(`SELECT id FROM draw WHERE name='June 2026 (UX)'`)).rows[0];
  if (!june) {
    june = (await q(
      `INSERT INTO draw (name, prize_pool, start_date, draw_date, status, opened_at, closed_at)
       VALUES ('June 2026 (UX)', 4000, '2026-06-01T04:00:00Z', '2026-07-01T04:00:00Z', 'Closed', NOW() - INTERVAL '32 days', NOW() - INTERVAL '1 day')
       RETURNING id`)).rows[0];
  }

  // ── Business personas ───────────────────────────────────────────────────────
  // b_new_nosetup: Business role, no business row yet (setup wizard)
  const bNew = await upsertUser('b_new_nosetup', { fullName: 'Nina Newpartner', role: 'Business', phone: '+15550001001' });
  add('b_new_nosetup', bNew, { requiresBusinessSetup: true });

  // b_setup_nosub: profile done, NO subscription (this one does the REAL Stripe checkout)
  const bNoSub = await upsertUser('b_setup_nosub', { fullName: 'Sam Subscriber', role: 'Business', phone: '+15550001002' });
  const bNoSubBiz = await ensureBusiness(bNoSub.id, { name: 'Sunrise Deli (UX)', sector: 'Food', description: 'Classic New York deli sandwiches made fresh all day.' });
  await ensureLocation(bNoSubBiz, 'Midtown', '350 5th Ave, New York, NY', COORDS[0]);
  add('b_setup_nosub', bNoSub, { business_id: bNoSubBiz, businessIsActive: false });

  // b_active_single: Active sub, 1 location, entries
  const bSingle = await upsertUser('b_active_single', { fullName: 'Olivia Owner', role: 'Business', phone: '+15550001003' });
  const bSingleBiz = await ensureBusiness(bSingle.id, { name: 'Hudson Coffee Co (UX)', sector: 'Coffee', description: 'Specialty espresso bar with single-origin beans roasted in Brooklyn.' });
  const bSingleLoc = await ensureLocation(bSingleBiz, 'West Village', '80 Grove St, New York, NY', COORDS[1]);
  await ensureSubscription(bSingleBiz, { perLoc: 250, fee: 250 });
  await enroll(DRAW, bSingleBiz, 250); await enroll(june.id, bSingleBiz, 250);
  add('b_active_single', bSingle, { business_id: bSingleBiz, businessIsActive: true });

  // b_active_multi: Active sub, 3 locations, manager on loc 2
  const bMulti = await upsertUser('b_active_multi', { fullName: 'Marco Multi', role: 'Business', phone: '+15550001004' });
  const bMultiBiz = await ensureBusiness(bMulti.id, { name: 'Verde Bowls (UX)', sector: 'Health', description: 'Fresh salad and grain bowls with locally sourced produce.' });
  const mLoc1 = await ensureLocation(bMultiBiz, 'SoHo', '120 Prince St, New York, NY', COORDS[2]);
  const mLoc2 = await ensureLocation(bMultiBiz, 'Chelsea', '200 W 23rd St, New York, NY', COORDS[3]);
  const mLoc3 = await ensureLocation(bMultiBiz, 'Upper East', '1200 Madison Ave, New York, NY', COORDS[4]);
  await ensureSubscription(bMultiBiz, { perLoc: 500, fee: 1500 });
  await enroll(DRAW, bMultiBiz, 1500);
  add('b_active_multi', bMulti, { business_id: bMultiBiz, businessIsActive: true });

  // b_founding: founding partner
  const bFound = await upsertUser('b_founding', { fullName: 'Fiona Founding', role: 'Business', phone: '+15550001005' });
  const bFoundBiz = await ensureBusiness(bFound.id, { name: 'Atlas Books (UX)', sector: 'Retail', description: 'Independent bookstore with curated fiction and weekly readings.' });
  await ensureLocation(bFoundBiz, 'Main', '52 W 8th St, New York, NY', COORDS[5]);
  await ensureSubscription(bFoundBiz, { perLoc: 250, fee: 0 });
  const seat = (await q(`SELECT COALESCE(MAX(seat_number),0)+1 AS s FROM founding_member`)).rows[0].s;
  await q(`INSERT INTO founding_member (business_id, seat_number, amount_paid) VALUES ($1,$2,1200)
           ON CONFLICT (business_id) DO NOTHING`, [bFoundBiz, seat]);
  await q(`INSERT INTO founding_payment (business_id, stripe_payment_intent_id, amount)
           VALUES ($1, $2, 1200) ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
    [bFoundBiz, `pi_ux_seed_${bFoundBiz}`]);
  await enroll(DRAW, bFoundBiz, 0);
  add('b_founding', bFound, { business_id: bFoundBiz, businessIsActive: true });

  // b_cancelled / b_pastdue
  const bCanc = await upsertUser('b_cancelled', { fullName: 'Carl Cancelled', role: 'Business', phone: '+15550001006' });
  const bCancBiz = await ensureBusiness(bCanc.id, { name: 'Peak Fitness (UX)', sector: 'Gym', description: 'Neighborhood gym with small group classes.' });
  await ensureLocation(bCancBiz, 'Main', '400 E 14th St, New York, NY', COORDS[6]);
  await ensureSubscription(bCancBiz, { status: 'Cancelled', perLoc: 250, fee: 250 });
  add('b_cancelled', bCanc, { business_id: bCancBiz, businessIsActive: false });

  const bPast = await upsertUser('b_pastdue', { fullName: 'Pete Pastdue', role: 'Business', phone: '+15550001007' });
  const bPastBiz = await ensureBusiness(bPast.id, { name: 'Luna Nails (UX)', sector: 'Beauty', description: 'Nail studio and spa.' });
  const bPastLoc = await ensureLocation(bPastBiz, 'Main', '77 Bleecker St, New York, NY', COORDS[7]);
  await ensureSubscription(bPastBiz, { status: 'Past_Due', perLoc: 250, fee: 250 });
  await enroll(DRAW, bPastBiz, 250);
  add('b_pastdue', bPast, { business_id: bPastBiz, businessIsActive: false });

  // b_capped_loc: tiny cap, reached
  const bCap = await upsertUser('b_capped_loc', { fullName: 'Cathy Capped', role: 'Business', phone: '+15550001008' });
  const bCapBiz = await ensureBusiness(bCap.id, { name: 'Corner Bakery (UX)', sector: 'Bakery', description: 'Sourdough and pastries baked every morning.' });
  const bCapLoc = await ensureLocation(bCapBiz, 'Main', '15 Carmine St, New York, NY', COORDS[8]);
  await ensureSubscription(bCapBiz, { perLoc: 10, fee: 100 });
  await enroll(DRAW, bCapBiz, 100);
  add('b_capped_loc', bCap, { business_id: bCapBiz, businessIsActive: true });

  // b_rich: lots of data for analytics
  const bRich = await upsertUser('b_rich', { fullName: 'Rachel Rich', role: 'Business', phone: '+15550001009' });
  const bRichBiz = await ensureBusiness(bRich.id, { name: 'Golden Wok (UX)', sector: 'Food', description: 'Family-run Sichuan kitchen. Hand-pulled noodles daily.' });
  const rLoc1 = await ensureLocation(bRichBiz, 'Chinatown', '88 Mott St, New York, NY', [40.7168, -73.9973]);
  const rLoc2 = await ensureLocation(bRichBiz, 'Flushing', '135 Roosevelt Ave, Queens, NY', [40.7597, -73.83]);
  await ensureSubscription(bRichBiz, { perLoc: 1000, fee: 2000 });
  await enroll(DRAW, bRichBiz, 2000); await enroll(june.id, bRichBiz, 2000);
  add('b_rich', bRich, { business_id: bRichBiz, businessIsActive: true });

  // b_nologo — minimal, no logo, no description flourish
  const bPlain = await upsertUser('b_nologo', { fullName: 'Bob Plain', role: 'Business', phone: '+15550001010' });
  const bPlainBiz = await ensureBusiness(bPlain.id, { name: 'Quick Mart (UX)', sector: 'Grocery', description: 'Convenience store.' });
  await ensureLocation(bPlainBiz, 'Main', '300 W 40th St, New York, NY', [40.7565, -73.9926]);
  await ensureSubscription(bPlainBiz, { perLoc: 250, fee: 250 });
  await enroll(DRAW, bPlainBiz, 250);
  add('b_nologo', bPlain, { business_id: bPlainBiz, businessIsActive: true });

  // ── Managers (role Business + location_id in JWT) ───────────────────────────
  const mgr = await upsertUser('m_loc', { fullName: 'Maria Manager', role: 'Business', phone: '+15550002001' });
  await q(`UPDATE business_location SET manager_user_id=$1, invite_used_at=NOW() WHERE id=$2`, [mgr.id, mLoc2]);
  add('m_loc', mgr, { location_id: mLoc2, business_id: bMultiBiz, businessIsActive: true });

  const mgr2 = await upsertUser('m_new', { fullName: 'Noah Newmanager', role: 'Business', phone: '+15550002002' });
  await q(`UPDATE business_location SET manager_user_id=$1, invite_used_at=NOW() WHERE id=$2`, [mgr2.id, rLoc2]);
  add('m_new', mgr2, { location_id: rLoc2, business_id: bRichBiz, businessIsActive: true });

  // ── Regular user personas ───────────────────────────────────────────────────
  const uFresh = await upsertUser('u_fresh', { fullName: 'Frank Fresh', phoneVerified: false });
  add('u_fresh', uFresh);

  const uZero = await upsertUser('u_verified_zero', { fullName: 'Zoe Zero', phone: '+15550003001' });
  add('u_verified_zero', uZero);

  const uFew = await upsertUser('u_active_few', { fullName: 'Felix Few', phone: '+15550003002' });
  await ticket({ userId: uFew.id, bizId: bSingleBiz, locId: bSingleLoc, drawId: DRAW, amount: 42.5, daysAgo: 2 });
  await ticket({ userId: uFew.id, bizId: bRichBiz, locId: rLoc1, drawId: DRAW, amount: 67, daysAgo: 1 });
  await ticket({ userId: uFew.id, bizId: bRichBiz, locId: rLoc1, drawId: DRAW, amount: 25.75, daysAgo: 5 });
  await ticket({ userId: uFew.id, drawId: DRAW, source: 'free', daysAgo: 3 });
  add('u_active_few', uFew);

  const uCap = await upsertUser('u_capped', { fullName: 'Cara Capped', phone: '+15550003003' });
  const capCount = (await q(`SELECT COUNT(*)::int c FROM ticket WHERE activated_by_user_id=$1 AND draw_id=$2`, [uCap.id, DRAW])).rows[0].c;
  for (let i = capCount; i < 30; i++) {
    await ticket({ userId: uCap.id, bizId: bRichBiz, locId: rLoc1, drawId: DRAW, amount: 20 + i, daysAgo: i % 14 });
  }
  add('u_capped', uCap);

  const uHigh = await upsertUser('u_highrisk', { fullName: 'Hank Highrisk', phone: '+15550003004', riskScore: 25 });
  await ticket({ userId: uHigh.id, bizId: bSingleBiz, locId: bSingleLoc, drawId: DRAW, amount: 30, daysAgo: 0,
                 quarantined: true, reason: 'high_risk_user' });
  add('u_highrisk', uHigh);

  const uRisk10 = await upsertUser('u_risk10', { fullName: 'Rita Risky', phone: '+15550003005', riskScore: 12 });
  await ticket({ userId: uRisk10.id, bizId: bSingleBiz, locId: bSingleLoc, drawId: DRAW, amount: 55, daysAgo: 4 });
  add('u_risk10', uRisk10);

  const uRef = await upsertUser('u_referrer', { fullName: 'Rina Referrer', phone: '+15550003006', referralCode: 'UXREF123' });
  add('u_referrer', uRef);

  const uRefd = await upsertUser('u_referred_pending', { fullName: 'Paula Pending', phoneVerified: false });
  await q(`UPDATE user_acquisition SET source='referral', referred_by_user_id=$1, referral_rewarded_at=NULL WHERE user_id=$2`, [uRef.id, uRefd.id]);
  add('u_referred_pending', uRefd);

  const uWin = await upsertUser('u_winner', { fullName: 'Wendy Winner', phone: '+15550003007' });
  const winTicket = await ticket({ userId: uWin.id, bizId: bSingleBiz, locId: bSingleLoc, drawId: june.id, amount: 88, daysAgo: 10 });
  await q(`UPDATE draw SET winner_user_id=$1, winner_ticket_id=$2, winner_confirmed=TRUE WHERE id=$3 AND winner_ticket_id IS NULL`,
    [uWin.id, winTicket, june.id]);
  await ticket({ userId: uWin.id, bizId: bSingleBiz, locId: bSingleLoc, drawId: DRAW, amount: 34, daysAgo: 1 });
  add('u_winner', uWin);

  const uQuar = await upsertUser('u_quarantined', { fullName: 'Quinn Review', phone: '+15550003008' });
  await ticket({ userId: uQuar.id, bizId: bRichBiz, locId: rLoc1, drawId: DRAW, amount: 45, daysAgo: 0,
                 quarantined: true, reason: 'ocr_pending' });
  await ticket({ userId: uQuar.id, bizId: bRichBiz, locId: rLoc1, drawId: DRAW, amount: 62, daysAgo: 0,
                 quarantined: true, reason: 'ocr_pending' });
  await ticket({ userId: uQuar.id, bizId: bSingleBiz, locId: bSingleLoc, drawId: DRAW, amount: 28, daysAgo: 6 });
  add('u_quarantined', uQuar);

  const uWeek = await upsertUser('u_weekly_used', { fullName: 'Wes Weekly', phone: '+15550003009' });
  await ticket({ userId: uWeek.id, drawId: DRAW, source: 'free', daysAgo: 0 });
  await q(`INSERT INTO free_ticket_usage (user_id, draw_id, status, activated_at)
           VALUES ($1,$2,'approved',NOW()) ON CONFLICT (user_id) DO UPDATE SET activated_at=NOW(), draw_id=$2`,
    [uWeek.id, DRAW]);
  add('u_weekly_used', uWeek);

  const uPromo = await upsertUser('u_promo', { fullName: 'Priya Promo', phone: '+15550003010' });
  await q(`INSERT INTO promotional_code (code, is_active, max_uses) VALUES ('PROMO-UXTEST', TRUE, 500)
           ON CONFLICT (code) DO NOTHING`);
  await q(`INSERT INTO promotional_entry (code, user_id, draw_id) VALUES ('PROMO-UXTEST',$1,$2)
           ON CONFLICT (code, user_id) DO NOTHING`, [uPromo.id, DRAW]);
  await ticket({ userId: uPromo.id, drawId: DRAW, source: 'promo', daysAgo: 1 });
  add('u_promo', uPromo);

  // ── Cap-reached location: fill Corner Bakery to its 10-entry cap ────────────
  const fillUsers = [uZero, uFew, uWin, uQuar, uWeek, uPromo, uRef, uRisk10, uHigh, uCap];
  const capLocCount = (await q(
    `SELECT COUNT(*)::int c FROM ticket WHERE business_id=$1 AND draw_id=$2 AND is_quarantined=FALSE`, [bCapBiz, DRAW])).rows[0].c;
  for (let i = capLocCount; i < 10; i++) {
    await ticket({ userId: fillUsers[i % fillUsers.length].id, bizId: bCapBiz, locId: bCapLoc, drawId: DRAW,
                   amount: 15 + i * 3, daysAgo: i % 10 });
  }

  // ── Rich analytics data: ~80 entries over 30 days at Golden Wok ─────────────
  const richCount = (await q(
    `SELECT COUNT(*)::int c FROM ticket WHERE business_id=$1 AND draw_id=$2`, [bRichBiz, DRAW])).rows[0].c;
  for (let i = richCount; i < 80; i++) {
    const u = fillUsers[i % fillUsers.length];
    await ticket({
      userId: u.id, bizId: bRichBiz, locId: i % 3 === 0 ? rLoc2 : rLoc1, drawId: DRAW,
      amount: Math.round((15 + Math.random() * 185) * 100) / 100,
      daysAgo: i % 28,
      quarantined: i % 17 === 0, reason: i % 17 === 0 ? 'ocr_pending' : null,
    });
  }
  // Past-due Luna Nails gets a handful too
  const pastCount = (await q(
    `SELECT COUNT(*)::int c FROM ticket WHERE business_id=$1 AND draw_id=$2`, [bPastBiz, DRAW])).rows[0].c;
  for (let i = pastCount; i < 6; i++) {
    await ticket({ userId: fillUsers[i].id, bizId: bPastBiz, locId: bPastLoc, drawId: DRAW, amount: 35 + i * 7, daysAgo: i });
  }

  const outPath = path.resolve(__dirname, '../../e2e/ux-500/personas.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ drawId: DRAW, juneDrawId: june.id, personas: out }, null, 2));
  console.log(`Seeded ${Object.keys(out).length} personas -> ${outPath}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
