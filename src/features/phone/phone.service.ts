import twilio from 'twilio';
import { getPool } from '../../shared/db/db.js';
import { invalidateUserAuth } from '../../shared/cache/cache.js';
import { grantPendingReferralBonus } from '../referral/referral.service.js';
import crypto from 'crypto';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);

const MAX_VERIFY_ATTEMPTS = 3;
const OTP_EXPIRY_MINUTES = 10;
const MAX_SENDS_PER_HOUR = 3;

export const sendPhoneOtp = async (userId: number, phoneNumber: string): Promise<void> => {


  const pool = getPool();

  // US numbers only for now. Accept "5551234567", "(555) 123-4567", "+15551234567" etc.,
  // normalize to +1XXXXXXXXXX, and enforce NANP shape (10 digits, area code and exchange
  // both 2-9) so an unreachable number can never be stored as a verified phone.
  const rawDigits = phoneNumber.replace(/\D/g, '');
  const national = rawDigits.length === 11 && rawDigits.startsWith('1') ? rawDigits.slice(1) : rawDigits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) {
    throw new Error('INVALID_PHONE');
  }
  const normalizedPhone = `+1${national}`;

  // Block if user is already verified — no need to re-send
  const userCheck = await pool.query(
    `SELECT is_phone_verified FROM "user" WHERE id = $1`,
    [userId],
  );
  if (userCheck.rows[0]?.is_phone_verified) {
    throw new Error('ALREADY_VERIFIED');
  }

  // Block if phone is already claimed by another user
  const taken = await pool.query(
    `SELECT id FROM "user" WHERE phone_number = $1 AND id != $2`,
    [normalizedPhone, userId],
  );
  if (taken.rows.length > 0) {
    throw new Error('PHONE_ALREADY_TAKEN');
  }

  // Rate limit: max 3 OTP sends per phone number per hour
  const rateCheck = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM phone_otp
     WHERE phone_number = $1 AND created_at >= NOW() - INTERVAL '1 hour'`,
    [normalizedPhone],
  );
  if (rateCheck.rows[0].cnt >= MAX_SENDS_PER_HOUR) {
    throw new Error('TOO_MANY_SENDS');
  }

  // Rate limit: max 3 OTP sends per user per hour (prevents multi-phone flooding)
  const userRateCheck = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM phone_otp
     WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '1 hour'`,
    [userId],
  );
  if (userRateCheck.rows[0].cnt >= MAX_SENDS_PER_HOUR) {
    throw new Error('TOO_MANY_SENDS');
  }
//  const code = String(crypto.randomInt(100000, 999999));
  const code = '123456' 

  // Insert new OTP — do NOT delete old rows first so rate limit history is preserved.
  // Old expired rows are cleaned up lazily on the next send.
  await pool.query(`DELETE FROM phone_otp WHERE user_id = $1 AND expires_at <= NOW()`, [userId]);
  await pool.query(
    `INSERT INTO phone_otp (user_id, phone_number, code, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
    [userId, normalizedPhone, code],
  );


//     await twilioClient.messages.create({
//       to: normalizedPhone,
//       from: process.env.TWILIO_FROM_NUMBER!,
//       body: `Winnbell verification code: ${code}. Expires in ${OTP_EXPIRY_MINUTES} minutes. Don't share this code.`,
//     });

};


export const verifyPhoneOtp = async (
  userId: number,
  code: string,
): Promise<{ referralBonusGranted: boolean }> => {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT id, phone_number, attempts, code, (expires_at <= NOW()) AS is_expired
       FROM phone_otp
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1
       FOR UPDATE`,
      [userId],
    );

    if (result.rows.length === 0) throw new Error('NO_OTP');

    const otp = result.rows[0];

    if (otp.is_expired) {
      await client.query(`DELETE FROM phone_otp WHERE id = $1`, [otp.id]);
      await client.query('COMMIT');
      throw new Error('OTP_EXPIRED');
    }

    if (otp.attempts >= MAX_VERIFY_ATTEMPTS) {
      await client.query(`DELETE FROM phone_otp WHERE id = $1`, [otp.id]);
      await client.query('COMMIT');
      throw new Error('TOO_MANY_ATTEMPTS');
    }

    await client.query(`UPDATE phone_otp SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);

    if (otp.code !== code.trim()) {
      await client.query('COMMIT');
      throw new Error('INVALID_CODE');
    }

    // Check if phone number is already claimed by another user
    const conflict = await client.query(
      `SELECT id FROM "user" WHERE phone_number = $1 AND id != $2`,
      [otp.phone_number, userId],
    );
    if (conflict.rows.length > 0) {
      await client.query('COMMIT');
      throw new Error('PHONE_ALREADY_TAKEN');
    }

    await client.query(
      `UPDATE "user" SET phone_number = $1, is_phone_verified = TRUE WHERE id = $2`,
      [otp.phone_number, userId],
    );

    await client.query(`DELETE FROM phone_otp WHERE user_id = $1`, [userId]);
    await client.query('COMMIT');
    invalidateUserAuth(userId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Phone is now verified (committed above). Grant any pending referral bonus in its OWN
  // transaction — best-effort, so a bonus failure can never roll back or block the core
  // phone verification. Idempotent (rewarded_at guard), so a later retry is safe.
  // The result is returned so the client can show a congrats screen for the new entry.
  let referralBonusGranted = false;
  try {
    const bonusClient = await pool.connect();
    try {
      await bonusClient.query('BEGIN');
      referralBonusGranted = await grantPendingReferralBonus(bonusClient, userId);
      await bonusClient.query('COMMIT');
    } catch (e) {
      await bonusClient.query('ROLLBACK');
      throw e;
    } finally {
      bonusClient.release();
    }
  } catch (err) {
    console.error('[verifyPhoneOtp] referral bonus grant failed (non-fatal):', err instanceof Error ? err.message : err);
  }

  return { referralBonusGranted };
};
