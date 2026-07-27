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
import { authenticateToken, requireProfileComplete } from '../auth.middleware';
import { userCache, invalidateUserAuth } from '../../cache/cache.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a signed JWT with the given payload. */
const makeToken = (
  payload: { id: number; role: string; location_id?: number | null; se?: number },
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
const setupRoleState = (role: string, managedLocationIds: number[] = [], tokenEpoch = 0, isActive = true) => {
  mockPoolQuery.mockResolvedValueOnce({
    rows: [{ role, managed_location_ids: managedLocationIds, token_epoch: tokenEpoch, is_active: isActive }],
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

describe('authenticateToken — User role (epoch checked, one cached DB read)', () => {
  it('should pass a valid User token whose epoch matches', async () => {
    setupRoleState('User', [], 0);
    const token = makeToken({ id: 1, role: 'User', se: 0 });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    // Now EVERY role pays the (cached) DB read — this is what enables instant revocation.
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it('should attach decoded user payload to req.user for a User token', async () => {
    setupRoleState('User', [], 0);
    const token = makeToken({ id: 5, role: 'User', se: 0 });
    const req = makeReq(token) as any;
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(req.user).toMatchObject({ id: 5, role: 'User' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Session epoch — instant revocation (password reset / revoke-sessions / deletion)
// ─────────────────────────────────────────────────────────────────────────────

describe('authenticateToken — session epoch (instant revocation)', () => {
  it('rejects a token whose epoch is BELOW the user current epoch (session revoked)', async () => {
    setupRoleState('User', [], 1); // epoch bumped to 1 by a password reset
    const token = makeToken({ id: 50, role: 'User', se: 0 }); // minted before the bump
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

  it('passes a freshly-minted token carrying the new epoch', async () => {
    setupRoleState('User', [], 2);
    const token = makeToken({ id: 51, role: 'User', se: 2 });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects an ADMIN token with a stale epoch (F4: admin sessions are now checked)', async () => {
    setupRoleState('Admin', [], 1);
    const token = makeToken({ id: 1, role: 'Admin', se: 0 });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets a pre-epoch token (no se claim) through while the user epoch is still 0', async () => {
    setupRoleState('User', [], 0);
    const token = makeToken({ id: 60, role: 'User' }); // no se claim (issued before this feature)
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
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
// 5. Fail CLOSED on DB error (a revoked/demoted token must never slip through a DB blip)
// ─────────────────────────────────────────────────────────────────────────────

describe('authenticateToken — fail closed on DB error', () => {
  it('should reject with a retryable 503 when the DB lookup throws', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('connection timeout'));

    const token = makeToken({ id: 60, role: 'Business' });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    // Fail closed: never accept an unverifiable token. 503 is retryable.
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('should NOT attach req.user when the DB lookup throws', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('timeout'));

    const token = makeToken({ id: 61, role: 'Business', location_id: 5 });
    const req = makeReq(token) as any;
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(req.user).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject with 401 when the user row is gone (deleted account)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const token = makeToken({ id: 62, role: 'User' });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
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

// ─────────────────────────────────────────────────────────────────────────────
// requireProfileComplete — server-side age gate on entry-creating routes
// ─────────────────────────────────────────────────────────────────────────────

describe('requireProfileComplete — entry routes require DOB + gender on record', () => {
  const makeAuthedReq = (id: number, role: string): Request =>
    ({ user: { id, role } }) as unknown as Request;

  const setupGuard = (guard: { is_active?: boolean; is_phone_verified?: boolean; profile_complete?: boolean }) => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ is_active: true, is_phone_verified: true, profile_complete: false, ...guard }],
    });
  };

  it('blocks a consumer without a completed profile (403 with message)', async () => {
    setupGuard({ profile_complete: false });
    const res = makeRes();
    const next = makeNext();

    await requireProfileComplete(makeAuthedReq(1, 'User'), res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Please complete your profile before entering draws.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes a consumer whose profile is complete', async () => {
    setupGuard({ profile_complete: true });
    const res = makeRes();
    const next = makeNext();

    await requireProfileComplete(makeAuthedReq(2, 'User'), res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('exempts Business and Admin roles (they never create consumer entries)', async () => {
    setupGuard({ profile_complete: false });
    const res1 = makeRes();
    const next1 = makeNext();
    await requireProfileComplete(makeAuthedReq(3, 'Business'), res1, next1);
    expect(next1).toHaveBeenCalled();

    setupGuard({ profile_complete: false });
    const res2 = makeRes();
    const next2 = makeNext();
    await requireProfileComplete(makeAuthedReq(4, 'Admin'), res2, next2);
    expect(next2).toHaveBeenCalled();
  });

  it('unblocks immediately after invalidateUserAuth (cache cleared on profile save)', async () => {
    // First call caches the incomplete guard row
    setupGuard({ profile_complete: false });
    await requireProfileComplete(makeAuthedReq(5, 'User'), makeRes(), makeNext());

    // Profile saved server-side -> invalidateUserAuth clears the guard cache
    invalidateUserAuth(5);

    // Next call re-reads the DB and sees the completed profile
    setupGuard({ profile_complete: true });
    const res = makeRes();
    const next = makeNext();
    await requireProfileComplete(makeAuthedReq(5, 'User'), res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects an unauthenticated request', async () => {
    const res = makeRes();
    const next = makeNext();
    await requireProfileComplete({ user: undefined } as unknown as Request, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin liveness — the DB must still say Admin AND active on every request
// ─────────────────────────────────────────────────────────────────────────────

describe('authenticateToken — Admin liveness (role + is_active re-checked)', () => {
  it('passes a valid, active Admin token', async () => {
    setupRoleState('Admin', [], 0, true);
    const token = makeToken({ id: 9, role: 'Admin', se: 0 });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects an Admin token whose DB role was demoted (direct-DB change, no epoch bump)', async () => {
    setupRoleState('User', [], 0, true);
    const token = makeToken({ id: 9, role: 'Admin', se: 0 });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects an Admin token whose account was deactivated', async () => {
    setupRoleState('Admin', [], 0, false);
    const token = makeToken({ id: 9, role: 'Admin', se: 0 });
    const req = makeReq(token);
    const res = makeRes();
    const next = makeNext();

    await authenticateToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
