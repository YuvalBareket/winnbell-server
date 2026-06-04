import { Request, Response } from 'express';
import * as phoneService from './phone.service.js';

export const sendOtp = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  const { phoneNumber } = req.body;
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    res.status(400).json({ message: 'Phone number is required.' });
    return;
  }

  try {
    await phoneService.sendPhoneOtp(userId, phoneNumber);
    res.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'PHONE_VERIFY_DISABLED') {
      res.status(503).json({ message: 'Phone verification is not available yet. Please try again later.' });
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

  try {
    await phoneService.verifyPhoneOtp(userId, code);
    res.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'NO_OTP') { res.status(400).json({ message: 'No verification code found. Please request a new one.' }); return; }
    if (msg === 'OTP_EXPIRED') { res.status(400).json({ message: 'Verification code expired. Please request a new one.' }); return; }
    if (msg === 'TOO_MANY_ATTEMPTS') { res.status(429).json({ message: 'Too many failed attempts. Please request a new code.' }); return; }
    if (msg === 'INVALID_CODE') { res.status(400).json({ message: 'Invalid verification code.' }); return; }
    if (msg === 'PHONE_ALREADY_TAKEN') { res.status(409).json({ message: 'This phone number is already linked to another account.' }); return; }
    console.error('[phone] verifyOtp error:', err);
    res.status(500).json({ message: 'Verification failed.' });
  }
};
