import { Request, Response } from 'express';
import { sendContactMessageEmail } from '../../shared/email/email.service.js';

// Whitelisted topics - must match the client's picker exactly.
export const CONTACT_TOPICS = [
  'Account & draws',
  'Receipts & entries',
  'Business partnership',
  'Something else',
] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public endpoint: anyone (including logged-out visitors) can contact us. Strict per-IP
// limiter is attached in app.ts; validation here keeps the support inbox usable.
export const submitContactMessage = async (req: Request, res: Response): Promise<void> => {
  const { fullName, email, topic, message, website } = (req.body ?? {}) as Record<string, unknown>;

  // Honeypot: a hidden "website" field real users never fill. Bots that do get a fake
  // success and nothing is sent - no signal that they were filtered.
  if (typeof website === 'string' && website.trim() !== '') {
    res.json({ success: true });
    return;
  }

  const name = typeof fullName === 'string' ? fullName.trim() : '';
  const fromEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const msg = typeof message === 'string' ? message.trim() : '';

  if (!name || name.length > 100) {
    res.status(400).json({ message: 'Please enter your name.' });
    return;
  }
  if (!fromEmail || fromEmail.length > 255 || !EMAIL_RE.test(fromEmail)) {
    res.status(400).json({ message: 'Please enter a valid email address.' });
    return;
  }
  if (typeof topic !== 'string' || !(CONTACT_TOPICS as readonly string[]).includes(topic)) {
    res.status(400).json({ message: 'Please pick a topic.' });
    return;
  }
  if (!msg) {
    res.status(400).json({ message: 'Please write a message.' });
    return;
  }
  if (msg.length > 2000) {
    res.status(400).json({ message: 'Message is too long (2000 characters max).' });
    return;
  }

  try {
    await sendContactMessageEmail({ fullName: name, email: fromEmail, topic, message: msg });
    res.json({ success: true });
  } catch (err) {
    console.error('[Contact] send failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ message: 'We could not send your message right now. Please try again.' });
  }
};
