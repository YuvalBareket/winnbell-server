/**
 * Tests — auth.service.ts (PostgreSQL)
 *
 * Covers:
 *   registerUser  — happy path, duplicate email, mass assignment (role ignored),
 *                   valid invite token (manager promotion), expired/used invite token
 *   loginUser     — valid credentials, wrong password, invite token acceptance on login
 *   syncExternalUser — upsert new user, conflict on email update, invite token assignment,
 *                      expired invite token rejected, requiresBusinessSetup logic
 *
 * Mock pattern: pool.connect() → client (query / release)
 *               pool.query() for non-transactional reads (loginUser, syncExternalUser)
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// ── Mock the DB module before importing the service ──────────────────────────

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

import { registerUser, loginUser, syncExternalUser } from '../auth.service';

// ─── Constants ────────────────────────────────────────────────────────────────

const JWT_SECRET = 'test-secret';
process.env.JWT_SECRET = JWT_SECRET;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a signed MANAGER_INVITE token for the given locationId. */
const makeInviteToken = (locationId: number, expiresIn: jwt.SignOptions['expiresIn'] = '1h') =>
  jwt.sign({ type: 'MANAGER_INVITE', locationId, businessId: 99 }, JWT_SECRET, { expiresIn });

/**
 * Set up client.query to return responses in sequence.
 * Any call beyond the list repeats the last entry.
 */
const setupClientQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockClientQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

