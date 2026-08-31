import { Request, Response } from 'express';
import twilio from 'twilio';
import * as phoneService from './phone.service.js';
import { validateLength } from '../../shared/validation.js';
import { getPool } from '../../shared/db/db.js';
import { recordFunnelEvent } from '../analytics/analytics.service.js';

const funnelSessionId = (req: Request): string | null => {
  const v = req.headers?.['x-wb-fsid'];
  return typeof v === 'string' ? v : null;
};

// Consumer funnel only: phone verification is a consumer flow (Business/Manager accounts
// are exempt), but the routes are only authenticateToken-gated - a staff account calling
// them must not pollute the OTP funnel. The Twilio delivery webhook has no req.user; the
// dashboard's role filter covers that path.
const isConsumer = (req: Request): boolean => req.user?.role === 'User';

export const sendOtp = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  const { phoneNumber } = req.body;
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    res.status(400).json({ message: 'Phone number is required.' });
    return;
  }
  const phoneErr = validateLength('Phone number', phoneNumber, 20);
  if (phoneErr) { res.status(400).json({ message: phoneErr }); return; }

  try {
    await phoneService.sendPhoneOtp(userId, phoneNumber);
    res.json({ success: true });
    if (isConsumer(req)) recordFunnelEvent({ eventType: 'otp_requested', userId, sessionId: funnelSessionId(req) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'PHONE_VERIFY_DISABLED') {
      res.status(503).json({ message: 'Phone verification is not available yet. Please try again later.' });
      return;
    }
    if (msg === 'ALREADY_VERIFIED') {
      res.status(400).json({ message: 'Your phone number is already verified.' });
      return;
    }
    if (msg === 'PHONE_ALREADY_TAKEN') {
      res.status(409).json({ message: 'This phone number is already linked to another account.' });
      return;
    }
    if (msg === 'INVALID_PHONE') {
      res.status(400).json({ message: 'Invalid phone number format.' });
      return;
    }
    if (msg === 'TOO_MANY_SENDS') {
      res.status(429).json({ message: 'Too many verification requests. Please wait before trying again.' });
      return;
    }
    if (msg === 'RESEND_TOO_SOON') {
      res.status(429).json({ message: 'We just sent you a code. Give it a minute before requesting another.' });
      return;
    }
    if (msg === 'SMS_SEND_FAILED') {
      res.status(502).json({ message: 'We could not send the code right now. Please try again in a moment.' });
      // Funnel: only a real send failure counts as otp_send_failed (business gates like
      // ALREADY_VERIFIED / RESEND_TOO_SOON are not delivery-funnel signal). After the response.
      if (isConsumer(req)) {
        recordFunnelEvent({
          eventType: 'otp_send_failed', userId, sessionId: funnelSessionId(req), reasonCode: 'send_error',
        });
      }
      return;
    }
    console.error('[phone] sendOtp error:', err);
    res.status(500).json({ message: 'Failed to send verification code.' });
  }
};

export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    res.status(400).json({ message: 'Verification code is required.' });
    return;
  }
  const codeErr = validateLength('Verification code', code, 6);
  if (codeErr) { res.status(400).json({ message: codeErr }); return; }

  // Funnel: attempted + outcome, both emitted strictly AFTER the response so the
  // analytics write never competes with the verify path for a pool connection.
  const attempted = () => {
    if (isConsumer(req)) recordFunnelEvent({ eventType: 'otp_verify_attempted', userId, sessionId: funnelSessionId(req) });
  };
  try {
    const { referralBonusGranted } = await phoneService.verifyPhoneOtp(userId, code);
    res.json({ success: true, referralBonusGranted });
    attempted();
    if (isConsumer(req)) recordFunnelEvent({ eventType: 'otp_verified', userId, sessionId: funnelSessionId(req) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    const verifyFailed = (reason: 'wrong_code' | 'expired' | 'too_many_attempts') => {
      attempted();
      if (isConsumer(req)) recordFunnelEvent({ eventType: 'otp_verify_failed', userId, sessionId: funnelSessionId(req), reasonCode: reason });
    };
    if (msg === 'NO_OTP') { res.status(400).json({ message: 'No verification code found. Please request a new one.' }); attempted(); return; }
    if (msg === 'OTP_EXPIRED') { res.status(400).json({ message: 'Verification code expired. Please request a new one.' }); verifyFailed('expired'); return; }
    if (msg === 'TOO_MANY_ATTEMPTS') { res.status(429).json({ message: 'Too many failed attempts. Please request a new code.' }); verifyFailed('too_many_attempts'); return; }
    if (msg === 'INVALID_CODE') { res.status(400).json({ message: 'Invalid verification code.' }); verifyFailed('wrong_code'); return; }
    if (msg === 'PHONE_ALREADY_TAKEN') { res.status(409).json({ message: 'This phone number is already linked to another account.' }); attempted(); return; }
    console.error('[phone] verifyOtp error:', err);
    res.status(500).json({ message: 'Verification failed.' });
    attempted();
  }
};

// POST /webhooks/twilio-status - Twilio Programmable Messaging delivery callback for OTP
// SMS (statusCallback set in phone.service when TWILIO_STATUS_CALLBACK_URL is configured).
// Public route, urlencoded body, X-Twilio-Signature validated against the auth token.
// Always answers 204: a callback problem must never make Twilio retry-storm us.
export const twilioStatusWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const callbackUrl = process.env.TWILIO_STATUS_CALLBACK_URL;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    // No callback URL = delivery receipts intentionally off. URL set but no auth token =
    // misconfiguration that would silently drop every receipt - say so in the logs.
    if (callbackUrl && !authToken) {
      console.warn('[phone] TWILIO_STATUS_CALLBACK_URL is set but TWILIO_AUTH_TOKEN is missing; delivery receipts disabled');
    }
    if (!callbackUrl || !authToken) { res.status(204).end(); return; }

    const sigHeader = req.headers?.['x-twilio-signature'];
    const signature = typeof sigHeader === 'string' ? sigHeader : '';
    const params = (req.body ?? {}) as Record<string, string>;
    if (!twilio.validateRequest(authToken, signature, callbackUrl, params)) {
      res.status(204).end();
      return;
    }

    const sid = params.MessageSid;
    const status = params.MessageStatus;
    if (sid && (status === 'delivered' || status === 'undelivered' || status === 'failed')) {
      const row = await getPool().query(
        `SELECT user_id FROM phone_otp WHERE twilio_message_sid = $1 LIMIT 1`,
        [sid],
      );
      const otpUserId = row.rows[0]?.user_id as number | undefined;
      // Row already cleaned up (verified/expired) -> no one to attribute; skip silently.
      if (otpUserId) {
        recordFunnelEvent({
          eventType: status === 'delivered' ? 'otp_delivered' : 'otp_undelivered',
          userId: otpUserId,
        });
      }
    }
    res.status(204).end();
  } catch (err) {
    console.error('[phone] twilio status webhook error:', err instanceof Error ? err.message : err);
    res.status(204).end();
  }
};
