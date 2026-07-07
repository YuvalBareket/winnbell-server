/**
 * Tests — refreshTokenController transactional rotation (F3).
 *
 * The guarantee under test: consuming the old refresh token and inserting the new one is
 * ALL-OR-NOTHING on one connection. A failure between consume and insert must ROLLBACK (never
 * COMMIT), so the old token stays valid for a clean retry instead of stranding a dead session.
 *
 * Mock pattern: getPool().connect() -> client; client.query dispatched by SQL text so ordering
 * is robust. authService.insertRefreshTokenCapped is the injectable failure point.
 */

const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockClient = { query: mockClientQuery, release: mockRelease };

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({
    connect: jest.fn().mockResolvedValue(mockClient),
  }),
}));

const mockInsertCapped = jest.fn();
jest.mock('../auth.service.js', () => ({
  insertRefreshTokenCapped: (...args: unknown[]) => mockInsertCapped(...args),
}));

jest.mock('../../../shared/cache/cache.js', () => ({
  invalidateUserAuth: jest.fn(),
  getPlatformSettings: jest.fn(),
}));

// jose is ESM-only and unused by the refresh path; mock it so ts-jest (CJS) can load the controller.
jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { refreshTokenController } from '../auth.controller';

process.env.JWT_SECRET = 'test-secret';

type Res = {
  status: jest.Mock;
  json: jest.Mock;
  statusCode?: number;
};
const makeRes = (): Res => {
  const res = {} as Res;
  res.status = jest.fn().mockImplementation((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const makeReq = (refreshToken: unknown = 'a-valid-looking-refresh-token') =>
  ({ body: { refreshToken } } as unknown as Parameters<typeof refreshTokenController>[0]);

/** Dispatch client.query by SQL, with a live user + no managed location by default. */
const defaultClient = (overrides: { user?: unknown; consumeRow?: unknown } = {}) => {
  const user = 'user' in overrides ? overrides.user : { id: 713, role: 'Business', is_active: true, token_epoch: 0 };
  const consumeRow = 'consumeRow' in overrides ? overrides.consumeRow : { id: 1, user_id: 713 };
  mockClientQuery.mockImplementation((sql: string) => {
    if (/^\s*BEGIN/i.test(sql)) return Promise.resolve({ rows: [] });
    if (/^\s*COMMIT/i.test(sql)) return Promise.resolve({ rows: [] });
    if (/^\s*ROLLBACK/i.test(sql)) return Promise.resolve({ rows: [] });
    if (/UPDATE refresh_token/i.test(sql)) return Promise.resolve({ rows: consumeRow ? [consumeRow] : [] });
    if (/FROM "user"/i.test(sql)) return Promise.resolve({ rows: user ? [user] : [] });
    if (/business_location/i.test(sql)) return Promise.resolve({ rows: [] });
    if (/DELETE FROM refresh_token/i.test(sql)) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
};

const sqlCalls = () => mockClientQuery.mock.calls.map((c) => String(c[0]).trim().split('\n')[0]);
const committed = () => sqlCalls().some((s) => /^COMMIT/i.test(s));
const rolledBack = () => sqlCalls().some((s) => /^ROLLBACK/i.test(s));

beforeEach(() => {
  mockClientQuery.mockReset();
  mockRelease.mockReset();
  mockInsertCapped.mockReset();
  mockInsertCapped.mockResolvedValue(undefined);
});

describe('refreshTokenController — transactional rotation (F3)', () => {
  test('happy path: commits and returns a rotated token pair', async () => {
    defaultClient();
    const res = makeRes();

    await refreshTokenController(makeReq(), res as unknown as Parameters<typeof refreshTokenController>[1]);

    expect(committed()).toBe(true);
    expect(rolledBack()).toBe(false);
    expect(mockInsertCapped).toHaveBeenCalledTimes(1);
    // insert must run on the SAME transactional client, not the pool
    expect(mockInsertCapped.mock.calls[0][0]).toBe(mockClient);
    const body = res.json.mock.calls[0][0];
    expect(typeof body.token).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test('THE F3 GUARANTEE: a failure inserting the new token ROLLS BACK the consume (never commits)', async () => {
    defaultClient();
    mockInsertCapped.mockRejectedValueOnce(new Error('connection terminated mid-rotation'));
    const res = makeRes();

    await refreshTokenController(makeReq(), res as unknown as Parameters<typeof refreshTokenController>[1]);

    expect(rolledBack()).toBe(true);   // old token's consume is undone -> still valid for retry
    expect(committed()).toBe(false);   // nothing partial was persisted
    expect(res.statusCode).toBe(500);
    expect(mockRelease).toHaveBeenCalledTimes(1); // connection always returned to the pool
  });

  test('invalid/expired token: rolls back and returns 401 (nothing persisted)', async () => {
    defaultClient({ consumeRow: null }); // UPDATE matched no row
    const res = makeRes();

    await refreshTokenController(makeReq(), res as unknown as Parameters<typeof refreshTokenController>[1]);

    expect(rolledBack()).toBe(true);
    expect(committed()).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(mockInsertCapped).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test('deactivated account: revokes all tokens and COMMITS the deletion, returns 401', async () => {
    defaultClient({ user: { id: 713, role: 'Business', is_active: false, token_epoch: 0 } });
    const res = makeRes();

    await refreshTokenController(makeReq(), res as unknown as Parameters<typeof refreshTokenController>[1]);

    expect(sqlCalls().some((s) => /^DELETE FROM refresh_token/i.test(s))).toBe(true);
    expect(committed()).toBe(true);    // deletion must persist
    expect(res.statusCode).toBe(401);
    expect(mockInsertCapped).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test('missing refresh token: 400 before opening a transaction', async () => {
    const res = makeRes();
    // null (not undefined, which would resolve makeReq's default) => genuinely absent token
    await refreshTokenController(makeReq(null), res as unknown as Parameters<typeof refreshTokenController>[1]);
    expect(res.statusCode).toBe(400);
    expect(mockClientQuery).not.toHaveBeenCalled(); // never touched the DB
  });
});
