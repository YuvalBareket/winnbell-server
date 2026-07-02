/**
 * Tests — auth.middleware.ts: authenticateToken (stale elevated session detection)
 *
 * Covers:
 *   - A regular 'User' token passes WITHOUT any DB lookup
 *   - A 'Business' token whose DB role is still 'Business' (owner, no location) passes
 *   - A manager token (role Business + location_id) passes when DB shows active managed location
 *   - A Business token is REJECTED (401) when DB role no longer matches (demoted to User)
 *   - A manager token is REJECTED (401) when it carries location_id but user no longer
 *     actively manages a location (hasActiveManagedLocation = false)
 *   - Fails OPEN (request allowed) when the DB lookup throws
 *   - Role state is cached: second call within TTL does not hit the DB again
 *   - invalidateUserAuth clears both guard and role cache keys
 *
 * Mock pattern: pool.query → rows; userCache is the real in-memory NodeCache.
 * We flush it in beforeEach to isolate TTL state.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// ── Constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET = 'middleware-test-secret';
process.env.JWT_SECRET = JWT_SECRET;

// ── Mock DB ───────────────────────────────────────────────────────────────────

const mockPoolQuery = jest.fn();

jest.mock('../../db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }),
}));

// Import after mocks are set up
import { authenticateToken } from '../auth.middleware';
import { userCache, invalidateUserAuth } from '../../cache/cache.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a signed JWT with the given payload. */
const makeToken = (
  payload: { id: number; role: string; location_id?: number | null },
  expiresIn: jwt.SignOptions['expiresIn'] = '1h',
) => jwt.sign(payload, JWT_SECRET, { expiresIn });

/** Build a minimal mock Express Request with an Authorization header. */
const makeReq = (token: string): Request =>
  ({ headers: { authorization: `Bearer ${token}` } }) as unknown as Request;

/** Build a mock Response that records status/json calls. */
const makeRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

const makeNext = (): NextFunction => jest.fn();

/**
 * Set up pool.query to return a DB role state for the stale-session check.
 * managed_location_ids = the active locations the user manages; the middleware validates the
 * token's SPECIFIC location_id against this array (not just "manages anything").
 */
