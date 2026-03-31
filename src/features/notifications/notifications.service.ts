import webpush from 'web-push';
import { getPool, sql } from '../../shared/db/db.js';

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
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('endpoint', sql.NVarChar(sql.MAX), endpoint)
    .input('p256dh', sql.NVarChar(512), keys.p256dh)
    .input('auth', sql.NVarChar(512), keys.auth)
    .query(`
      MERGE push_subscription AS target
      USING (SELECT @endpoint AS endpoint) AS source ON target.endpoint = source.endpoint
      WHEN MATCHED THEN
        UPDATE SET user_id = @userId, p256dh = @p256dh, auth = @auth
      WHEN NOT MATCHED THEN
        INSERT (user_id, endpoint, p256dh, auth)
        VALUES (@userId, @endpoint, @p256dh, @auth);
    `);
};

export const removeSubscription = async (userId: number, endpoint: string): Promise<void> => {
  const pool = getPool();
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('endpoint', sql.NVarChar(sql.MAX), endpoint)
    .query(`DELETE FROM push_subscription WHERE user_id = @userId AND endpoint = @endpoint`);
};

interface NotificationPayload {
  title: string;
  body: string;
  url?: string;
}

export const sendToUser = async (userId: number, payload: NotificationPayload): Promise<void> => {
  const pool = getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .query(`SELECT endpoint, p256dh, auth FROM push_subscription WHERE user_id = @userId`);

  await Promise.allSettled(
    result.recordset.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      ),
    ),
  );
};

export const sendToAll = async (payload: NotificationPayload): Promise<void> => {
  const pool = getPool();
  const result = await pool
    .request()
    .query(`SELECT endpoint, p256dh, auth FROM push_subscription`);

  await Promise.allSettled(
    result.recordset.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      ),
    ),
  );
};
