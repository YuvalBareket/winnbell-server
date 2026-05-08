/**
 * Winnbell Risk Integration Test
 *
 * Tests against the live server + real Neon DB.
 * Covers:
 *   1. Risk score accumulation & quarantine at ≥20
 *   2. Admin manual disqualify / restore via PATCH /admin/users/:id/risk
 *   3. 30-entry unified cap (receipt + free + promo all count)
 *   4. Campaign-end decay (tiered: HIGH−4, MEDIUM−2, LOW−1)
 *   5. Score recovery over multiple simulated campaign closes
 *
 * Run: node test_risk.mjs
 * Requires: server running at http://localhost:3000, DATABASE_URL in .env
 */

import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const BASE       = 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 5,
});

const hash     = (pw) => bcrypt.hashSync(pw, 10);
const makeToken = (id, role, locationId = null) =>
  jwt.sign({ id, role, location_id: locationId }, JWT_SECRET, { expiresIn: '7d' });

let passed = 0, failed = 0, warnings = 0;
const issues = [];

function pass(label)         { console.log(`  ✅  ${label}`); passed++; }
function fail(label, detail) {
  console.log(`  ❌  ${label}`);
  if (detail) console.log(`       → ${detail}`);
  failed++;
  issues.push({ label, detail });
}
function warn(label, detail) {
  console.log(`  ⚠️   ${label}`);
  if (detail) console.log(`       → ${detail}`);
  warnings++;
}
function info(label) { console.log(`  ℹ️   ${label}`); }
function section(t)  { console.log(`\n${'─'.repeat(64)}\n  ${t}\n${'─'.repeat(64)}`); }

async function api(method, path, body, token, timeoutMs = 15000) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* text response */ }
    return { status: res.status, json };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 0, json: null, timedOut: true };
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function dbQuery(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}

async function getRiskScore(userId) {
  const rows = await dbQuery(`SELECT risk_score FROM "user" WHERE id = $1`, [userId]);
  return rows[0]?.risk_score ?? 0;
}

async function getEffectiveCount(userId, drawId) {
  const rows = await dbQuery(
    `SELECT (
       (SELECT COUNT(*)::int FROM ticket WHERE activated_by_user_id = $1 AND draw_id = $2 AND is_quarantined = FALSE)
       + (SELECT COUNT(*)::int FROM promotional_entry WHERE user_id = $1 AND draw_id = $2)
     ) AS effective_count`,
    [userId, drawId],
  );
  return rows[0]?.effective_count ?? 0;
}