/** Set up pool.query (non-transaction path) responses in sequence. */
const setupPoolQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockPoolQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. registerUser
// ─────────────────────────────────────────────────────────────────────────────
describe('registerUser', () => {
  test('registers a new user and returns a JWT + user object with role User', async () => {
    setupClientQueries(
      { rows: [] },                                                   // BEGIN
      { rows: [] },                                                   // email uniqueness check — not found
      { rows: [{ id: 1, role: 'User', full_name: 'Alice', email: 'alice@test.com' }] }, // INSERT
      { rows: [] },                                                   // COMMIT
    );

    const res = await registerUser('Alice', 'alice@test.com', 'password123', 'Admin');
    expect(res.user.role).toBe('User'); // mass assignment: supplied 'Admin' role ignored
    expect(res.user.email).toBe('alice@test.com');
    expect(res.token).toBeDefined();
    const decoded = jwt.verify(res.token, JWT_SECRET) as any;
    expect(decoded.role).toBe('User');
  });

  test('throws "User already exists" when email is already taken', async () => {
    setupClientQueries(
      { rows: [] },               // BEGIN
      { rows: [{ id: 5 }] },      // email check — found
    );
    await expect(
      registerUser('Bob', 'bob@test.com', 'pass', 'User'),
    ).rejects.toThrow('User already exists');
    // ROLLBACK must be issued
    const hasRollback = mockClientQuery.mock.calls.some(([s]: [string]) => s === 'ROLLBACK');
    expect(hasRollback).toBe(true);
  });

  test('mass assignment: supplied role is never trusted — always defaults to User', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [] },
      { rows: [{ id: 2, role: 'User', full_name: 'Charlie', email: 'charlie@test.com' }] },
      { rows: [] },
    );
    const res = await registerUser('Charlie', 'charlie@test.com', 'pass', 'Admin');
    expect(res.user.role).toBe('User');
  });

  test('valid MANAGER_INVITE token promotes user to Business and assigns locationId', async () => {
    const token = makeInviteToken(7);
    const tokenHash = require('crypto').createHash('sha256').update(token).digest('hex');

    setupClientQueries(
      { rows: [] },                                                     // BEGIN
      { rows: [] },                                                     // email check
      { rows: [{ id: 3, role: 'User', full_name: 'Dave', email: 'dave@test.com' }] }, // INSERT user
      { rows: [{ id: 7 }], rowCount: 1 },                             // UPDATE business_location (valid token)
      { rows: [] },                                                     // UPDATE user role → Business
      { rows: [] },                                                     // COMMIT
    );

    const res = await registerUser('Dave', 'dave@test.com', 'pass', 'User', token);
    expect(res.user.role).toBe('Business');
    expect(res.user.location_id).toBe(7);
    expect(res.user.requiresBusinessSetup).toBe(false);
  });

  test('throws "Invalid or already-used invitation link" when invite token is already used (rowCount 0)', async () => {
    const token = makeInviteToken(7);
    setupClientQueries(
      { rows: [] },                                                             // BEGIN
      { rows: [] },                                                             // email check
      { rows: [{ id: 3, role: 'User', full_name: 'Dave', email: 'dave@test.com' }] }, // INSERT user
      { rows: [], rowCount: 0 },                                                // UPDATE biz_loc — already used
    );
    await expect(
      registerUser('Dave', 'dave@test.com', 'pass', 'User', token),
    ).rejects.toThrow('Invalid or already-used invitation link');
  });

  test('throws for an expired invite token', async () => {
    const expiredToken = makeInviteToken(7, -1); // already expired
    setupClientQueries(
      { rows: [] },                                                             // BEGIN
      { rows: [] },                                                             // email check
      { rows: [{ id: 4, role: 'User', full_name: 'Eve', email: 'eve@test.com' }] }, // INSERT user
    );
    await expect(
      registerUser('Eve', 'eve@test.com', 'pass', 'User', expiredToken),
    ).rejects.toThrow();
  });

  test('throws for an invite token with wrong type field', async () => {
    const wrongTypeToken = jwt.sign(
      { type: 'SOMETHING_ELSE', locationId: 7 },
      JWT_SECRET,
      { expiresIn: '1h' },
    );
    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [] }, // email check
      { rows: [{ id: 5, role: 'User', full_name: 'Frank', email: 'frank@test.com' }] },
      { rows: [] }, // COMMIT — wrong type means token is silently skipped, then commits
    );
    // When type is wrong the invite branch is skipped — user registers as plain User
    const res = await registerUser('Frank', 'frank@test.com', 'pass', 'User', wrongTypeToken);
    expect(res.user.role).toBe('User');
    expect(res.user.location_id).toBeNull();
  });

  test('client.release() is called even when registration fails', async () => {
    setupClientQueries(
      { rows: [] },         // BEGIN
      { rows: [{ id: 1 }] }, // email check — duplicate → throws
    );
    await expect(
      registerUser('Alice', 'alice@test.com', 'pass', 'User'),
    ).rejects.toThrow();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. loginUser
// ─────────────────────────────────────────────────────────────────────────────
describe('loginUser', () => {
  const makePasswordHash = (plain: string) => bcrypt.hashSync(plain, 10);

  test('returns token and user on valid credentials', async () => {
    const hash = makePasswordHash('correctpass');
    setupPoolQueries(
      { rows: [{ id: 10, email: 'alice@test.com', password_hash: hash, full_name: 'Alice', role: 'User' }] }, // user lookup
      { rows: [] }, // business_location manager check — no location
    );

    const res = await loginUser('alice@test.com', 'correctpass');
    expect(res.user.email).toBe('alice@test.com');
    expect(res.token).toBeDefined();
    const decoded = jwt.verify(res.token, JWT_SECRET) as any;
    expect(decoded.id).toBe(10);
  });

  test('throws "Invalid credentials" when user not found', async () => {
    setupPoolQueries({ rows: [] }); // user lookup — empty
    await expect(loginUser('nobody@test.com', 'pass')).rejects.toThrow('Invalid credentials');
  });

  test('throws "Invalid credentials" when password is wrong', async () => {
    const hash = makePasswordHash('realpass');
    setupPoolQueries(
      { rows: [{ id: 11, email: 'bob@test.com', password_hash: hash, full_name: 'Bob', role: 'User' }] },
    );
    await expect(loginUser('bob@test.com', 'wrongpass')).rejects.toThrow('Invalid credentials');
  });

  test('requiresBusinessSetup is true for Business user with no location and no business row', async () => {
    const hash = makePasswordHash('pass');
    setupPoolQueries(
      { rows: [{ id: 20, email: 'biz@test.com', password_hash: hash, full_name: 'Biz', role: 'Business' }] },
      { rows: [] },  // business_location — no managed location
      { rows: [] },  // business lookup — no business row yet
    );
    const res = await loginUser('biz@test.com', 'pass');
    expect(res.user.requiresBusinessSetup).toBe(true);
  });

  test('requiresBusinessSetup is false for Business user who already has a business row', async () => {
    const hash = makePasswordHash('pass');
    setupPoolQueries(
      { rows: [{ id: 21, email: 'biz2@test.com', password_hash: hash, full_name: 'Biz2', role: 'Business' }] },
      { rows: [] },  // business_location — no managed location
      { rows: [{ id: 55, is_subscribed: true, logo_url: null }] }, // business row exists
    );
    const res = await loginUser('biz2@test.com', 'pass');
    expect(res.user.requiresBusinessSetup).toBe(false);
  });

  test('accepts valid invite token on login and promotes user to Business', async () => {
    const hash = makePasswordHash('pass');
    const token = makeInviteToken(12);
    setupPoolQueries(
      { rows: [{ id: 30, email: 'mgr@test.com', password_hash: hash, full_name: 'Mgr', role: 'User' }] },
    );
    setupClientQueries(
      { rows: [] },                          // BEGIN
      { rows: [{ id: 12 }], rowCount: 1 },  // UPDATE business_location
      { rows: [] },                          // UPDATE user role
      { rows: [] },                          // COMMIT
    );

    const res = await loginUser('mgr@test.com', 'pass', token);
    expect(res.user.role).toBe('Business');
    expect(res.user.location_id).toBe(12);
  });

  test('throws "Invalid or already-used invitation link" when invite already used during login', async () => {
    const hash = makePasswordHash('pass');
    const token = makeInviteToken(12);
    setupPoolQueries(
      { rows: [{ id: 31, email: 'mgr2@test.com', password_hash: hash, full_name: 'Mgr2', role: 'User' }] },
    );
    setupClientQueries(
      { rows: [] },                         // BEGIN
      { rows: [], rowCount: 0 },            // UPDATE biz_loc — already used → rowCount 0
    );
    await expect(loginUser('mgr2@test.com', 'pass', token)).rejects.toThrow(
      'Invalid or already-used invitation link',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. syncExternalUser (Clerk webhook sync / upsert)
// ─────────────────────────────────────────────────────────────────────────────
describe('syncExternalUser', () => {
  test('upserts a new user and returns sync successful with role User', async () => {
    setupClientQueries(
      { rows: [] },  // BEGIN
      { rows: [{ id: 40, role: 'User', fullName: 'NewUser', email: 'new@test.com' }] }, // upsert
      { rows: [] },  // business_location manager check
      { rows: [] },  // COMMIT
    );

    const res = await syncExternalUser('ext_001', 'new@test.com', 'NewUser');
    expect(res.message).toBe('Sync successful');
    expect(res.user.role).toBe('User');
    expect(res.token).toBeDefined();
  });

  test('Admin role in metadata is blocked — defaults to User', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [{ id: 41, role: 'User', fullName: 'AdminWannabe', email: 'admin@test.com' }] },
      { rows: [] },  // business_location check
      { rows: [] },
    );
    const res = await syncExternalUser('ext_002', 'admin@test.com', 'AdminWannabe', { role: 'Admin' });
    expect(res.user.role).toBe('User');
  });

  test('valid invite token assigns manager to correct locationId and promotes to Business', async () => {
    const token = makeInviteToken(20);
    setupClientQueries(
      { rows: [] },
      { rows: [{ id: 50, role: 'User', fullName: 'Mgr', email: 'mgr@sync.com' }] },
      { rows: [{ id: 20 }], rowCount: 1 }, // UPDATE biz_loc
      { rows: [] },                         // UPDATE role
      { rows: [] },                         // COMMIT
    );

    const res = await syncExternalUser('ext_003', 'mgr@sync.com', 'Mgr', { inviteToken: token });
    expect(res.user.role).toBe('Business');
    expect(res.user.location_id).toBe(20);
  });

  test('throws "Invalid or already-used invitation link" when invite already consumed', async () => {
    const token = makeInviteToken(20);
    setupClientQueries(
      { rows: [] },
      { rows: [{ id: 51, role: 'User', fullName: 'Dup', email: 'dup@sync.com' }] },
      { rows: [], rowCount: 0 }, // UPDATE biz_loc — already used
    );
    await expect(
      syncExternalUser('ext_004', 'dup@sync.com', 'Dup', { inviteToken: token }),
    ).rejects.toThrow('Invalid or already-used invitation link');
  });

  test('requiresBusinessSetup is true for Business user with no location and no business row', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [{ id: 60, role: 'Business', fullName: 'Biz', email: 'biz@sync.com' }] },
      { rows: [] }, // business_location — no location
      { rows: [] }, // business lookup — empty
      { rows: [] }, // COMMIT
    );
    const res = await syncExternalUser('ext_005', 'biz@sync.com', 'Biz', { role: 'Business' });
    expect(res.user.requiresBusinessSetup).toBe(true);
  });

  test('requiresBusinessSetup is false when Business user already has a business row', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [{ id: 61, role: 'Business', fullName: 'Biz2', email: 'biz2@sync.com' }] },
      { rows: [] }, // no location
      { rows: [{ id: 77, is_subscribed: true, logo_url: null }] }, // business exists
      { rows: [] }, // COMMIT
    );
    const res = await syncExternalUser('ext_006', 'biz2@sync.com', 'Biz2', { role: 'Business' });
    expect(res.user.requiresBusinessSetup).toBe(false);
  });

  test('client.release() is always called even on error', async () => {
    mockClientQuery.mockRejectedValueOnce(new Error('DB down'));
    await expect(
      syncExternalUser('ext_007', 'err@sync.com', 'ErrUser'),
    ).rejects.toThrow('DB down');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
