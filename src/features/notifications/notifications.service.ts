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

// A real person has at most a handful of devices/browsers; 20 is generous headroom for
// reinstalls and multiple browsers while bounding the table against a scripted client.
const MAX_SUBSCRIPTIONS_PER_USER = 20;

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

  // Per-user cap: keep only the newest rows so a scripted client sending endless distinct
  // endpoints cannot grow the table without bound (storage DoS). The just-upserted row is
  // newest, so it is always retained.
  await pool.query(`
    DELETE FROM push_subscription
    WHERE user_id = $1
      AND id NOT IN (
        SELECT id FROM push_subscription
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT ${MAX_SUBSCRIPTIONS_PER_USER}
      )
  `, [userId]);
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

interface SubRow { endpoint: string; p256dh: string; auth: string }

// Sends to a batch of subscriptions and prunes endpoints the push service
// reports as gone (410) or not found (404) — otherwise dead rows accumulate
// forever and every broadcast wastes time on them.
const sendBatch = async (rows: SubRow[], payload: NotificationPayload): Promise<number> => {
  const results = await Promise.allSettled(
    rows.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      ),
    ),
  );

  const goneEndpoints = rows
    .filter((_, i) => {
      const r = results[i];
      if (r.status !== 'rejected') return false;
      const status = (r.reason as { statusCode?: number })?.statusCode;
      return status === 410 || status === 404;
    })
    .map((sub) => sub.endpoint);

  if (goneEndpoints.length > 0) {
    try {
      await getPool().query(
        `DELETE FROM push_subscription WHERE endpoint = ANY($1::text[])`,
        [goneEndpoints],
      );
      console.log(`[Push] Pruned ${goneEndpoints.length} dead subscription(s).`);
    } catch (err) {
      console.error('[Push] Failed to prune dead subscriptions:', err);
    }
  }

  // Report ACTUAL successful deliveries (fulfilled sends) so the admin "Sent" count is honest -
  // rejected sends (dead endpoints just pruned, transient failures) are excluded.
  return results.filter((r) => r.status === 'fulfilled').length;
};

export const sendToUser = async (userId: number, payload: NotificationPayload): Promise<void> => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT endpoint, p256dh, auth FROM push_subscription WHERE user_id = $1`,
    [userId],
  );
  await sendBatch(result.rows, payload);
};

export const sendToAll = async (payload: NotificationPayload): Promise<void> => {
  const pool = getPool();
  const BATCH_SIZE = 500;
  // Keyset pagination (id > lastId) — OFFSET would skip rows when sendBatch
  // prunes dead subscriptions mid-iteration.
  let lastId = 0;

  while (true) {
    const result = await pool.query(
      `SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE id > $2 ORDER BY id LIMIT $1`,
      [BATCH_SIZE, lastId],
    );
    if (result.rows.length === 0) break;

    await sendBatch(result.rows, payload);
    lastId = result.rows[result.rows.length - 1].id;
    if (result.rows.length < BATCH_SIZE) break;
  }
};

type Audience = 'all' | 'users' | 'businesses';

export const sendToAudience = async (audience: Audience, payload: NotificationPayload): Promise<number> => {
  const pool = getPool();
  const BATCH_SIZE = 500;
  // Keyset pagination — see sendToAll
  let lastId = 0;
  let totalSent = 0;

  const baseQuery =
    audience === 'all'
      ? `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth FROM push_subscription ps
         WHERE ps.id > $2 ORDER BY ps.id LIMIT $1`
      : `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
         FROM push_subscription ps
         JOIN "user" u ON u.id = ps.user_id
         WHERE u.role = $3 AND ps.id > $2
         ORDER BY ps.id LIMIT $1`;

  while (true) {
    const params: (number | string)[] =
      audience === 'all'
        ? [BATCH_SIZE, lastId]
        : [BATCH_SIZE, lastId, audience === 'users' ? 'User' : 'Business'];

    const result = await pool.query(baseQuery, params);
    if (result.rows.length === 0) break;

    totalSent += await sendBatch(result.rows, payload);
    lastId = result.rows[result.rows.length - 1].id;
    if (result.rows.length < BATCH_SIZE) break;
  }

  return totalSent;
};

export const logNotification = async (
  title: string,
  body: string,
  url: string | undefined,
  audience: string,
  sentCount: number,
  sentBy: number,
): Promise<void> => {
  const pool = getPool();
  await pool.query(
    `INSERT INTO notification_log (title, body, url, audience, sent_count, sent_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [title, body, url ?? null, audience, sentCount, sentBy],
  );
};

export const getNotificationHistory = async (): Promise<object[]> => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, title, body, url, audience, sent_count, sent_by, created_at FROM notification_log ORDER BY created_at DESC LIMIT 50`,
  );
  return result.rows;
};
