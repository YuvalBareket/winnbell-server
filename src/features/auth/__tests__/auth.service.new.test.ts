/**
 * Supplementary tests — auth.service.ts (new behavior from uncommitted diff)
 *
 * Covers:
 *   loginUser
 *     - location lookup filters is_active = TRUE (soft-deleted locations are excluded)
 *     - A Business user removed from their location is treated as having no location
 *
 *   syncExternalUser — tolerant invite handling
 *     - An expired invite token is IGNORED (no throw); user signs in with current role
 *     - A wrong-type token is IGNORED; user signs in with current role
 *     - A valid, fresh invite still promotes to Business + sets location_id (happy path)
 *     - location_id comes from is_active managed location when no invite is present
 *     - An inactive managed location (is_active=FALSE) does NOT grant location_id
 *       (the !inviteApplied path filters is_active = TRUE)
 *
 * Mock pattern (identical to auth.service.test.ts):
 *   pool.query for non-transactional reads (loginUser outside invite path)
 *   pool.connect() → client for transactional paths (syncExternalUser)
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// ── Mock DB ───────────────────────────────────────────────────────────────────

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockClient = { query: mockClientQuery, release: mockRelease };

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({
    query: mockPoolQuery,
    connect: jest.fn().mockResolvedValue(mockClient),
  }),
}));

import { loginUser, syncExternalUser } from '../auth.service';

// ── Constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET = 'auth-new-test-secret';
process.env.JWT_SECRET = JWT_SECRET;

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeInviteToken = (locationId: number, expiresIn: jwt.SignOptions['expiresIn'] = '1h') =>
  jwt.sign({ type: 'MANAGER_INVITE', locationId, businessId: 99 }, JWT_SECRET, { expiresIn });

const setupPoolQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockPoolQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

const setupClientQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockClientQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// loginUser — is_active = TRUE filter in location lookup
// ─────────────────────────────────────────────────────────────────────────────

describe('loginUser — location lookup filters is_active = TRUE', () => {
  const hash = bcrypt.hashSync('pass', 10);

  it('should include is_active = TRUE in the business_location query so soft-deleted locations are excluded', async () => {
    setupPoolQueries(
      { rows: [{ id: 10, email: 'mgr@test.com', password_hash: hash, full_name: 'Mgr', role: 'Business' }] },
      { rows: [] }, // no active managed location
    );

    await loginUser('mgr@test.com', 'pass');

    // Find the business_location SELECT call
    const locCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('business_location'),
    );
    expect(locCall).toBeDefined();
    const sql = locCall![0] as string;
    expect(sql).toMatch(/is_active\s*=\s*TRUE/i);
  });

  it('should set location_id to the active managed location when one exists', async () => {
    setupPoolQueries(
      { rows: [{ id: 20, email: 'mgr2@test.com', password_hash: hash, full_name: 'Mgr2', role: 'Business' }] },
      { rows: [{ id: 5 }] }, // active managed location
    );

    const res = await loginUser('mgr2@test.com', 'pass');
    expect(res.user.location_id).toBe(5);
  });

  it('should NOT grant location_id when the managed location is inactive (returns no row because is_active filter excludes it)', async () => {
    // The DB query filters is_active = TRUE, so an inactive location returns empty rows.
    // This simulates the post-removal state where the location still exists in the DB
    // but is soft-deleted.
    setupPoolQueries(
      { rows: [{ id: 30, email: 'old-mgr@test.com', password_hash: hash, full_name: 'OldMgr', role: 'Business' }] },
      { rows: [] }, // filtered by is_active = TRUE — no active location found
      { rows: [] }, // business lookup — no owned business
    );

    const res = await loginUser('old-mgr@test.com', 'pass');

    expect(res.user.location_id).toBeNull();
    expect(res.user.requiresBusinessSetup).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// syncExternalUser — tolerant invite handling
// ─────────────────────────────────────────────────────────────────────────────

describe('syncExternalUser — tolerant invite handling (invalid invite is ignored)', () => {
  it('should sign in with current role and not throw when the invite token is expired', async () => {
    const expiredToken = makeInviteToken(10, -1); // already expired

    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [] }, // deletedCheck
      { rows: [{ id: 60, role: 'User', fullName: 'Former Mgr', email: 'former@test.com' }] }, // upsert
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      // No UPDATE biz_loc — expired token is caught and ignored
      { rows: [] }, // SELECT active managed location — none
      { rows: [] }, // INSERT refresh_token
      { rows: [] }, // COMMIT
    );

    const res = await syncExternalUser('ext-expired', 'former@test.com', 'Former Mgr', {
      inviteToken: expiredToken,
    });

    expect(res.user.role).toBe('User');
    expect(res.user.location_id).toBeNull();
    expect(res.message).toBe('Sync successful');
  });

  it('should sign in with current role and not throw when the invite token has wrong type', async () => {
    const wrongTypeToken = jwt.sign(
      { type: 'SOMETHING_ELSE', locationId: 10 },
      JWT_SECRET,
      { expiresIn: '1h' },
    );

    // Wrong type means the if branch is skipped, inviteApplied stays false,
    // then the !inviteApplied path runs (SELECT active managed location).
    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [] }, // deletedCheck
      { rows: [{ id: 61, role: 'User', fullName: 'Wrong Type', email: 'wrong@test.com' }] }, // upsert
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] }, // SELECT active managed location — none (falls into !inviteApplied path)
      { rows: [] }, // INSERT refresh_token
      { rows: [] }, // COMMIT
    );

    const res = await syncExternalUser('ext-wrongtype', 'wrong@test.com', 'Wrong Type', {
      inviteToken: wrongTypeToken,
    });

    expect(res.user.role).toBe('User');
    expect(res.user.location_id).toBeNull();
    expect(res.message).toBe('Sync successful');
  });

  it('should sign in with current role and not throw when the invite has no locationId', async () => {
    // Token with correct type but missing locationId — if block condition fails
    const noLocToken = jwt.sign(
      { type: 'MANAGER_INVITE', businessId: 99 }, // no locationId
      JWT_SECRET,
      { expiresIn: '1h' },
    );

    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [] }, // deletedCheck
      { rows: [{ id: 62, role: 'User', fullName: 'No Loc', email: 'noloc@test.com' }] }, // upsert
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] }, // SELECT active managed location — falls into !inviteApplied path
      { rows: [] }, // INSERT refresh_token
      { rows: [] }, // COMMIT
    );

    const res = await syncExternalUser('ext-noloc', 'noloc@test.com', 'No Loc', {
      inviteToken: noLocToken,
    });

    expect(res.user.role).toBe('User');
    expect(res.user.location_id).toBeNull();
  });

  it('should promote to Business and set location_id when invite is valid and fresh (happy path)', async () => {
    const token = makeInviteToken(25);

    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 70, role: 'User', fullName: 'New Mgr', email: 'newmgr@test.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [{ id: 25 }], rowCount: 1 }, // UPDATE biz_loc — invite accepted
      { rows: [] }, // UPDATE user role
      { rows: [] }, // INSERT refresh_token
      { rows: [] }, // COMMIT
    );

    const res = await syncExternalUser('ext-newmgr', 'newmgr@test.com', 'New Mgr', {
      inviteToken: token,
    });

    expect(res.user.role).toBe('Business');
    expect(res.user.location_id).toBe(25);
    expect(res.user.requiresBusinessSetup).toBe(false);
  });

  it('should populate location_id from an actively managed location when no invite is present', async () => {
    // !inviteApplied path: SELECT id FROM business_location WHERE manager_user_id = $1 AND is_active = TRUE
    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 80, role: 'Business', fullName: 'Active Mgr', email: 'activemgr@test.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [{ id: 33 }] }, // SELECT active managed location
      { rows: [] }, // INSERT refresh_token
      { rows: [] }, // COMMIT
    );

    const res = await syncExternalUser('ext-activemgr', 'activemgr@test.com', 'Active Mgr');

    expect(res.user.location_id).toBe(33);
    expect(res.user.requiresBusinessSetup).toBe(false);
  });

  it('should filter is_active = TRUE in the !inviteApplied location lookup', async () => {
    // Verify the actual SQL used in the !inviteApplied path includes is_active = TRUE.
    // We check mockClientQuery calls directly.
    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 90, role: 'Business', fullName: 'Check SQL', email: 'checksql@test.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] }, // location lookup — empty result
      { rows: [] }, // INSERT refresh_token
      { rows: [] }, // COMMIT
    );

    await syncExternalUser('ext-checksql', 'checksql@test.com', 'Check SQL');

    const locCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === 'string' &&
        sql.includes('business_location') &&
        sql.includes('manager_user_id'),
    );
    expect(locCall).toBeDefined();
    const sql = locCall![0] as string;
    expect(sql).toMatch(/is_active\s*=\s*TRUE/i);
  });

  it('should NOT populate location_id from an inactive managed location (simulated via empty result)', async () => {
    // A former manager whose location was soft-deleted: the is_active=TRUE filter
    // means the DB returns no row. location_id should be null.
    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 91, role: 'Business', fullName: 'Removed Mgr', email: 'removedmgr@test.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] }, // is_active=TRUE filter excludes the inactive location
      { rows: [{ id: 99, is_subscribed: true, logo_url: null }] }, // business row exists (not a manager-only user)
      { rows: [] }, // COMMIT
    );

    const res = await syncExternalUser('ext-removedmgr', 'removedmgr@test.com', 'Removed Mgr');

    expect(res.user.location_id).toBeNull();
    expect(res.user.requiresBusinessSetup).toBe(false); // has business row
  });
});
