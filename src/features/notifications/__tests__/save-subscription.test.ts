/**
 * Tests - saveSubscription per-user cap (push_subscription storage-DoS fix)
 *
 * Covers:
 *  - the upsert INSERT is issued first
 *  - a second DELETE prunes the user to the newest MAX_SUBSCRIPTIONS_PER_USER rows
 *  - both queries are parameterized on user_id (no raw user input in SQL text)
 *
 * Mock pattern: pool.query(sql, params) -> resolves. No real DB is touched.
 */

const mockQuery = jest.fn();

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockQuery }),
}));

// web-push is imported at module load and calls setVapidDetails; stub it so the import is inert.
jest.mock('web-push', () => ({
  __esModule: true,
  default: { setVapidDetails: jest.fn(), sendNotification: jest.fn() },
}));

import { saveSubscription, sendToAdmins } from '../notifications.service';
import webpush from 'web-push';

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('saveSubscription - per-user row cap', () => {
  test('issues the upsert, then a prune DELETE scoped to the user', async () => {
    await saveSubscription(42, 'https://push.example/abc', { p256dh: 'k', auth: 'a' });

    expect(mockQuery).toHaveBeenCalledTimes(2);

    const [insertSql, insertParams] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(insertSql).toMatch(/INSERT INTO push_subscription/);
    expect(insertParams).toEqual([42, 'https://push.example/abc', 'k', 'a']);

    const [deleteSql, deleteParams] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(deleteSql).toMatch(/DELETE FROM push_subscription/);
    // Keeps only the newest N per user, ordered by created_at DESC.
    expect(deleteSql).toMatch(/ORDER BY created_at DESC/);
    expect(deleteSql).toMatch(/LIMIT 20/);
    expect(deleteSql).toMatch(/WHERE user_id = \$1/);
    expect(deleteParams).toEqual([42]);
  });

  test('the prune query embeds only a numeric literal for the cap (no user input in SQL)', async () => {
    await saveSubscription(7, 'https://push.example/xyz', { p256dh: 'k', auth: 'a' });
    const [deleteSql] = mockQuery.mock.calls[1] as [string];
    // The only interpolated value is the constant cap; everything user-derived is a $ param.
    expect(deleteSql).toMatch(/LIMIT 20/);
    expect(deleteSql).not.toMatch(/push\.example/);
  });
});

describe('sendToAdmins - admin-only ops alerts', () => {
  test('targets ONLY Admin-role subscriptions and pushes to each device', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { endpoint: 'https://push.example/admin-phone', p256dh: 'k1', auth: 'a1' },
        { endpoint: 'https://push.example/admin-desktop', p256dh: 'k2', auth: 'a2' },
      ],
    });
    (webpush.sendNotification as jest.Mock).mockResolvedValue({});

    await sendToAdmins({ title: 'New business registered', body: 'Cafe X just joined', url: '/admin/businesses' });

    const [selectSql] = mockQuery.mock.calls[0] as [string];
    expect(selectSql).toMatch(/JOIN "user" u ON u\.id = ps\.user_id/);
    expect(selectSql).toMatch(/u\.role = 'Admin'/);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  test('no admin subscriptions = clean no-op (no push attempts)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await sendToAdmins({ title: 't', body: 'b' });

    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});