const setupRoleState = (role: string, managedLocationIds: number[] = []) => {
  mockPoolQuery.mockResolvedValueOnce({
    rows: [{ role, managed_location_ids: managedLocationIds }],
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  // Flush the real user cache so TTL state from previous tests does not bleed through
  userCache.flushAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. User-role tokens bypass the DB lookup entirely
// ─────────────────────────────────────────────────────────────────────────────

describe('authenticateToken — User role (no DB lookup)', () => {
  it('should pass a valid User token without hitting the DB', async () => {
    const token = makeToken({ id: 1, role: 'User' });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    // No DB query issued — User tokens are not elevated
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('should attach decoded user payload to req.user for a User token', async () => {
    const token = makeToken({ id: 5, role: 'User' });
    const req = makeReq(token) as any;
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(req.user).toMatchObject({ id: 5, role: 'User' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Business-owner tokens (no location_id) — DB confirms role is still Business
// ─────────────────────────────────────────────────────────────────────────────

describe('authenticateToken — Business owner token (valid)', () => {
  it('should pass when DB confirms role is still Business and no location_id in token', async () => {
    setupRoleState('Business', []);

    const token = makeToken({ id: 10, role: 'Business' });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Manager tokens (Business + location_id) — DB confirms active managed location
// ─────────────────────────────────────────────────────────────────────────────

describe('authenticateToken — manager token (valid)', () => {
  it('should pass when DB confirms role is Business and user still actively manages a location', async () => {
    setupRoleState('Business', [7]);

    const token = makeToken({ id: 20, role: 'Business', location_id: 7 });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Stale session rejection
// ─────────────────────────────────────────────────────────────────────────────

describe('authenticateToken — stale elevated session rejection', () => {
  it('should reject with 401 when DB role no longer matches (Business token but user demoted to User)', async () => {
    // DB says 'User'; token says 'Business'
    setupRoleState('User', []);

    const token = makeToken({ id: 30, role: 'Business' });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Session no longer valid') }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject with 401 when manager token has location_id but user no longer manages any active location', async () => {
    // DB says role is still Business, but the user manages no active locations (removed)
    setupRoleState('Business', []);

    const token = makeToken({ id: 40, role: 'Business', location_id: 99 });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Session no longer valid') }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject with 401 when the manager was reassigned to a DIFFERENT location than the token is scoped to (cross-tenant guard)', async () => {
    // The S2 exploit: still manages SOME location (800), but not the token's location (500).
    setupRoleState('Business', [800]);

    const token = makeToken({ id: 45, role: 'Business', location_id: 500 });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject with 401 when both role and location are stale', async () => {
    setupRoleState('User', []);

    const token = makeToken({ id: 50, role: 'Business', location_id: 12 });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Fail-open on DB error
// ─────────────────────────────────────────────────────────────────────────────

describe('authenticateToken — fail open on DB error', () => {
  it('should allow the request through when the DB lookup throws (transient error)', async () => {
    // getRoleState returns null on error → fresh === null → no rejection
    mockPoolQuery.mockRejectedValueOnce(new Error('connection timeout'));

    const token = makeToken({ id: 60, role: 'Business' });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    // Must NOT reject — fail open
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(401);
  });

  it('should still attach req.user when failing open on DB error', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('timeout'));

    const token = makeToken({ id: 61, role: 'Business', location_id: 5 });
    const req = makeReq(token) as any;
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(req.user).toMatchObject({ id: 61, role: 'Business', location_id: 5 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Role-state caching — second call within TTL does not hit the DB again
// ─────────────────────────────────────────────────────────────────────────────

describe('authenticateToken — role-state cache', () => {
  it('should only query the DB once for the same user within the cache TTL', async () => {
    // First call — DB has the state
    setupRoleState('Business', []);

    const token = makeToken({ id: 70, role: 'Business' });

    // First request
    await authenticateToken(makeReq(token), makeRes(), makeNext());
    // Second request — should be served from cache
    await authenticateToken(makeReq(token), makeRes(), makeNext());

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it('should hit the DB again after cache is invalidated via invalidateUserAuth', async () => {
    const USER_ID = 80;

    // Seed the cache with an initial DB hit
    setupRoleState('Business', []);
    const token = makeToken({ id: USER_ID, role: 'Business' });
    await authenticateToken(makeReq(token), makeRes(), makeNext());
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);

    // Invalidate the cache (simulating what removeLocationManagerService calls)
    invalidateUserAuth(USER_ID);

    // After invalidation, next call should hit DB again
    setupRoleState('User', []); // DB now says demoted
    const res = makeRes();
    const next = makeNext();
    await authenticateToken(makeReq(token), res, next);

    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    // New DB state (User) does not match token (Business) → rejected
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should cache under the key user:role:<userId> so different users have independent cache entries', async () => {
    // User 90 — Business in DB
    setupRoleState('Business', []);
    // User 91 — User in DB
    setupRoleState('User', []);

    const token90 = makeToken({ id: 90, role: 'Business' });
    const token91 = makeToken({ id: 91, role: 'Business' }); // claims Business but DB says User

    const next90 = makeNext();
    const res91 = makeRes();
    const next91 = makeNext();

    await authenticateToken(makeReq(token90), makeRes(), next90);
    await authenticateToken(makeReq(token91), res91, next91);

    // User 90 passes, user 91 is rejected
    expect(next90).toHaveBeenCalled();
    expect(res91.status).toHaveBeenCalledWith(401);
    expect(next91).not.toHaveBeenCalled();
    // Two separate DB queries issued (one per user)
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Standard token-level rejections (unchanged behavior)
// ─────────────────────────────────────────────────────────────────────────────

describe('authenticateToken — basic token validation', () => {
  it('should return 401 when no token is provided', async () => {
    const req = { headers: {} } as unknown as Request;
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 for a tampered token', async () => {
    const token = makeToken({ id: 1, role: 'User' }) + 'tampered';
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(makeReq(token), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 for an expired token', async () => {
    const token = makeToken({ id: 1, role: 'User' }, -1); // already expired
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(makeReq(token), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. invalidateUserAuth clears both cache keys
// ─────────────────────────────────────────────────────────────────────────────

describe('invalidateUserAuth — cache key invalidation', () => {
  it('should clear both user:guard:<id> and user:role:<id> from the cache', () => {
    const USER_ID = 100;

    // Manually seed both keys in the real cache
    userCache.set(`user:guard:${USER_ID}`, { is_active: true, is_phone_verified: true });
    userCache.set(`user:role:${USER_ID}`, { role: 'Business', hasActiveManagedLocation: true });

    expect(userCache.has(`user:guard:${USER_ID}`)).toBe(true);
    expect(userCache.has(`user:role:${USER_ID}`)).toBe(true);

    invalidateUserAuth(USER_ID);

    expect(userCache.has(`user:guard:${USER_ID}`)).toBe(false);
    expect(userCache.has(`user:role:${USER_ID}`)).toBe(false);
  });

  it('should not affect cache entries for other users', () => {
    const USER_A = 200;
    const USER_B = 201;

    userCache.set(`user:role:${USER_A}`, { role: 'Business', hasActiveManagedLocation: false });
    userCache.set(`user:role:${USER_B}`, { role: 'User', hasActiveManagedLocation: false });

    invalidateUserAuth(USER_A);

    expect(userCache.has(`user:role:${USER_A}`)).toBe(false);
    // USER_B's cache entry must still be present
    expect(userCache.has(`user:role:${USER_B}`)).toBe(true);
  });
});
