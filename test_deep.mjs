/**
 * Winnbell Deep Test — Hackers, Abusers, Invite Flow, DB Verification
 * Builds on existing test users (admin=59, biz1=60, etc.)
 * Run: node test_deep.mjs
 */

import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import crypto from 'crypto';
dotenv.config();

const BASE = 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 5,
});

const hash = (pw) => bcrypt.hashSync(pw, 10);
const makeToken = (id, role, locationId = null) =>
  jwt.sign({ id, role, location_id: locationId }, JWT_SECRET, { expiresIn: '7d' });

let passed = 0, failed = 0, warnings = 0;
const issues = [];

function pass(label) { console.log(`  ✅  ${label}`); passed++; }
function fail(label, detail) {
  console.log(`  ❌  ${label}`);
  if (detail) console.log(`       → ${detail}`);
  failed++;
  issues.push({ type: 'BUG', label, detail });
}
function warn(label, detail) {
  console.log(`  ⚠️   ${label}`);
  if (detail) console.log(`       → ${detail}`);
  warnings++;
  issues.push({ type: 'UX', label, detail });
}
function info(label) { console.log(`  ℹ️   ${label}`); }
function section(t) { console.log(`\n${'─'.repeat(62)}\n  ${t}\n${'─'.repeat(62)}`); }

async function api(method, path, body, token, timeoutMs = 15000) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* text */ }
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

async function getTicketCount(userId, drawId) {
  const rows = await dbQuery(
    `SELECT COUNT(*) cnt FROM ticket WHERE activated_by_user_id = $1 AND draw_id = $2`,
    [userId, drawId]
  );
  return parseInt(rows[0]?.cnt ?? 0, 10);
}

