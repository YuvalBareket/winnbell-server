import crypto from 'crypto';
import { getPool, PoolClient } from '../../shared/db/db.js';
import { generateGlobalUniqueCode, MAX_ENTRIES_PER_DRAW } from '../tickets/tickets.service.js';

// Readable code (no ambiguous O/0/I/1/L) for shareable links.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genReferralCode = (len = 8): string =>
  Array.from({ length: len }, () => CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)]).join('');

/**
 * Return the user's shareable referral code, lazily generating + storing a unique one on
 * first call. Handles code collisions (retry) and concurrent generation (re-read).
 */
export const getOrCreateReferralCode = async (userId: number): Promise<string> => {
  const pool = getPool();
  const existing = await pool.query(`SELECT referral_code FROM "user" WHERE id = $1`, [userId]);
  if (existing.rows[0]?.referral_code) return existing.rows[0].referral_code;

  for (let attempt = 0; attempt < 10; attempt++) {
    const code = genReferralCode();
    try {
      const r = await pool.query(
        `UPDATE "user" SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL RETURNING referral_code`,
        [code, userId],
      );
      if (r.rowCount && r.rowCount > 0) return code;
      // referral_code was set by a concurrent request — re-read and use it.
      const re = await pool.query(`SELECT referral_code FROM "user" WHERE id = $1`, [userId]);
      if (re.rows[0]?.referral_code) return re.rows[0].referral_code;
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === '23505') continue; // code collision — try another
      throw e;
    }
  }
  throw new Error('Could not generate a referral code');
};

/**
 * Resolve a referral code to the referrer's FIRST NAME only (for the landing page's social
 * proof). Returns null for an invalid/inactive code. First-name-only protects privacy.
 */
export const resolveReferrerByCode = async (
  code: string,
): Promise<{ id: number; firstName: string } | null> => {
  const pool = getPool();
  const r = await pool.query(
    `SELECT id, full_name FROM "user" WHERE referral_code = $1 AND is_active = TRUE LIMIT 1`,
    [code],
  );
  const row = r.rows[0];
  if (!row) return null;
  const firstName = (row.full_name ?? '').trim().split(/\s+/)[0] || 'A friend';
  return { id: Number(row.id), firstName };
};

/**
 * Resolve a referral code to the referrer's user id, for attaching to a NEW registration.
 * Returns null for an invalid code OR if it would be a self-referral (referrer === newUser).
 */
export const resolveReferrerIdForSignup = async (
  code: string | undefined | null,
  newUserEmail: string,
): Promise<number | null> => {
  if (!code || typeof code !== 'string') return null;
  const pool = getPool();
  const r = await pool.query(
    `SELECT id, email FROM "user" WHERE referral_code = $1 AND is_active = TRUE LIMIT 1`,
    [code.trim()],
  );
  const row = r.rows[0];
  if (!row) return null;
  // Self-referral guard: never let a code resolve to the same email that is registering.
  if (String(row.email).toLowerCase() === newUserEmail.toLowerCase()) return null;
  return Number(row.id);
};

/**
 * Called inside the phone-verification transaction. If this user was referred on a fresh
 * signup (referred_by set) and not yet rewarded, grant a one-time 'referral' bonus entry in
 * the current open draw, respecting the per-user 30-cap. Idempotent (rewarded_at + FOR UPDATE).
 * Returns true if a bonus was granted. No open draw or at-cap → skips (leaves it pending).
 */
export const grantPendingReferralBonus = async (
  client: PoolClient,
  userId: number,
): Promise<boolean> => {
  // Shared per-user cap lock (same key the entry paths use) so the bonus can't overshoot 30.
  await client.query(`SELECT pg_advisory_xact_lock(10, hashtext('udcap:' || $1::text))`, [userId]);

  // Referral attribution + reward state live in user_acquisition (1:1 with the user).
  const u = await client.query(
    `SELECT referred_by_user_id, referral_rewarded_at FROM user_acquisition WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  const row = u.rows[0];
  if (!row || row.referred_by_user_id === null || row.referral_rewarded_at !== null) return false;

  const draw = await client.query(
    `SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1`,
  );
  const drawId = draw.rows[0]?.id;
  if (!drawId) return false; // no open draw — skip for now (design: revisit hold-for-next-draw)

  const cap = await client.query(
    `SELECT COUNT(*)::int AS c FROM ticket WHERE activated_by_user_id = $1 AND draw_id = $2`,
    [userId, drawId],
  );
  if (cap.rows[0].c >= MAX_ENTRIES_PER_DRAW) return false; // already at cap — skip

  const code = await generateGlobalUniqueCode(client);
  await client.query(
    `INSERT INTO ticket (code, status, entry_source, business_id, location_id, draw_id, activated_by_user_id, activated_at)
     VALUES ($1, 'Activated', 'referral', NULL, NULL, $2, $3, NOW())`,
    [code, drawId, userId],
  );
  await client.query(`UPDATE user_acquisition SET referral_rewarded_at = NOW() WHERE user_id = $1`, [userId]);
  return true;
};
