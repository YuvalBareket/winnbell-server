import twilio from 'twilio';
import { getPool } from '../../shared/db/db.js';
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

  const normalizedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+1${phoneNumber.replace(/\D/g, '')}`;

  // Validate E.164 format: + followed by 10-15 digits
  const digits = normalizedPhone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    throw new Error('INVALID_PHONE');
  }

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

  const isDev = process.env.NODE_ENV !== 'production';
  const code = isDev ? '123456' : String(crypto.randomInt(100000, 999999));

  // Insert new OTP — do NOT delete old rows first so rate limit history is preserved.
  // Old expired rows are cleaned up lazily on the next send.
  await pool.query(`DELETE FROM phone_otp WHERE user_id = $1 AND expires_at <= NOW()`, [userId]);
  await pool.query(
    `INSERT INTO phone_otp (user_id, phone_number, code, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
    [userId, normalizedPhone, code],
  );

  if (!isDev) {
    await twilioClient.messages.create({
      to: normalizedPhone,
      from: process.env.TWILIO_FROM_NUMBER!,
      body: `Your Winnbell verification code is: ${code}. Valid for ${OTP_EXPIRY_MINUTES} minutes. Do not share this code. Reply STOP to opt out. Msg & data rates may apply.`,
    });
  }
};

export const verifyPhoneOtp = async (userId: number, code: string): Promise<void> => {
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
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