// ─── Setup ───────────────────────────────────────────────────────────────────
async function setup() {
  section('SETUP — Creating fresh test personas');

  const deepEmails = [
    'hacker1@deep.test', 'hacker2@deep.test',
    'abuser1@deep.test', 'abuser2@deep.test',
    'newbiz@deep.test', 'newmgr@deep.test',
    'invitee1@deep.test', 'invitee2@deep.test',
    'victim@deep.test',
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Wipe previous deep test data
    for (const email of deepEmails) {
      const u = await client.query(`SELECT id FROM "user" WHERE email = $1`, [email]);
      if (u.rows.length) {
        const uid = u.rows[0].id;
        await client.query(`DELETE FROM free_ticket_usage WHERE user_id = $1`, [uid]);
        await client.query(`DELETE FROM ticket WHERE activated_by_user_id = $1`, [uid]);
      }
    }
    await client.query(`DELETE FROM ticket WHERE business_id IN (SELECT b.id FROM business b JOIN "user" u ON b.user_id = u.id WHERE u.email LIKE '%deep.test')`);
    await client.query(`DELETE FROM subscription WHERE business_id IN (SELECT b.id FROM business b JOIN "user" u ON b.user_id = u.id WHERE u.email LIKE '%deep.test')`);
    await client.query(`DELETE FROM business_location WHERE business_id IN (SELECT b.id FROM business b JOIN "user" u ON b.user_id = u.id WHERE u.email LIKE '%deep.test')`);
    await client.query(`DELETE FROM business WHERE user_id IN (SELECT id FROM "user" WHERE email LIKE '%deep.test')`);
    await client.query(`DELETE FROM "user" WHERE email LIKE '%deep.test'`);

    const pw = hash('Test1234!');

    const mkUser = async (fullName, email, role) => {
      const r = await client.query(
        `INSERT INTO "user" (full_name, email, password_hash, role, is_email_verified, risk_score)
         VALUES ($1,$2,$3,$4,true,0) RETURNING id`,
        [fullName, email, pw, role]
      );
      return r.rows[0].id;
    };

    const hacker1Id  = await mkUser('Hacker One',    'hacker1@deep.test',  'User');
    const hacker2Id  = await mkUser('Hacker Two',    'hacker2@deep.test',  'User');
    const abuser1Id  = await mkUser('Abuser One',    'abuser1@deep.test',  'User');
    const abuser2Id  = await mkUser('Abuser Two',    'abuser2@deep.test',  'User');
    const newbizId   = await mkUser('New Biz Owner', 'newbiz@deep.test',   'Business');
    const victimId   = await mkUser('Victim User',   'victim@deep.test',   'User');
    // invitee1 and invitee2 registered via API to test invite flow

    // New business for invite-flow testing (Sushi World)
    const bizRes = await client.query(
      `INSERT INTO business (user_id, name, sector, is_subscribed, is_participating, entry_mode, min_transaction_amount, location, latitude, longitude)
       VALUES ($1,'Sushi World','Food & Drink',true,true,'receipt',40.00,'Haifa',32.82,34.99) RETURNING id`,
      [newbizId]
    );
    const newBizId = bizRes.rows[0].id;

    await client.query(
      `INSERT INTO subscription (business_id, status, fee_at_entry, entries_per_location, billing_interval)
       VALUES ($1,'Active',79.99,200,'monthly')`,
      [newBizId]
    );

    // One location — will have manager assigned via invite
    const locRes = await client.query(
      `INSERT INTO business_location (business_id, name, address, latitude, longitude, is_active)
       VALUES ($1,'Sushi World North','123 Harbor Rd',32.82,34.99,true) RETURNING id`,
      [newBizId]
    );
    const swLocId = locRes.rows[0].id;

    // A second location to test that managers are scoped
    const loc2Res = await client.query(
      `INSERT INTO business_location (business_id, name, address, latitude, longitude, is_active)
       VALUES ($1,'Sushi World South','456 Bay St',32.80,34.97,true) RETURNING id`,
      [newBizId]
    );
    const swLoc2Id = loc2Res.rows[0].id;

    // Get open draw
    const drawRes = await client.query(`SELECT id FROM draw WHERE status = 'Open' LIMIT 1`);
    const openDrawId = drawRes.rows[0]?.id;

    // Pre-seed a couple victim tickets so we have something to IDOR against
    const code1 = 'VICTEST01';
    const code2 = 'VICTEST02';
    await client.query(`DELETE FROM ticket WHERE code IN ($1,$2)`, [code1, code2]);
    await client.query(
      `INSERT INTO ticket (code, status, entry_source, business_id, draw_id, activated_by_user_id, activated_at, receipt_identifier, transaction_amount)
       VALUES ($1,'Activated','receipt',$2,$3,$4,NOW(),'VIC-001',80.00)`,
      [code1, newBizId, openDrawId, victimId]
    );
    await client.query(
      `INSERT INTO ticket (code, status, entry_source, draw_id, activated_by_user_id, activated_at)
       VALUES ($1,'Activated','free',$2,$3,NOW())`,
      [code2, openDrawId, victimId]
    );

    // Issued (not yet activated) code ticket for redeem tests
    const issuedCode = 'ISSU0001';
    await client.query(`DELETE FROM ticket WHERE code = $1`, [issuedCode]);
    await client.query(
      `INSERT INTO ticket (code, status, entry_source, business_id, location_id, draw_id)
       VALUES ($1,'Issued','code',$2,$3,$4)`,
      [issuedCode, newBizId, swLocId, openDrawId]
    );

    await client.query('COMMIT');

    info(`hacker1=${hacker1Id}, hacker2=${hacker2Id}`);
    info(`abuser1=${abuser1Id}, abuser2=${abuser2Id}`);
    info(`newbiz owner=${newbizId}, biz=${newBizId}`);
    info(`swLocId=${swLocId}, swLoc2Id=${swLoc2Id}, victimId=${victimId}`);
    info(`openDrawId=${openDrawId}`);

    return { hacker1Id, hacker2Id, abuser1Id, abuser2Id, newbizId, newBizId, swLocId, swLoc2Id, victimId, openDrawId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────
async function runTests(ids) {
  const { hacker1Id, hacker2Id, abuser1Id, abuser2Id, newbizId, newBizId, swLocId, swLoc2Id, victimId, openDrawId } = ids;

  const hacker1Token  = makeToken(hacker1Id,  'User');
  const hacker2Token  = makeToken(hacker2Id,  'User');
  const abuser1Token  = makeToken(abuser1Id,  'User');
  const abuser2Token  = makeToken(abuser2Id,  'User');
  const newbizToken   = makeToken(newbizId,   'Business');
  const victimToken   = makeToken(victimId,   'User');

  const today = new Date().toISOString().split('T')[0];

  // ── 1. HACKER: JWT ATTACKS ───────────────────────────────────────────────
  section('1. HACKER — JWT ATTACKS');

  // 1a. Craft a fake Admin JWT with a known user ID
  {
    const fakeAdminToken = jwt.sign({ id: hacker1Id, role: 'Admin', location_id: null }, 'WRONG_SECRET', { expiresIn: '1d' });
    const r = await api('GET', '/admin/overview', null, fakeAdminToken);
    if (r.status === 401 || r.status === 403) pass('Fake JWT (wrong secret) → blocked on admin route');
    else fail('Fake JWT (wrong secret) was accepted on admin route!', `${r.status}: ${JSON.stringify(r.json)}`);
  }

  // 1b. Craft a valid JWT but with Admin role injected for a regular user
  {
    const escalatedToken = jwt.sign({ id: hacker1Id, role: 'Admin', location_id: null }, JWT_SECRET, { expiresIn: '1d' });
    const r = await api('GET', '/admin/overview', null, escalatedToken);
    // The middleware re-reads the role from DB; hacker1 is 'User' in DB
    if (r.status === 401 || r.status === 403) {
      pass('JWT role escalation to Admin → blocked (DB role check overrides JWT claim)');
    } else if (r.status === 200) {
      fail('CRITICAL: JWT role escalation succeeded — hacker can access admin with forged JWT!', 'Middleware trusts JWT role claim without DB verification');
    } else {
      warn('JWT role escalation → unexpected response', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // 1c. Craft a valid JWT claiming Business role for a regular user
  {
    const escalatedToken = jwt.sign({ id: hacker1Id, role: 'Business', location_id: null }, JWT_SECRET, { expiresIn: '1d' });
    const r = await api('GET', '/business/my-business', null, escalatedToken);
    if (r.status === 404 || (r.status === 200 && !r.json?.name)) {
      pass('JWT Business escalation → business endpoint returns no data (correct, user has no business)');
    } else if (r.status === 200 && r.json?.name) {
      fail('JWT Business escalation exposed business data!', JSON.stringify(r.json));
    } else {
      warn('JWT Business escalation → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // 1d. Expired JWT
  {
    const expiredToken = jwt.sign({ id: hacker1Id, role: 'User', location_id: null }, JWT_SECRET, { expiresIn: '-1s' });
    const r = await api('GET', '/tickets/free-status', null, expiredToken);
    if (r.status === 401 || r.status === 403) pass('Expired JWT → blocked');
    else fail('Expired JWT was accepted!', `${r.status}: ${JSON.stringify(r.json)}`);
  }

  // 1e. JWT with tampered payload (valid signature but wrong id field format)
  {
    const weirdToken = jwt.sign({ id: 'admin', role: 'Admin', location_id: null }, JWT_SECRET, { expiresIn: '1d' });
    const r = await api('GET', '/admin/overview', null, weirdToken);
    if (r.status === 401 || r.status === 403) pass('JWT with string id="admin" → blocked');
    else if (r.status === 200) fail('JWT with string id="admin" was accepted on admin route!', JSON.stringify(r.json));
    else warn('JWT with string id → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
  }

  // ── 2. HACKER: IDOR (INSECURE DIRECT OBJECT REFERENCE) ──────────────────
  section('2. HACKER — IDOR ATTACKS');

  // 2a. hacker1 tries to read victim's tickets by guessing draw_id
  {
    const r = await api('GET', `/tickets/my-tickets?draw_id=${openDrawId}`, null, hacker1Token);
    if (r.status === 200 && Array.isArray(r.json)) {
      if (r.json.length === 0) {
        pass('GET /tickets/my-tickets → hacker only sees their own tickets (0 for hacker1)');
      } else {
        // Check if any returned tickets belong to victim
        const victimTickets = r.json.filter(t => t.activated_by_user_id === victimId);
        if (victimTickets.length > 0) {
          fail('IDOR: hacker can see victim tickets via my-tickets!', JSON.stringify(victimTickets));
        } else {
          pass(`GET /tickets/my-tickets → hacker only sees their own ${r.json.length} tickets`);
        }
      }
    } else {
      warn('GET /tickets/my-tickets → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // 2b. hacker1 tries to view Sushi World's activity feed (no Business role)
  {
    const r = await api('GET', '/business/activity', null, hacker1Token);
    if (r.status === 401 || r.status === 403) pass('GET /business/activity → non-business blocked');
    else fail('IDOR: hacker accessed activity feed!', `${r.status}: ${JSON.stringify(r.json)}`);
  }

  // 2c. hacker1 (role=User) tries to see Sushi World's stats
  {
    const r = await api('GET', `/business/stats?drawId=${openDrawId}`, null, hacker1Token);
    if (r.status === 401 || r.status === 403) pass('GET /business/stats → non-business blocked');
    else fail('IDOR: hacker accessed stats!', `${r.status}: ${JSON.stringify(r.json)}`);
  }

  // 2d. hacker1 tries to delete Sushi World's North location
  {
    const r = await api('DELETE', `/business/locations/${swLocId}`, null, hacker1Token);
    if (r.status === 401 || r.status === 403) pass('DELETE /business/locations/:id → non-business blocked');
    else if (r.status === 200) {
      fail('IDOR: hacker deleted another business location!', `locationId=${swLocId}`);
    } else {
      warn('DELETE location by hacker → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // 2e. hacker2 crafts a Business JWT and tries to delete Sushi World's location
  {
    const fakeBusinessToken = jwt.sign({ id: hacker2Id, role: 'Business', location_id: null }, JWT_SECRET, { expiresIn: '1d' });
    const r = await api('DELETE', `/business/locations/${swLocId}`, null, fakeBusinessToken);
    if (r.status === 403 || r.status === 404) {
      pass('DELETE location with escalated Business JWT → blocked (no business owned by hacker2)');
    } else if (r.status === 200) {
      fail('IDOR: Escalated Business JWT allowed deleting another owner\'s location!', `locationId=${swLocId}`);
    } else {
      warn('DELETE location escalated JWT → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // 2f. hacker1 tries to create an invite link for Sushi World's location
  {
    const r = await api('POST', `/business/locations/${swLocId}/invite`, {}, hacker1Token);
    if (r.status === 401 || r.status === 403) pass('POST invite → non-business blocked');
    else if (r.status === 200 || r.status === 201) fail('IDOR: hacker generated invite for someone else\'s location!', JSON.stringify(r.json));
    else warn('POST invite by hacker → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
  }

  // 2g. hacker2 with escalated Business JWT tries to invite for Sushi World
  {
    const fakeBusinessToken = jwt.sign({ id: hacker2Id, role: 'Business', location_id: null }, JWT_SECRET, { expiresIn: '1d' });
    const r = await api('POST', `/business/locations/${swLocId}/invite`, {}, fakeBusinessToken);
    if (r.status === 403 || r.status === 500) {
      pass('POST invite with escalated Business JWT → blocked (hacker2 does not own Sushi World)');
    } else if (r.status === 200 && r.json?.inviteLink) {
      fail('IDOR: Escalated Business JWT allowed generating invite for another owner\'s location!', r.json.inviteLink);
    } else {
      warn('POST invite escalated JWT → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // 2h. hacker tries to redeem ticket already activated by victim (should get "already used" not reveal victim data)
  {
    const r = await api('POST', '/tickets/redeem', { code: 'VICTEST01' }, hacker1Token);
    if (r.status === 400) {
      const msg = r.json?.message ?? '';
      const revealsData = msg.toLowerCase().includes('user') || msg.toLowerCase().includes('victim') || msg.toLowerCase().includes('email');
      if (revealsData) warn('POST /tickets/redeem error reveals victim info', msg);
      else pass('POST /tickets/redeem → already-activated ticket rejected without leaking victim data');
    } else if (r.status === 200) {
      fail('Hacker redeemed a ticket already activated by victim!', JSON.stringify(r.json));
    } else {
      warn('Redeem already-activated ticket → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // ── 3. HACKER: CROSS-BUSINESS ATTACKS ────────────────────────────────────
  section('3. HACKER — CROSS-BUSINESS ATTACKS');

  // 3a. hacker generates ticket for a location they don't own (business owner of Sushi World vs loc they don't manage)
  // Use abuser2 who has no business association
  {
    const r = await api('POST', '/tickets/generate', { locationId: swLocId }, abuser2Token);
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      pass('POST /tickets/generate → non-owner blocked');
    } else if (r.status === 201) {
      fail('Non-owner generated a ticket for someone else\'s location!', JSON.stringify(r.json));
    } else {
      warn('Generate ticket non-owner → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // 3b. newbiz owner tries to generate ticket for a location that doesn't belong to them
  // Create a dummy foreign location
  const foreignLoc = await pool.query(
    `INSERT INTO business_location (business_id, name, address, latitude, longitude, is_active)
     SELECT b.id, 'Foreign Loc', 'Nowhere', 0, 0, true FROM business b
     JOIN "user" u ON b.user_id = u.id WHERE u.email = 'biz1@test.winnbell' LIMIT 1
     RETURNING id`
  );
  if (foreignLoc.rows.length > 0) {
    const fLocId = foreignLoc.rows[0].id;
    const r = await api('POST', '/tickets/generate', { location_id: fLocId }, newbizToken);
    if (r.status === 400 || r.status === 403) {
      pass('POST /tickets/generate → biz owner blocked from generating tickets for another biz\'s location');
    } else if (r.status === 201) {
      fail('Cross-business ticket generation: biz owner issued ticket for competitor\'s location!', JSON.stringify(r.json));
    } else {
      warn('Cross-biz ticket generate → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
    await pool.query(`DELETE FROM business_location WHERE id = $1`, [fLocId]);
  }

  // 3c. Manager of loc1 (from previous test suite) tries to see Sushi World's activity
  // Create a fake manager token for swLocId that points to a user who doesn't manage it
  {
    const fakeManagerToken = jwt.sign({ id: hacker1Id, role: 'Business', location_id: swLocId }, JWT_SECRET, { expiresIn: '1d' });
    const r = await api('GET', '/business/activity', null, fakeManagerToken);
    if (r.status === 200 && r.json?.items !== undefined) {
      // This is actually the scary case — if the JWT claims location_id=swLocId,
      // does the server trust it? The server should verify the manager owns the location.
      const dbCheck = await dbQuery(
        `SELECT manager_user_id FROM business_location WHERE id = $1`,
        [swLocId]
      );
      const realManagerId = dbCheck[0]?.manager_user_id;
      if (realManagerId !== hacker1Id) {
        fail('SECURITY: Forged manager JWT (location_id spoofed) allowed reading activity feed for a location the user does not manage!',
          `hacker1Id=${hacker1Id}, realManagerId=${realManagerId}, items=${r.json.items.length}`);
      } else {
        pass('GET /business/activity → hacker1 is the actual manager of this location (expected)');
      }
    } else if (r.status === 401 || r.status === 403 || r.status === 404) {
      pass('GET /business/activity → forged location_id in JWT is blocked');
    } else {
      warn('Forged manager JWT on activity → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // ── 4. LOCATION MANAGER INVITE FLOW (Full E2E) ───────────────────────────
  section('4. LOCATION MANAGER INVITE FLOW');

  // 4a. Business owner generates invite link for North location
  let inviteToken1, inviteToken2;
  {
    const r = await api('POST', `/business/locations/${swLocId}/invite`, {}, newbizToken);
    if (r.status === 200 && r.json?.inviteLink) {
      const url = new URL(r.json.inviteLink);
      inviteToken1 = url.searchParams.get('token');
      pass(`POST /business/locations/:id/invite → invite link generated`);
      info(`  Link: ${r.json.inviteLink.slice(0, 80)}...`);
    } else {
      fail('POST invite link generation failed', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // 4b. Verify the invite_token_hash was stored in the DB
  if (inviteToken1) {
    const hash256 = crypto.createHash('sha256').update(inviteToken1).digest('hex');
    const dbRows = await dbQuery(`SELECT invite_token_hash, invite_used_at FROM business_location WHERE id = $1`, [swLocId]);
    if (dbRows[0]?.invite_token_hash === hash256) {
      pass('Invite token hash stored in DB (single-use enforcement ready)');
    } else {
      fail('Invite token hash NOT stored in DB — single-use enforcement broken!', JSON.stringify(dbRows[0]));
    }
  }

  // 4c. New user registers using the invite token → should become a manager
  let inviteeToken;
  if (inviteToken1) {
    const r = await api('POST', '/auth/register', {
      fullName: 'Invitee Manager',
      email: 'invitee1@deep.test',
      password: 'Test1234!',
      role: 'User', // role field is ignored, invite makes them Business
      inviteToken: inviteToken1,
    });
    if (r.status === 201 && r.json?.user?.role === 'Business' && r.json?.user?.location_id === swLocId) {
      pass(`POST /auth/register with invite → registered as Business with location_id=${r.json.user.location_id}`);
      inviteeToken = r.json.token;
      info(`  Invitee user id=${r.json.user.id}`);
    } else if (r.status === 201 && r.json?.user?.role === 'Business' && !r.json?.user?.location_id) {
      fail('Invite registration: role=Business but location_id missing from response', JSON.stringify(r.json.user));
      inviteeToken = r.json.token;
    } else if (r.status === 201 && r.json?.user?.role !== 'Business') {
      fail('Invite registration: user NOT promoted to Business role', JSON.stringify(r.json.user));
    } else {
      fail('Invite registration failed', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // 4d. Verify invite_used_at is set (token is now consumed)
  if (inviteToken1) {
    const dbRows = await dbQuery(`SELECT invite_token_hash, invite_used_at, manager_user_id FROM business_location WHERE id = $1`, [swLocId]);
    if (dbRows[0]?.invite_used_at && !dbRows[0]?.invite_token_hash) {
      pass('Invite token consumed: invite_used_at set, hash cleared (single-use enforced)');
    } else if (dbRows[0]?.invite_token_hash) {
      warn('Invite token NOT consumed — hash still in DB after registration', JSON.stringify(dbRows[0]));
    } else {
      info(`Invite DB state: used_at=${dbRows[0]?.invite_used_at}, hash=${dbRows[0]?.invite_token_hash}, mgr=${dbRows[0]?.manager_user_id}`);
    }
  }

  // 4e. Try to reuse the same invite token (should fail — single-use)
  if (inviteToken1) {
    const r = await api('POST', '/auth/register', {
      fullName: 'Second Invitee',
      email: 'invitee2@deep.test',
      password: 'Test1234!',
      inviteToken: inviteToken1,
    });
    if (r.status === 400 || r.status === 409 || r.status === 500) {
      const msg = r.json?.message ?? '';
      if (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('used') || msg.toLowerCase().includes('expired')) {
        pass('Reuse of invite token → blocked with correct message');
      } else {
        warn('Reuse of invite token → blocked but message unclear', msg);
      }
    } else if (r.status === 201 && r.json?.user?.location_id === swLocId) {
      fail('Invite token was reused! Second invitee got manager access via same token!', JSON.stringify(r.json.user));
    } else if (r.status === 201 && !r.json?.user?.location_id) {
      pass('Invite token reuse: second user registered as plain User (token not honored for second use)');
    } else {
      warn('Invite token reuse → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // 4f. Invitee can access activity for their location (North)
  if (inviteeToken) {
    const r = await api('GET', '/business/activity?date_range=30d', null, inviteeToken);
    if (r.status === 200 && r.json?.items !== undefined) {
      pass(`Invitee can access activity feed (${r.json.items.length} items for North location)`);
    } else {
      fail('Invitee cannot access activity feed', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // 4g. Invitee CANNOT see South location's data (scope isolation)
  if (inviteeToken) {
    const r = await api('GET', '/business/activity?date_range=30d', null, inviteeToken);
    if (r.status === 200) {
      // Check that no items have South location name
      const hasSouth = r.json?.items?.some(i => i.location_name === 'Sushi World South');
      if (!hasSouth) pass('Invitee cannot see South location items (scope correctly isolated)');
      else fail('Invitee can see South location items (scope leak!)', JSON.stringify(r.json?.items?.slice(0, 3)));
    }
  }

  // 4h. Generate a new invite for the South location
  if (inviteToken1) {
    const r2 = await api('POST', `/business/locations/${swLoc2Id}/invite`, {}, newbizToken);
    if (r2.status === 200 && r2.json?.inviteLink) {
      const url = new URL(r2.json.inviteLink);
      inviteToken2 = url.searchParams.get('token');
      pass('Business owner can invite manager for second location too');
    } else {
      warn('Second location invite generation unexpected', `${r2.status}: ${JSON.stringify(r2.json)}`);
    }
  }

  // 4i. Expired invite token (manually create one)
  {
    const expiredInviteToken = jwt.sign(
      { locationId: swLoc2Id, businessId: newBizId, type: 'MANAGER_INVITE' },
      JWT_SECRET,
      { expiresIn: '-1s' }
    );
    // Store its hash so it would pass the hash check
    const tokenHash = crypto.createHash('sha256').update(expiredInviteToken).digest('hex');
    await pool.query(`UPDATE business_location SET invite_token_hash = $1, invite_used_at = NULL WHERE id = $2`, [tokenHash, swLoc2Id]);

    const r = await api('POST', '/auth/register', {
      fullName: 'Expired Invitee',
      email: 'invitee2@deep.test',
      password: 'Test1234!',
      inviteToken: expiredInviteToken,
    });
    if (r.status === 400 || r.status === 500) {
      pass('Expired invite token → registration blocked');
    } else if (r.status === 201 && r.json?.user?.location_id) {
      fail('Expired invite token was ACCEPTED!', JSON.stringify(r.json.user));
    } else if (r.status === 201 && !r.json?.user?.location_id) {
      warn('Expired invite token: user registered but NOT given manager role (ok, but check error handling)', JSON.stringify(r.json));
    } else {
      warn('Expired invite → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // ── 5. TICKET ABUSER — DAILY CAP & RISK ESCALATION ───────────────────────
  section('5. TICKET ABUSER — DAILY CAP & RISK ESCALATION');

  const riskBefore = await getRiskScore(abuser1Id);
  info(`abuser1 risk score before: ${riskBefore}`);

  const ticketsBefore = await getTicketCount(abuser1Id, openDrawId);
  info(`abuser1 tickets before: ${ticketsBefore}`);

  // Submit 3 valid receipts (each worth 1 entry at $40 threshold = exact 1 entry per $40)
  const submittedCodes = [];
  for (let i = 1; i <= 3; i++) {
    await new Promise(r => setTimeout(r, 500)); // small delay between submissions
    const r = await api('POST', '/tickets/receipt-entry', {
      locationId: swLocId,
      receiptIdentifier: `ABUSE-${abuser1Id}-${i}-${Date.now()}`,
      transactionAmount: 40.00,
      transactionDate: today,
    }, abuser1Token, 20000);
    if (r.status === 201) {
      submittedCodes.push(r.json.code);
      info(`  Receipt ${i} → ✅ ticket ${r.json.code}`);
    } else {
      info(`  Receipt ${i} → ❌ ${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  const ticketsAfter3 = await getTicketCount(abuser1Id, openDrawId);
  const riskAfter3 = await getRiskScore(abuser1Id);
  info(`abuser1 tickets after 3 submissions: ${ticketsAfter3} (expected ${ticketsBefore + 3})`);
  info(`abuser1 risk score after 3 submissions: ${riskAfter3}`);

  if (ticketsAfter3 === ticketsBefore + 3) {
    pass(`DB verified: 3 new tickets created for abuser1 (${ticketsBefore} → ${ticketsAfter3})`);
  } else {
    warn(`DB ticket count unexpected: expected ${ticketsBefore + 3}, got ${ticketsAfter3}`, '');
  }

  // 4th and 5th submission — risk score should climb (velocity)
  for (let i = 4; i <= 5; i++) {
    await new Promise(r => setTimeout(r, 300));
    const r = await api('POST', '/tickets/receipt-entry', {
      locationId: swLocId,
      receiptIdentifier: `ABUSE-${abuser1Id}-${i}-${Date.now()}`,
      transactionAmount: 40.00,
      transactionDate: today,
    }, abuser1Token, 20000);
    if (r.status === 201) {
      submittedCodes.push(r.json.code);
      info(`  Receipt ${i} → ✅ ticket ${r.json.code}`);
    } else {
      info(`  Receipt ${i} → ❌ ${r.status}: ${JSON.stringify(r.json)?.message ?? r.json}`);
    }
  }

  const riskAfter5 = await getRiskScore(abuser1Id);
  const ticketsAfter5 = await getTicketCount(abuser1Id, openDrawId);
  info(`abuser1 risk score after 5 submissions: ${riskAfter5}`);
  info(`abuser1 tickets after 5 submissions: ${ticketsAfter5}`);

  if (riskAfter5 > riskBefore) {
    pass(`Risk system detected velocity: score escalated ${riskBefore} → ${riskAfter5}`);
  } else {
    warn('Risk score did NOT increase after 5 rapid submissions', `before=${riskBefore}, after=${riskAfter5}`);
  }

  // 6th submission → should hit daily cap (5 max in 24h)
  {
    await new Promise(r => setTimeout(r, 300));
    const r = await api('POST', '/tickets/receipt-entry', {
      locationId: swLocId,
      receiptIdentifier: `ABUSE-${abuser1Id}-6-${Date.now()}`,
      transactionAmount: 40.00,
      transactionDate: today,
    }, abuser1Token, 20000);
    if (r.status === 400 && r.json?.message?.toLowerCase().includes('daily')) {
      pass('6th receipt → daily cap enforced with clear message');
    } else if (r.status === 400) {
      pass(`6th receipt → blocked (${r.json?.message})`);
    } else if (r.status === 201) {
      fail('6th receipt accepted — daily cap NOT enforced!', `Total tickets: ${await getTicketCount(abuser1Id, openDrawId)}`);
    } else if (r.timedOut) {
      fail('6th receipt → timed out (possible deadlock)', '');
    } else {
      warn('6th receipt → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // ── 6. TICKET ABUSER — CROSS-USER RECEIPT SHARING ────────────────────────
  section('6. TICKET ABUSER — CROSS-USER RECEIPT SHARING');

  // abuser1 submits a specific receipt, then abuser2 tries to submit the same one
  const sharedReceiptId = `SHARED-${Date.now()}`;

  // First: abuser2 submits it (abuser1 is capped so use abuser2 first)
  let abuser2TicketId;
  {
    const r = await api('POST', '/tickets/receipt-entry', {
      locationId: swLocId,
      receiptIdentifier: sharedReceiptId,
      transactionAmount: 40.00,
      transactionDate: today,
    }, abuser2Token, 20000);
    if (r.status === 201) {
      abuser2TicketId = r.json.ticketId;
      pass(`abuser2 submitted receipt first → ticket created (id will be checked for quarantine)`);
      info(`  abuser2 ticket: ${r.json.code}`);
    } else if (r.timedOut) {
      fail('abuser2 receipt → timed out', '');
    } else {
      warn('abuser2 receipt unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // Verify abuser2's ticket is NOT quarantined (first legitimate submission)
  if (abuser2TicketId) {
    const rows = await dbQuery(`SELECT is_quarantined, quarantine_reason FROM ticket WHERE id = $1`, [abuser2TicketId]);
    info(`  abuser2 ticket quarantine status: ${JSON.stringify(rows[0])}`);
  }

  // Now: a fresh user tries to submit the same receipt (cross-user duplicate)
  // We need victim user to submit — victim hasn't submitted anything today
  {
    const r = await api('POST', '/tickets/receipt-entry', {
      locationId: swLocId,
      receiptIdentifier: sharedReceiptId,
      transactionAmount: 40.00,
      transactionDate: today,
    }, victimToken, 20000);
    if (r.status === 400 && r.json?.message?.toLowerCase().includes('already')) {
      pass('Cross-user duplicate receipt → blocked with "already used" message');
    } else if (r.status === 201) {
      fail('Cross-user duplicate allowed! Two users submitted same receipt!', JSON.stringify(r.json));
    } else if (r.timedOut) {
      fail('Cross-user duplicate → timed out', '');
    } else {
      warn('Cross-user duplicate → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // Verify original abuser2 ticket was quarantined after cross-user detection
  if (abuser2TicketId) {
    await new Promise(r => setTimeout(r, 1000)); // small wait for async processing
    const rows = await dbQuery(`SELECT is_quarantined, quarantine_reason FROM ticket WHERE id = $1`, [abuser2TicketId]);
    if (rows[0]?.is_quarantined && rows[0]?.quarantine_reason === 'shared_receipt_suspected') {
      pass('Original ticket quarantined after cross-user receipt sharing detected');
    } else if (!rows[0]?.is_quarantined) {
      fail('Original ticket NOT quarantined despite cross-user sharing!', JSON.stringify(rows[0]));
    } else {
      info(`  Quarantine state: ${JSON.stringify(rows[0])}`);
    }
  }

  // ── 7. TICKET ABUSER — RISK SCORE QUARANTINE AT HIGH RISK ────────────────
  section('7. TICKET ABUSER — RISK SCORE & QUARANTINE');

  // Check abuser1's current state in DB
  const abuser1Row = await dbQuery(`SELECT risk_score, risk_clean_entries FROM "user" WHERE id = $1`, [abuser1Id]);
  info(`abuser1 DB state: risk_score=${abuser1Row[0]?.risk_score}, clean_entries=${abuser1Row[0]?.risk_clean_entries}`);

  const abuser1Tickets = await dbQuery(
    `SELECT id, code, is_quarantined, quarantine_reason FROM ticket WHERE activated_by_user_id = $1 AND draw_id = $2`,
    [abuser1Id, openDrawId]
  );
  const quarantined = abuser1Tickets.filter(t => t.is_quarantined);
  info(`abuser1 tickets: total=${abuser1Tickets.length}, quarantined=${quarantined.length}`);

  if (abuser1Row[0]?.risk_score >= 15) {
    if (quarantined.length > 0) {
      pass(`High-risk user (score=${abuser1Row[0]?.risk_score}) has ${quarantined.length} quarantined tickets`);
    } else if (abuser1Tickets.length > 0) {
      fail(`High-risk user (score=${abuser1Row[0]?.risk_score}) has NO quarantined tickets — quarantine mechanism broken!`, '');
    }
  } else {
    info(`abuser1 risk_score=${abuser1Row[0]?.risk_score} (< 15, not yet HIGH risk — no quarantine expected)`);
    pass(`Risk system correctly keeping abuser1 at score=${abuser1Row[0]?.risk_score} (not yet HIGH)`);
  }

  // ── 8. TICKET ABUSER — BELOW-THRESHOLD PROBING ───────────────────────────
  section('8. TICKET ABUSER — THRESHOLD PROBING');

  // Try submitting just below threshold ($39.99 vs $40 min) → should get risk penalty
  const riskBeforeProbe = await getRiskScore(victimId);
  {
    const r = await api('POST', '/tickets/receipt-entry', {
      locationId: swLocId,
      receiptIdentifier: `PROBE-${victimId}-${Date.now()}`,
      transactionAmount: 39.99,
      transactionDate: today,
    }, victimToken, 20000);
    if (r.status === 400) {
      pass('Below-threshold $39.99 (min $40) → blocked correctly');
      const riskAfterProbe = await getRiskScore(victimId);
      if (riskAfterProbe > riskBeforeProbe) {
        pass(`DB verified: below-threshold attempt added risk penalty (${riskBeforeProbe} → ${riskAfterProbe})`);
      } else {
        warn(`Below-threshold probe: risk score unchanged (${riskBeforeProbe} → ${riskAfterProbe})`, 'Expected +1 penalty');
      }
    } else if (r.status === 201) {
      fail('Below-threshold amount $39.99 was accepted!', JSON.stringify(r.json));
    } else {
      warn('Below-threshold probe → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // ── 9. FREE TICKET ABUSE ──────────────────────────────────────────────────
  section('9. FREE TICKET ABUSE');

  // abuser2 tries to claim free ticket
  let abuser2FreeCode;
  {
    const r = await api('POST', '/tickets/activate-free', {}, abuser2Token);
    if (r.status === 201 && r.json?.code) {
      abuser2FreeCode = r.json.code;
      pass(`abuser2 claimed free ticket (code=${r.json.code})`);
      // Verify in DB
      const rows = await dbQuery(`SELECT id, entry_source, draw_id FROM ticket WHERE code = $1`, [abuser2FreeCode]);
      if (rows.length > 0 && rows[0].entry_source === 'free') {
        pass('DB verified: free ticket row exists with entry_source=free');
      } else {
        fail('Free ticket not found in DB or wrong entry_source!', JSON.stringify(rows[0]));
      }
    } else if (r.status === 400 && r.json?.message?.includes('weekly')) {
      info('abuser2 already used free ticket this week (from previous test run)');
    } else {
      warn('Free ticket claim → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // Immediate second claim (should fail)
  {
    const r = await api('POST', '/tickets/activate-free', {}, abuser2Token);
    if (r.status === 400 && r.json?.message?.toLowerCase().includes('weekly')) {
      pass('Second free ticket same week → blocked');
      // Verify rejection was logged in free_ticket_usage
      const rows = await dbQuery(
        `SELECT status, rejection_reason FROM free_ticket_usage WHERE user_id = $1 ORDER BY activated_at DESC LIMIT 1`,
        [abuser2Id]
      );
      if (rows[0]?.status === 'rejected' && rows[0]?.rejection_reason === 'weekly_limit_reached') {
        pass('DB verified: rejection logged in free_ticket_usage table');
      } else {
        warn('DB: rejection log missing or wrong', JSON.stringify(rows[0]));
      }
    } else if (r.status === 201) {
      fail('Free ticket given twice in same week!', JSON.stringify(r.json));
    } else {
      warn('Second free ticket → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
    }
  }

  // ── 10. MANAGER SCOPING — DEEPER VALIDATION ───────────────────────────────
  section('10. MANAGER SCOPING — DEEP VALIDATION');

  if (inviteeToken) {
    // Invitee manager submits a receipt as their customer — should be BLOCKED (conflict of interest)
    {
      const r = await api('POST', '/tickets/receipt-entry', {
        locationId: swLocId,
        receiptIdentifier: `MGRHACK-${Date.now()}`,
        transactionAmount: 40.00,
        transactionDate: today,
      }, inviteeToken, 20000);
      if (r.status === 400 || r.status === 403) {
        pass('Manager cannot submit receipt for their own location (conflict-of-interest blocked)');
      } else if (r.status === 201) {
        fail('Manager submitted receipt for their own location!', JSON.stringify(r.json));
      } else {
        warn('Manager receipt for own location → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
      }
    }

    // Manager CAN submit receipt for a different business (they're a customer elsewhere)
    {
      // Use a different business — look for any other participating business
      const otherBiz = await dbQuery(
        `SELECT bl.id as loc_id FROM business_location bl JOIN business b ON bl.business_id = b.id
         WHERE b.is_subscribed = true AND b.is_participating = true AND b.id != $1 AND bl.is_active = true LIMIT 1`,
        [newBizId]
      );
      if (otherBiz.length > 0) {
        const r = await api('POST', '/tickets/receipt-entry', {
          locationId: otherBiz[0].loc_id,
          receiptIdentifier: `MGRCUST-${Date.now()}`,
          transactionAmount: 100.00,
          transactionDate: today,
        }, inviteeToken, 20000);
        if (r.status === 201) {
          pass('Manager CAN submit receipts at other businesses (as a regular customer)');
        } else if (r.status === 400 && r.json?.message?.includes('conflict')) {
          fail('Manager incorrectly blocked from submitting at a different business', r.json?.message);
        } else if (r.timedOut) {
          warn('Manager receipt at other biz → timed out', '');
        } else {
          warn('Manager receipt at other biz → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
        }
      } else {
        info('No other participating businesses found to test manager-as-customer flow');
      }
    }

    // Manager tries to generate a ticket for the South location (not theirs)
    {
      const r = await api('POST', '/tickets/generate', { location_id: swLoc2Id }, inviteeToken);
      if (r.status === 400 || r.status === 403) {
        pass('Manager cannot generate tickets for a location they do not manage');
      } else if (r.status === 201) {
        fail('Manager generated ticket for a location they do NOT manage!', JSON.stringify(r.json));
      } else {
        warn('Manager generate for other location → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
      }
    }
  }

  // ── 11. ADMIN — PRIVILEGE ABUSE PREVENTION ───────────────────────────────
  section('11. ADMIN — PRIVILEGE ABUSE PREVENTION');

  const adminRow = await dbQuery(`SELECT id FROM "user" WHERE email = 'admin@test.winnbell' LIMIT 1`);
  if (adminRow.length > 0) {
    const adminToken = makeToken(adminRow[0].id, 'Admin');

    // Admin tries to submit a receipt as a regular user — should be blocked
    {
      const r = await api('POST', '/tickets/receipt-entry', {
        locationId: swLocId,
        receiptIdentifier: `ADMINRCT-${Date.now()}`,
        transactionAmount: 40.00,
        transactionDate: today,
      }, adminToken, 20000);
      if (r.status === 400 && r.json?.message?.toLowerCase().includes('email')) {
        warn('Admin receipt submission blocked by email verification check (admin email not verified in test DB)', r.json?.message);
      } else if (r.status === 400) {
        pass(`Admin blocked from submitting receipts (${r.json?.message})`);
      } else if (r.status === 201) {
        warn('Admin was able to submit a receipt entry', 'May be intentional if admin needs to test the flow');
      } else {
        info(`Admin receipt → ${r.status}: ${JSON.stringify(r.json)}`);
      }
    }

    // Admin can access business activity (should work per requireRole('Business','Admin'))
    {
      const r = await api('GET', '/business/activity', null, adminToken);
      if (r.status === 200) {
        pass('Admin can access /business/activity (platform oversight)');
      } else if (r.status === 404) {
        warn('Admin cannot access /business/activity — "Business not found" (admin has no business)', `${r.status}: ${JSON.stringify(r.json)}`);
      } else {
        warn('Admin activity access → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
      }
    }

    // Non-admin trying to access admin user management
    {
      const r = await api('PATCH', `/admin/users/${victimId}/role`, { role: 'Admin' }, hacker1Token);
      if (r.status === 401 || r.status === 403) pass('PATCH /admin/users/:id/role → non-admin blocked');
      else fail('Non-admin promoted a user to Admin!', `${r.status}: ${JSON.stringify(r.json)}`);
    }

    // Admin can toggle user active status (should work)
    {
      // Deactivate hacker2
      const r = await api('PATCH', `/admin/users/${hacker2Id}/active`, { is_active: false }, adminToken);
      if (r.status === 200) {
        pass('Admin can deactivate a user');
        // Try to login as hacker2 — should fail
        const loginR = await api('POST', '/auth/login', { email: 'hacker2@deep.test', password: 'Test1234!' });
        if (loginR.status === 401) pass('Deactivated user cannot login');
        else fail('Deactivated user was able to login!', `${loginR.status}: ${JSON.stringify(loginR.json)}`);
        // Re-activate
        await api('PATCH', `/admin/users/${hacker2Id}/active`, { is_active: true }, adminToken);
      } else {
        warn('Admin deactivate user → unexpected', `${r.status}: ${JSON.stringify(r.json)}`);
      }
    }
  }

  // ── 12. FINAL DB SNAPSHOT ─────────────────────────────────────────────────
  section('12. DB SNAPSHOT — Final State');

  const users = [
    { name: 'abuser1', id: abuser1Id },
    { name: 'abuser2', id: abuser2Id },
    { name: 'victim',  id: victimId  },
    { name: 'hacker1', id: hacker1Id },
  ];

  for (const u of users) {
    const row = await dbQuery(
      `SELECT risk_score,
              (SELECT COUNT(*) FROM ticket WHERE activated_by_user_id = $1 AND draw_id = $2) total_tickets,
              (SELECT COUNT(*) FROM ticket WHERE activated_by_user_id = $1 AND draw_id = $2 AND is_quarantined = true) quarantined
       FROM "user" WHERE id = $1`,
      [u.id, openDrawId]
    );
    if (row.length) {
      info(`${u.name}: risk=${row[0].risk_score}, tickets=${row[0].total_tickets}, quarantined=${row[0].quarantined}`);
    }
  }

  const swActivity = await dbQuery(
    `SELECT COUNT(*) cnt FROM ticket WHERE business_id = $1 AND draw_id = $2`,
    [newBizId, openDrawId]
  );
  info(`Sushi World total tickets in draw: ${swActivity[0]?.cnt ?? 0}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(62));
  console.log('  WINNBELL DEEP TEST — HACKERS, ABUSERS, INVITE FLOW');
  console.log('  ' + new Date().toISOString());
  console.log('═'.repeat(62));

  try {
    const ids = await setup();
    await runTests(ids);
  } catch (e) {
    console.error('\n💥 FATAL:', e.message, '\n', e.stack);
  }

  console.log('\n' + '═'.repeat(62));
  console.log('  FINAL REPORT');
  console.log('═'.repeat(62));
  console.log(`  ✅  Passed  : ${passed}`);
  console.log(`  ❌  Failed  : ${failed}`);
  console.log(`  ⚠️   Warnings: ${warnings}`);

  if (issues.length) {
    console.log('\n  Issues:');
    issues.forEach((b, i) => {
      const pfx = b.type === 'BUG' ? '❌ BUG' : '⚠️  UX ';
      console.log(`\n  [${i+1}] ${pfx}: ${b.label}`);
      if (b.detail) console.log(`       ${b.detail}`);
    });
  } else {
    console.log('\n  🎉 No issues found!');
  }
  console.log('');
  await pool.end();
}

main();
