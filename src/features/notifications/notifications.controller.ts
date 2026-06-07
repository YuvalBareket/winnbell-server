import { Response } from 'express';
import type { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import { saveSubscription, removeSubscription, sendToAll } from './notifications.service.js';

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

    await saveSubscription(userId, endpoint, keys);
    res.status(201).json({ message: 'Subscribed.' });
  } catch (err) {
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
  } catch (err) {
    console.error('[notifications] unsubscribe error:', err);
    res.status(500).json({ message: 'Failed to remove subscription.' });
  }
};

// Admin-only: broadcast a push notification to all subscribers
export const broadcast = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { title, body, url } = req.body as { title: string; body: string; url?: string };

    if (!title || !body) {
      res.status(400).json({ message: 'title and body are required.' });
      return;
    }

    await sendToAll({ title, body, url });
    res.status(200).json({ message: 'Notification sent.' });
  } catch (err) {
    console.error('[notifications] broadcast error:', err);
    res.status(500).json({ message: 'Failed to send notification.' });
  }
};
