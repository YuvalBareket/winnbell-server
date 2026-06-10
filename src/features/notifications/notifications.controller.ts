import { Response } from 'express';
import type { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import { saveSubscription, removeSubscription, sendToAudience, logNotification, getNotificationHistory } from './notifications.service.js';
import { validateLengths } from '../../shared/validation.js';

export const subscribe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { endpoint, keys } = req.body as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      res.status(400).json({ message: 'Invalid subscription object.' });
      return;
    }
    const lenErr = validateLengths([
      ['Endpoint', endpoint, 500],
      ['p256dh key', keys.p256dh, 200],
      ['Auth key', keys.auth, 100],
    ]);
    if (lenErr) { res.status(400).json({ message: lenErr }); return; }

    await saveSubscription(userId, endpoint, keys);
    res.status(201).json({ message: 'Subscribed.' });
  } catch (err: unknown) {
    console.error('[notifications] subscribe error:', err);
    res.status(500).json({ message: 'Failed to save subscription.' });
  }
};

export const unsubscribe = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { endpoint } = req.body as { endpoint: string };

    if (!endpoint) {
      res.status(400).json({ message: 'Endpoint is required.' });
      return;
    }

    await removeSubscription(userId, endpoint);
    res.status(200).json({ message: 'Unsubscribed.' });
  } catch (err: unknown) {
    console.error('[notifications] unsubscribe error:', err);
    res.status(500).json({ message: 'Failed to remove subscription.' });
  }
};

const VALID_AUDIENCES = ['all', 'users', 'businesses'] as const;
type Audience = typeof VALID_AUDIENCES[number];

export const broadcast = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { title, body, url, audience = 'all' } = req.body as {
      title: string;
      body: string;
      url?: string;
      audience?: string;
    };

    if (!title || !body) {
      res.status(400).json({ message: 'title and body are required.' });
      return;
    }

    if (!VALID_AUDIENCES.includes(audience as Audience)) {
      res.status(400).json({ message: 'audience must be one of: all, users, businesses.' });
      return;
    }
    const lenErr = validateLengths([
      ['Title', title, 200],
      ['Body', body, 2000],
      ['URL', url, 500],
    ]);
    if (lenErr) { res.status(400).json({ message: lenErr }); return; }

    const sentBy = req.user!.id;
    const sentCount = await sendToAudience(audience as Audience, { title, body, url });
    await logNotification(title, body, url, audience, sentCount, sentBy);
    res.status(200).json({ message: 'Notification sent.', sent_count: sentCount });
  } catch (err: unknown) {
    console.error('[notifications] broadcast error:', err);
    res.status(500).json({ message: 'Failed to send notification.' });
  }
};

export const getHistory = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const history = await getNotificationHistory();
    res.status(200).json(history);
  } catch (err: unknown) {
    console.error('[notifications] getHistory error:', err);
    res.status(500).json({ message: 'Failed to fetch notification history.' });
  }
};