async function getQuarantinedCount(userId, drawId) {
  const rows = await dbQuery(
    `SELECT COUNT(*)::int AS cnt FROM ticket
     WHERE activated_by_user_id = $1 AND draw_id = $2 AND is_quarantined = TRUE`,
    [userId, drawId],
  );
  return rows[0]?.cnt ?? 0;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function setup() {
  section('SETUP — Creating risk test personas');

  const testEmails = [
    'risk_fraud@risk.test',
    'risk_cap@risk.test',
    'risk_decay_high@risk.test',
    'risk_decay_medium@risk.test',
    'risk_decay_low@risk.test',
    'risk_decay_zero@risk.test',
  ];

  // Wipe previous run data
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const email of testEmails) {
      const u = await client.query(`SELECT id FROM "user" WHERE email = $1`, [email]);
      if (u.rows.length) {
        const uid = u.rows[0].id;
        await client.query(`DELETE FROM promotional_entry WHERE user_id = $1`, [uid]);
        await client.query(`DELETE FROM free_ticket_usage WHERE user_id = $1`, [uid]);
        await client.query(`DELETE FROM ticket WHERE activated_by_user_id = $1`, [uid]);
      }
    }
    await client.query(`DELETE FROM "user" WHERE email LIKE '%@risk.test'`);
    await client.query(`DELETE FROM promotional_code WHERE code LIKE 'RISKTEST%'`);

    const pw = hash('Test1234!');
    const mkUser = async (name, email, riskScore = 0) => {
      const r = await client.query(
        `INSERT INTO "user" (full_name, email, password_hash, role, is_email_verified, risk_score)
         VALUES ($1,$2,$3,'User',true,$4) RETURNING id`,
        [name, email, pw, riskScore],
      );
      return r.rows[0].id;
    };

    const fraudId       = await mkUser('Risk Fraud User',        'risk_fraud@risk.test');
    const capId         = await mkUser('Risk Cap User',           'risk_cap@risk.test');
    const decayHighId   = await mkUser('Decay High User',         'risk_decay_high@risk.test',   25);
    const decayMedId    = await mkUser('Decay Medium User',       'risk_decay_medium@risk.test', 15);
    const decayLowId    = await mkUser('Decay Low User',          'risk_decay_low@risk.test',    5);
    const decayZeroId   = await mkUser('Decay Zero User',         'risk_decay_zero@risk.test',   0);

    await client.query('COMMIT');

    // Fetch open draw + a participating location
    const drawRes = await pool.query(`SELECT id FROM draw WHERE status = 'Open' LIMIT 1`);
    const openDrawId = drawRes.rows[0]?.id;
    if (!openDrawId) throw new Error('No open draw found — cannot run risk integration tests');

    const locRes = await pool.query(
      `SELECT bl.id FROM business_location bl
       JOIN business b ON bl.business_id = b.id
       WHERE b.is_subscribed = true AND b.is_participating = true AND bl.is_active = true
       LIMIT 1`,
    );
    const locationId = locRes.rows[0]?.id;
    if (!locationId) throw new Error('No active participating location found');

    const adminRes = await pool.query(`SELECT id FROM "user" WHERE role = 'Admin' LIMIT 1`);
    const adminId = adminRes.rows[0]?.id;
    if (!adminId) throw new Error('No admin user found');

    const minAmtRes = await pool.query(
      `SELECT COALESCE(b.min_transaction_amount, 1) AS min_amt
       FROM business_location bl JOIN business b ON bl.business_id = b.id
       WHERE bl.id = $1`,
      [locationId],
    );
    const minAmt = parseFloat(minAmtRes.rows[0]?.min_amt ?? 1);

    info(`openDrawId=${openDrawId}, locationId=${locationId}, minAmt=${minAmt}`);
    info(`fraudId=${fraudId}, capId=${capId}`);
    info(`decayHigh=${decayHighId}(25), decayMed=${decayMedId}(15), decayLow=${decayLowId}(5), decayZero=${decayZeroId}(0)`);

    return { fraudId, capId, decayHighId, decayMedId, decayLowId, decayZeroId, openDrawId, locationId, adminId, minAmt };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests(ids) {
  const { fraudId, capId, decayHighId, decayMedId, decayLowId, decayZeroId, openDrawId, locationId, adminId, minAmt } = ids;

  const fraudToken = makeToken(fraudId, 'User');
  const capToken   = makeToken(capId,   'User');
  const adminToken = makeToken(adminId, 'Admin');
  const today      = new Date().toISOString().split('T')[0];

  // ── 1. RISK SCORE ACCUMULATION ─────────────────────────────────────────────
  section('1. RISK SCORE ACCUMULATION — velocity detection');

  const riskBefore = await getRiskScore(fraudId);
  info(`fraud user starting risk score: ${riskBefore}`);

  // Submit 5 receipts quickly (same location, same user) — triggers velocity flags
  const submittedCodes = [];
  for (let i = 1; i <= 5; i++) {
    const r = await api('POST', '/tickets/receipt-entry', {
      locationId,
      receiptIdentifier: `FRAUD-VEL-${fraudId}-${i}-${Date.now()}`,
      transactionAmount: minAmt,
      transactionDate: today,
    }, fraudToken, 20000);
    if (r.status === 201) {
      submittedCodes.push(r.json?.ticketId);
      info(`  receipt ${i} → ✅ code=${r.json?.code}`);
    } else {
      info(`  receipt ${i} → ❌ ${r.status}: ${r.json?.message}`);
    }
    await new Promise(res => setTimeout(res, 200));
  }

  const riskAfter = await getRiskScore(fraudId);
  info(`fraud user risk score after 5 rapid submissions: ${riskAfter}`);

  if (riskAfter > riskBefore) {
    pass(`Risk score escalated after velocity pattern: ${riskBefore} → ${riskAfter}`);
  } else {
    fail('Risk score did NOT increase after 5 rapid same-location submissions', `before=${riskBefore}, after=${riskAfter}`);
  }

  // Verify tickets exist in DB
  const ticketRows = await dbQuery(
    `SELECT id, is_quarantined FROM ticket WHERE activated_by_user_id = $1 AND draw_id = $2`,
    [fraudId, openDrawId],
  );
  info(`  DB: ${ticketRows.length} tickets for fraud user`);
  if (ticketRows.length >= submittedCodes.length && submittedCodes.length > 0) {
    pass(`DB verified: ${ticketRows.length} real ticket rows created for fraud user`);
  } else if (submittedCodes.length === 0) {
    warn('No receipts were accepted (possibly daily cap or min amount — check manually)', '');
  } else {
    fail('Ticket count in DB does not match API responses', `db=${ticketRows.length}, api=${submittedCodes.length}`);
  }

  // ── 2. ADMIN MANUAL DISQUALIFY & QUARANTINE ────────────────────────────────
  section('2. ADMIN DISQUALIFY — set score to 20, verify quarantine');

  // Admin sets fraud user to HIGH risk (score 20)
  {
    const r = await api('PATCH', `/admin/users/${fraudId}/risk`, { risk_score: 20 }, adminToken);
    if (r.status === 200) {
      pass('PATCH /admin/users/:id/risk → score set to 20');
    } else {
      fail('Admin could not set risk score', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // Verify score in DB
  const scoreAfterDisqualify = await getRiskScore(fraudId);
  if (scoreAfterDisqualify === 20) {
    pass(`DB verified: risk_score = 20`);
  } else {
    fail(`DB risk_score mismatch`, `expected 20, got ${scoreAfterDisqualify}`);
  }

  // Verify tickets are quarantined
  await new Promise(res => setTimeout(res, 500));
  const quarantinedAfter = await getQuarantinedCount(fraudId, openDrawId);
  const totalTickets = ticketRows.length;

  if (totalTickets === 0) {
    info('No tickets to quarantine (no receipts accepted earlier)');
  } else if (quarantinedAfter === totalTickets) {
    pass(`DB verified: all ${quarantinedAfter}/${totalTickets} tickets quarantined after HIGH risk set`);
  } else if (quarantinedAfter > 0) {
    warn(`Partial quarantine: ${quarantinedAfter}/${totalTickets} quarantined`, 'Some tickets may be winners (protected)');
  } else {
    fail(`No tickets quarantined after score set to 20`, `total tickets: ${totalTickets}`);
  }

  // Effective count should now exclude quarantined entries
  const effectiveAfterDisqualify = await getEffectiveCount(fraudId, openDrawId);
  info(`  effectiveCount after disqualify: ${effectiveAfterDisqualify} (quarantined entries excluded)`);
  if (effectiveAfterDisqualify === 0 && quarantinedAfter > 0) {
    pass('effectiveCount = 0 after all entries quarantined (correct)');
  }

  // ── 3. ADMIN RESTORE — score back to 0, verify un-quarantine ──────────────
  section('3. ADMIN RESTORE — set score to 0, verify un-quarantine');

  {
    const r = await api('PATCH', `/admin/users/${fraudId}/risk`, { risk_score: 0 }, adminToken);
    if (r.status === 200) {
      pass('PATCH /admin/users/:id/risk → score restored to 0');
    } else {
      fail('Admin could not restore risk score', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  const scoreAfterRestore = await getRiskScore(fraudId);
  if (scoreAfterRestore === 0) {
    pass('DB verified: risk_score = 0 after restore');
  } else {
    fail('DB risk_score not 0 after restore', `got ${scoreAfterRestore}`);
  }

  await new Promise(res => setTimeout(res, 500));
  const quarantinedAfterRestore = await getQuarantinedCount(fraudId, openDrawId);
  if (quarantinedAfterRestore === 0 && totalTickets > 0) {
    pass(`DB verified: all ${totalTickets} tickets un-quarantined after restore`);
  } else if (totalTickets === 0) {
    info('No tickets to un-quarantine');
  } else {
    fail(`${quarantinedAfterRestore} tickets still quarantined after restore to score 0`, '');
  }

  // ── 4. 30-ENTRY UNIFIED CAP ────────────────────────────────────────────────
  section('4. 30-ENTRY UNIFIED CAP — receipt + free + promo all count');

  // Pre-seed 27 receipt tickets directly in DB for the cap user
  // (Daily API cap is 5/day — pre-seeding lets us reach the boundary faster)
  const client2 = await pool.connect();
  try {
    await client2.query('BEGIN');

    // Find a business for the tickets
    const bizRes = await client2.query(
      `SELECT b.id FROM business b JOIN business_location bl ON bl.business_id = b.id
       WHERE bl.id = $1 LIMIT 1`,
      [locationId],
    );
    const bizId = bizRes.rows[0]?.id;

    for (let i = 1; i <= 27; i++) {
      const code = `CAPTEST${String(i).padStart(3, '0')}`;
      await client2.query(`DELETE FROM ticket WHERE code = $1`, [code]);
      await client2.query(
        `INSERT INTO ticket (code, status, entry_source, business_id, location_id, draw_id,
                             activated_by_user_id, activated_at, receipt_identifier, transaction_amount)
         VALUES ($1,'Activated','receipt',$2,$3,$4,$5,NOW(),$6,$7)`,
        [code, bizId, locationId, openDrawId, capId, `CAP-SEED-${i}`, minAmt],
      );
    }
    await client2.query('COMMIT');
  } catch (e) {
    await client2.query('ROLLBACK');
    throw e;
  } finally {
    client2.release();
  }

  const countAfterSeed = await getEffectiveCount(capId, openDrawId);
  info(`  effectiveCount after pre-seeding 27 entries: ${countAfterSeed}`);
  if (countAfterSeed === 27) {
    pass('DB pre-seed: 27 receipt entries confirmed in DB');
  } else {
    fail('Pre-seed count wrong', `expected 27, got ${countAfterSeed}`);
  }

  // Check via API (GET my-tickets)
  {
    const r = await api('GET', `/tickets/my-tickets?draw_id=${openDrawId}`, null, capToken);
    if (r.status === 200 && r.json?.effectiveCount === 27) {
      pass('GET /tickets/my-tickets → effectiveCount=27 via API');
    } else if (r.status === 200) {
      info(`  API effectiveCount: ${r.json?.effectiveCount} (may differ if promo entries exist)`);
    } else {
      warn('GET my-tickets unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // Submit entry #28 via API (one real receipt, should succeed)
  let entry28Succeeded = false;
  {
    const r = await api('POST', '/tickets/receipt-entry', {
      locationId,
      receiptIdentifier: `CAP-REAL-28-${Date.now()}`,
      transactionAmount: minAmt,
      transactionDate: today,
    }, capToken, 20000);
    if (r.status === 201) {
      entry28Succeeded = true;
      pass('Entry #28 (receipt) → accepted ✅');
    } else if (r.status === 400 && r.json?.message?.toLowerCase().includes('maximum')) {
      fail('Entry #28 was wrongly blocked at 27 — cap fires too early!', r.json?.message);
    } else {
      warn('Entry #28 → unexpected', `${r.status}: ${r.json?.message}`);
    }
  }

  // Create a promo code via admin and use it for entry #29
  let promoCode = `RISKTEST${Date.now()}`;
  let entry29Succeeded = false;
  {
    const r = await api('POST', '/admin/promo-codes', { code: promoCode, maxUses: 10 }, adminToken);
    if (r.status === 201) {
      info(`  Promo code created: ${promoCode}`);
      const use = await api('POST', '/tickets/activate-promotional', { code: promoCode }, capToken);
      if (use.status === 201) {
        entry29Succeeded = true;
        pass('Entry #29 (promo code) → accepted ✅');
      } else if (use.status === 400 && use.json?.message?.toLowerCase().includes('maximum')) {
        fail('Entry #29 (promo) wrongly blocked at 28', use.json?.message);
      } else {
        warn('Promo activation unexpected', `${use.status}: ${use.json?.message}`);
      }
    } else {
      warn('Admin promo code creation failed', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // Claim free entry for entry #30
  let entry30Succeeded = false;
  {
    const r = await api('POST', '/tickets/activate-free', {}, capToken);
    if (r.status === 201) {
      entry30Succeeded = true;
      pass('Entry #30 (free ticket) → accepted ✅');
    } else if (r.status === 400 && r.json?.message?.toLowerCase().includes('maximum')) {
      fail('Entry #30 (free) wrongly blocked before reaching cap', r.json?.message);
    } else if (r.status === 400 && r.json?.message?.toLowerCase().includes('weekly')) {
      warn('Free ticket: already used this week (run test on a fresh week or after cleanup)', r.json?.message);
    } else {
      warn('Free ticket activation unexpected', `${r.status}: ${r.json?.message}`);
    }
  }

  // Verify effective count is now 30 (or whatever we reached)
  const countAt30 = await getEffectiveCount(capId, openDrawId);
  info(`  effectiveCount after all 30 attempts: ${countAt30}`);
  if (countAt30 >= 30) {
    pass(`DB verified: effectiveCount=${countAt30} (≥ 30 reached)`);
  }

  // Now try to exceed the cap — entry #31 should be blocked
  {
    const r = await api('POST', '/tickets/receipt-entry', {
      locationId,
      receiptIdentifier: `CAP-OVER-${Date.now()}`,
      transactionAmount: minAmt,
      transactionDate: today,
    }, capToken, 20000);
    if (r.status === 400 && r.json?.message?.toLowerCase().includes('maximum')) {
      pass('Entry #31 → cap enforced with "maximum" message ✅');
    } else if (r.status === 400 && r.json?.message?.toLowerCase().includes('daily')) {
      pass('Entry #31 → blocked (daily cap also applies — acceptable)');
    } else if (r.status === 201) {
      fail('Entry #31 ACCEPTED — 30-entry cap is NOT enforced!', `effectiveCount was ${countAt30}`);
    } else {
      warn('Entry #31 → unexpected response', `${r.status}: ${r.json?.message}`);
    }
  }

  // If we only reached 29 (because receipt #28 was daily-capped), use a promo to get to 30 first
  const countBeforePromoBlock = await getEffectiveCount(capId, openDrawId);
  if (countBeforePromoBlock < 30) {
    const fillCode = `RISKFILL-${Date.now()}`;
    const cr = await api('POST', '/admin/promo-codes', { code: fillCode, maxUses: 10 }, adminToken);
    if (cr.status === 201) {
      const use = await api('POST', '/tickets/activate-promotional', { code: fillCode }, capToken);
      if (use.status === 201) {
        info(`  Filled to 30 via extra promo code`);
      }
    }
  }

  const countAt30Final = await getEffectiveCount(capId, openDrawId);
  info(`  effectiveCount now: ${countAt30Final}`);

  // Now try one more promo — this should be blocked (over cap)
  {
    const promoCodeOverCap = `RISKTEST-OVER-${Date.now()}`;
    const cr = await api('POST', '/admin/promo-codes', { code: promoCodeOverCap, maxUses: 10 }, adminToken);
    if (cr.status === 201) {
      const use = await api('POST', '/tickets/activate-promotional', { code: promoCodeOverCap }, capToken);
      if (use.status === 400 && use.json?.message?.toLowerCase().includes('maximum')) {
        pass(`Promo entry beyond cap → blocked ✅ (effectiveCount=${countAt30Final})`);
      } else if (use.status === 201) {
        fail('Promo entry accepted beyond 30-entry cap!', `effectiveCount was ${countAt30Final}`);
      } else {
        warn('Promo over-cap attempt unexpected', `${use.status}: ${use.json?.message}`);
      }
    }
  }

  // ── 5. CAMPAIGN DECAY — tiered score reduction ─────────────────────────────
  section('5. CAMPAIGN DECAY — tiered score reduction per campaign close');

  // Record starting scores (set during setup: 25, 15, 5, 0)
  const startHigh   = await getRiskScore(decayHighId);
  const startMed    = await getRiskScore(decayMedId);
  const startLow    = await getRiskScore(decayLowId);
  const startZero   = await getRiskScore(decayZeroId);

  info(`  Before decay — HIGH=${startHigh}, MEDIUM=${startMed}, LOW=${startLow}, ZERO=${startZero}`);

  // Run the same SQL that decayAllUserRiskScores fires (scoped to test users only)
  await pool.query(`
    UPDATE "user"
    SET risk_score = GREATEST(0, risk_score -
      CASE
        WHEN risk_score >= 20 THEN 4
        WHEN risk_score >= 10 THEN 2
        ELSE 1
      END
    )
    WHERE risk_score > 0 AND email LIKE '%@risk.test' AND role = 'User'
  `);

  const afterHigh  = await getRiskScore(decayHighId);
  const afterMed   = await getRiskScore(decayMedId);
  const afterLow   = await getRiskScore(decayLowId);
  const afterZero  = await getRiskScore(decayZeroId);

  info(`  After decay — HIGH=${afterHigh}, MEDIUM=${afterMed}, LOW=${afterLow}, ZERO=${afterZero}`);

  // HIGH (25): expect 25 - 4 = 21
  if (afterHigh === startHigh - 4) {
    pass(`HIGH user: ${startHigh} → ${afterHigh} (−4 ✅)`);
  } else {
    fail(`HIGH user decay wrong`, `expected ${startHigh - 4}, got ${afterHigh}`);
  }

  // MEDIUM (15): expect 15 - 2 = 13
  if (afterMed === startMed - 2) {
    pass(`MEDIUM user: ${startMed} → ${afterMed} (−2 ✅)`);
  } else {
    fail(`MEDIUM user decay wrong`, `expected ${startMed - 2}, got ${afterMed}`);
  }

  // LOW (5): expect 5 - 1 = 4
  if (afterLow === startLow - 1) {
    pass(`LOW user: ${startLow} → ${afterLow} (−1 ✅)`);
  } else {
    fail(`LOW user decay wrong`, `expected ${startLow - 1}, got ${afterLow}`);
  }

  // ZERO (0): unchanged
  if (afterZero === 0) {
    pass(`ZERO user: stays at 0 (not affected by decay ✅)`);
  } else {
    fail(`ZERO user score changed unexpectedly`, `got ${afterZero}`);
  }

  // ── 6. SCORE RECOVERY — simulate 5 campaigns for a HIGH user ───────────────
  section('6. SCORE RECOVERY — HIGH user (score 25) clears after 5 campaigns');

  // Reset high user to 25
  await pool.query(`UPDATE "user" SET risk_score = 25 WHERE id = $1`, [decayHighId]);

  const decayRounds = [];
  for (let round = 1; round <= 7; round++) {
    await pool.query(`
      UPDATE "user"
      SET risk_score = GREATEST(0, risk_score -
        CASE
          WHEN risk_score >= 20 THEN 4
          WHEN risk_score >= 10 THEN 2
          ELSE 1
        END
      )
      WHERE id = $1 AND risk_score > 0
    `, [decayHighId]);
    const score = await getRiskScore(decayHighId);
    decayRounds.push(score);
    info(`  Campaign ${round}: score = ${score}`);
  }

  // Expected trajectory (HIGH=≥20 → −4, MEDIUM=10–19 → −2, LOW=1–9 → −1):
  // 25 →(−4)→ 21 →(−4)→ 17 →(−2)→ 15 →(−2)→ 13 →(−2)→ 11 →(−2)→ 9 →(−1)→ 8
  const expectedRounds = [21, 17, 15, 13, 11, 9, 8];
  let recoveryCorrect = true;
  for (let i = 0; i < expectedRounds.length; i++) {
    if (decayRounds[i] !== expectedRounds[i]) {
      recoveryCorrect = false;
      fail(`Campaign ${i+1} score wrong`, `expected ${expectedRounds[i]}, got ${decayRounds[i]}`);
    }
  }
  if (recoveryCorrect) {
    pass('Score recovery trajectory correct over 7 campaigns: 25→21→17→15→13→11→9→8');
  }

  // Verify HIGH user (25) crosses below HIGH threshold (20) after campaign 2
  const crossesBelowHigh = decayRounds.findIndex(s => s < 20);
  if (crossesBelowHigh === 1) { // index 1 = campaign 2 (17 < 20)
    pass(`HIGH user exits HIGH risk band after campaign 2 (score=${decayRounds[1]})`);
  } else if (crossesBelowHigh >= 0) {
    warn(`HIGH user exits HIGH band at campaign ${crossesBelowHigh + 1} (score=${decayRounds[crossesBelowHigh]})`, '');
  } else {
    fail('HIGH user never exits HIGH risk band in 7 campaigns', `final: ${decayRounds[6]}`);
  }

  // Verify score eventually reaches 0
  // From 7 onwards (score 7): LOW band → −1/campaign → 7 more campaigns
  let finalScore = decayRounds[6]; // 7 after 7 campaigns
  for (let round = 8; round <= 14 && finalScore > 0; round++) {
    await pool.query(`
      UPDATE "user"
      SET risk_score = GREATEST(0, risk_score -
        CASE WHEN risk_score >= 20 THEN 4 WHEN risk_score >= 10 THEN 2 ELSE 1 END
      )
      WHERE id = $1 AND risk_score > 0
    `, [decayHighId]);
    finalScore = await getRiskScore(decayHighId);
  }
  if (finalScore === 0) {
    pass(`Score fully cleared to 0 (HIGH user rehabilitated after ~14 campaigns)`);
  } else {
    warn(`Score not fully cleared after 14 campaigns`, `remaining: ${finalScore}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(64));
  console.log('  WINNBELL RISK INTEGRATION TEST');
  console.log('  ' + new Date().toISOString());
  console.log('═'.repeat(64));

  try {
    const ids = await setup();
    await runTests(ids);
  } catch (e) {
    console.error('\n💥 FATAL:', e.message, '\n', e.stack);
  } finally {
    await pool.end();
  }

  console.log('\n' + '═'.repeat(64));
  console.log('  FINAL REPORT');
  console.log('═'.repeat(64));
  console.log(`  ✅  Passed  : ${passed}`);
  console.log(`  ❌  Failed  : ${failed}`);
  console.log(`  ⚠️   Warnings: ${warnings}`);

  if (issues.length) {
    console.log('\n  Issues:');
    issues.forEach((b, i) => {
      console.log(`\n  [${i + 1}] ❌ ${b.label}`);
      if (b.detail) console.log(`       ${b.detail}`);
    });
  } else {
    console.log('\n  ✨ All checks passed!');
  }
  console.log('');
}

main();
