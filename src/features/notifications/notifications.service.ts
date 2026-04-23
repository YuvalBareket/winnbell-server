import webpush from 'web-push';
import { getPool } from '../../shared/db/db.js';

webpush.setVapidDetails(
  'mailto:admin@winnbell.com',
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!,
);

interface PushKeys {
  p256dh: string;
  auth: string;
}

export const saveSubscription = async (
  userId: number,
  endpoint: string,
  keys: PushKeys,
): Promise<void> => {
  const pool = getPool();
  await pool.query(`
    INSERT INTO push_subscription (user_id, endpoint, p256dh, auth)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (endpoint) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          p256dh  = EXCLUDED.p256dh,
          auth    = EXCLUDED.auth
  `, [userId, endpoint, keys.p256dh, keys.auth]);
};

export const removeSubscription = async (userId: number, endpoint: string): Promise<void> => {
  const pool = getPool();
  await pool.query(
    `DELETE FROM push_subscription WHERE user_id = $1 AND endpoint = $2`,
    [userId, endpoint],
  );
};

interface NotificationPayload {
  title: string;
  body: string;
  url?: string;
}

export const sendToUser = async (userId: number, payload: NotificationPayload): Promise<void> => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT endpoint, p256dh, auth FROM push_subscription WHERE user_id = $1`,
    [userId],
  );

  await Promise.allSettled(
    result.rows.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      ),
    ),
  );
};

export const sendToAll = async (payload: NotificationPayload): Promise<void> => {
  const pool = getPool();
  const BATCH_SIZE = 500;
  let offset = 0;

  while (true) {
    const result = await pool.query(
      `SELECT endpoint, p256dh, auth FROM push_subscription ORDER BY id LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset],
    );
    if (result.rows.length === 0) break;

    await Promise.allSettled(
      result.rows.map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        ),
      ),
    );
    offset += result.rows.length;
    if (result.rows.length < BATCH_SIZE) break;
  }
};
