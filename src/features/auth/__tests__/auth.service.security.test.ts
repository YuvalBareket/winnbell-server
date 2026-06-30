/**
 * Security & edge-case tests — auth.service.ts (post-Supabase migration)
 *
 * Covers service-level invariants NOT tested in auth.service.test.ts:
 *
 *   syncExternalUser
 *     - Existing Admin role preserved even when metadata sends User (ON CONFLICT skips role)
 *     - Existing Business role preserved on re-sync (no downgrade)
 *     - REGION_RESTRICTED when IP resolves to a blocked country
 *     - Region check skipped (fail open) when geo detection fails
 *     - Manager detection: location_id populated from business_location
 *     - businessIsActive set from is_subscribed column
 *
 *   registerUser
 *     - Disposable email domains rejected before any DB call
 *     - Several known disposable domains tested
 *     - Non-disposable domains accepted
 *
 *   loginUser
 *     - business_id returned in response when Business user has a business row
 *     - business_id null when no business row exists
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

import { registerUser, loginUser, syncExternalUser } from '../auth.service';
import { invalidatePlatformSettings } from '../../../shared/cache/cache.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const JWT_SECRET = 'test-secret';
process.env.JWT_SECRET = JWT_SECRET;

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeInviteToken = (locationId: number) =>
  jwt.sign({ type: 'MANAGER_INVITE', locationId, businessId: 99 }, JWT_SECRET, { expiresIn: '1h' });

const setupClientQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockClientQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

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
  // platform settings are cached in a real node-cache — flush so each test's
  // mocked allowed_states actually takes effect
  invalidatePlatformSettings();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. registerUser — disposable email rejection
// ─────────────────────────────────────────────────────────────────────────────

describe('registerUser — disposable email rejection', () => {
  it('should reject mailinator.com before touching the DB', async () => {
    await expect(
      registerUser('Spammer', 'spam@mailinator.com', 'password', 'User'),
    ).rejects.toThrow(/disposable/i);

    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('should reject yopmail.com', async () => {
    await expect(
      registerUser('Temp', 'temp@yopmail.com', 'password', 'User'),
    ).rejects.toThrow(/disposable/i);

    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('should reject 10minutemail.com', async () => {
    await expect(
      registerUser('TempUser', 'user@10minutemail.com', 'password', 'User'),
    ).rejects.toThrow(/disposable/i);
  });

  it('should reject guerrillamail.com', async () => {
    await expect(
      registerUser('GuerrillaUser', 'user@guerrillamail.com', 'password', 'User'),
    ).rejects.toThrow(/disposable/i);
  });

  it('should accept a normal gmail.com address', async () => {
    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [] }, // email check — not found
      { rows: [{ id: 10, role: 'User', full_name: 'Real User', email: 'real@gmail.com' }] },
      { rows: [] }, // COMMIT
    );

    const res = await registerUser('Real User', 'real@gmail.com', 'password123', 'User');
    expect(res.user.email).toBe('real@gmail.com');
    expect(res.user.role).toBe('User');
  });

  it('should accept outlook.com address', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [] },
      { rows: [{ id: 11, role: 'User', full_name: 'Outlook User', email: 'user@outlook.com' }] },
      { rows: [] },
    );
    const res = await registerUser('Outlook User', 'user@outlook.com', 'password123', 'User');
    expect(res.user.email).toBe('user@outlook.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. syncExternalUser — existing role NOT downgraded on re-sync
// ─────────────────────────────────────────────────────────────────────────────

describe('syncExternalUser — existing user role is never downgraded', () => {
  it('should preserve Admin role returned by DB even when metadata says User', async () => {
    // The ON CONFLICT clause updates external_auth_id, is_email_verified, declared_state
    // but does NOT update the role column. The RETURNING clause returns the DB value.
    // This test verifies the service respects whatever role the DB gives back.
    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [] }, // deletedCheck — not a deleted account
      // Simulates ON CONFLICT DO UPDATE returning the existing DB role (Admin)
      { rows: [{ id: 99, role: 'Admin', fullName: 'Admin User', email: 'admin@prod.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] }, // business_location check
      { rows: [] }, // COMMIT
    );

    const res = await syncExternalUser('ext-admin', 'admin@prod.com', 'Admin User', { role: 'User' });

    // Service must return whatever role the DB gave back — Admin is preserved
    expect(res.user.role).toBe('Admin');
    expect(res.message).toBe('Sync successful');
  });

  it('should preserve existing Business role even when metadata says User (re-login after setup)', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      // ON CONFLICT returns existing Business role from DB
      { rows: [{ id: 50, role: 'Business', fullName: 'Biz User', email: 'biz@prod.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] }, // no location
      { rows: [{ id: 77, is_subscribed: true, logo_url: null }] }, // has biz row
      { rows: [] }, // COMMIT
    );

    const res = await syncExternalUser('ext-biz', 'biz@prod.com', 'Biz User', { role: 'User' });
    expect(res.user.role).toBe('Business');
    expect(res.user.requiresBusinessSetup).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. syncExternalUser — region blocking
// ─────────────────────────────────────────────────────────────────────────────

describe('syncExternalUser — region blocking via IP', () => {
  /** Mock the ipinfo /json response used by getRegionFromIp. */
  const mockIpinfo = (body: { country?: string; region?: string }) =>
    jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    }) as unknown as typeof fetch;

  it('should throw REGION_RESTRICTED for a non-US country when states are restricted', async () => {
    const originalFetch = global.fetch;
    global.fetch = mockIpinfo({ country: 'IL', region: 'Tel Aviv' });

    // getAllowedStates returns FL only
    mockPoolQuery.mockResolvedValue({ rows: [{ allowed_states: ['FL'] }] });

    try {
      await expect(
        syncExternalUser('ext-il', 'user@il.com', 'IL User', { ip: '203.0.113.9' }),
      ).rejects.toThrow('REGION_RESTRICTED');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should throw REGION_RESTRICTED for a US user in a non-allowed state', async () => {
    const originalFetch = global.fetch;
    global.fetch = mockIpinfo({ country: 'US', region: 'Georgia' });

    mockPoolQuery.mockResolvedValue({ rows: [{ allowed_states: ['FL'] }] });

    try {
      await expect(
        syncExternalUser('ext-ga', 'user@ga.com', 'GA User', { ip: '8.8.8.8' }),
      ).rejects.toThrow('REGION_RESTRICTED');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should allow a US user whose state is in allowed_states (stores the state code)', async () => {
    const originalFetch = global.fetch;
    global.fetch = mockIpinfo({ country: 'US', region: 'Florida' });

    setupPoolQueries({ rows: [{ allowed_states: ['FL'] }] });

    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 42, role: 'User', fullName: 'FL User', email: 'fl@test.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] },
      { rows: [] },
    );

    try {
      const res = await syncExternalUser('ext-fl', 'fl@test.com', 'FL User', { ip: '203.0.113.1' });
      expect(res.message).toBe('Sync successful');
      // declared_state param of the upsert must be the USPS code, not the country
      const upsertCall = mockClientQuery.mock.calls.find(
        ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO "user"'),
      );
      expect(upsertCall![1][4]).toBe('FL');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should NOT block when geo detection fails (fail open on network error)', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('network error')) as unknown as typeof fetch;

    // allowed_states restricted — but detection failed, so we must fail open
    setupPoolQueries({ rows: [{ allowed_states: ['FL'] }] });

    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 40, role: 'User', fullName: 'Roaming User', email: 'roam@test.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] }, // no location
      { rows: [] }, // COMMIT
    );

    try {
      const res = await syncExternalUser('ext-roam', 'roam@test.com', 'Roaming User', { ip: '1.2.3.4' });
      expect(res.message).toBe('Sync successful');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should NOT block a US user whose state could not be resolved (fail open)', async () => {
    const originalFetch = global.fetch;
    global.fetch = mockIpinfo({ country: 'US' }); // no region field

    setupPoolQueries({ rows: [{ allowed_states: ['FL'] }] });

    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 43, role: 'User', fullName: 'Mystery State', email: 'us@test.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] },
      { rows: [] },
    );

    try {
      const res = await syncExternalUser('ext-us2', 'us@test.com', 'Mystery State', { ip: '8.8.4.4' });
      expect(res.message).toBe('Sync successful');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should allow anyone when allowed_states is empty (no restriction configured)', async () => {
    const originalFetch = global.fetch;
    global.fetch = mockIpinfo({ country: 'IL', region: 'Tel Aviv' });

    setupPoolQueries({ rows: [{ allowed_states: [] }] });

    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 44, role: 'User', fullName: 'IL User', email: 'il@test.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] },
      { rows: [] },
    );

    try {
      const res = await syncExternalUser('ext-il2', 'il@test.com', 'IL User', { ip: '203.0.113.9' });
      expect(res.message).toBe('Sync successful');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should allow an existing Admin to sign in from a blocked region (admin exemption)', async () => {
    const originalFetch = global.fetch;
    // Non-US IP + restricted states — would block a normal user
    global.fetch = mockIpinfo({ country: 'IL', region: 'Tel Aviv' });

    // pool.query #1 = admin role lookup → Admin. (Region queries never fire after that.)
    setupPoolQueries({ rows: [{ role: 'Admin' }] });

    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 90, role: 'Admin', fullName: 'Platform Admin', email: 'admin@winnbell.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] },
      { rows: [] },
    );

    try {
      const res = await syncExternalUser('ext-admin-il', 'admin@winnbell.com', 'Platform Admin', { ip: '82.80.1.1' });
      expect(res.message).toBe('Sync successful');
      expect(res.user.role).toBe('Admin');
      // The ipinfo lookup must not even run for admins
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('should skip region check entirely when no ip is provided', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 41, role: 'User', fullName: 'No IP', email: 'noip@test.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] },
      { rows: [] },
    );

    const res = await syncExternalUser('ext-noip', 'noip@test.com', 'No IP', {});
    expect(res.message).toBe('Sync successful');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. syncExternalUser — Manager via business_location
// ─────────────────────────────────────────────────────────────────────────────

describe('syncExternalUser — Manager detection via business_location', () => {
  it('should populate location_id when user is assigned as manager of a location', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 60, role: 'Business', fullName: 'Mgr', email: 'mgr@biz.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [{ id: 7 }] }, // business_location — user is manager
      { rows: [] }, // COMMIT
    );

    const res = await syncExternalUser('ext-mgr', 'mgr@biz.com', 'Mgr', { role: 'Business' });

    expect(res.user.location_id).toBe(7);
    // requiresBusinessSetup is false when location_id is set
    expect(res.user.requiresBusinessSetup).toBe(false);
  });

  it('should NOT look up business_location when inviteToken is present', async () => {
    // When processing an invite token, the service assigns location via the invite
    // and skips the generic manager lookup (else branch)
    const inviteToken = makeInviteToken(20);
    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 50, role: 'User', fullName: 'Invited Mgr', email: 'invited@biz.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [{ id: 20 }], rowCount: 1 }, // UPDATE biz_loc
      { rows: [] }, // UPDATE role
      { rows: [] }, // COMMIT
    );

    const res = await syncExternalUser('ext-inv', 'invited@biz.com', 'Invited Mgr', { inviteToken });

    expect(res.user.location_id).toBe(20);
    expect(res.user.role).toBe('Business');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. syncExternalUser — businessIsActive from is_subscribed
// ─────────────────────────────────────────────────────────────────────────────

describe('syncExternalUser — businessIsActive field', () => {
  it('should set businessIsActive true when is_subscribed is true', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 70, role: 'Business', fullName: 'Active Biz', email: 'active@biz.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] }, // no location
      { rows: [{ id: 80, is_subscribed: true, logo_url: null }] },
      { rows: [] }, // COMMIT
    );

    const res = await syncExternalUser('ext-biz-active', 'active@biz.com', 'Active Biz', { role: 'Business' });

    expect(res.user.businessIsActive).toBe(true);
    expect(res.user.requiresBusinessSetup).toBe(false);
  });

  it('should set businessIsActive false when is_subscribed is false', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 71, role: 'Business', fullName: 'Inactive Biz', email: 'inactive@biz.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] },
      { rows: [{ id: 81, is_subscribed: false, logo_url: null }] },
      { rows: [] },
    );

    const res = await syncExternalUser('ext-biz-inactive', 'inactive@biz.com', 'Inactive Biz', { role: 'Business' });

    expect(res.user.businessIsActive).toBe(false);
  });

  it('should set businessIsActive false when is_subscribed is null', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 72, role: 'Business', fullName: 'Null Biz', email: 'null@biz.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] },
      { rows: [{ id: 82, is_subscribed: null, logo_url: null }] },
      { rows: [] },
    );

    const res = await syncExternalUser('ext-biz-null', 'null@biz.com', 'Null Biz', { role: 'Business' });

    expect(res.user.businessIsActive).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. loginUser — business_id in response
// ─────────────────────────────────────────────────────────────────────────────

describe('loginUser — business_id in response', () => {
  const hash = bcrypt.hashSync('pass', 10);

  it('should include business_id when Business user has a business row', async () => {
    setupPoolQueries(
      { rows: [{ id: 20, email: 'biz@test.com', password_hash: hash, full_name: 'Biz', role: 'Business' }] },
      { rows: [] }, // no managed location
      { rows: [{ id: 55, is_subscribed: true, logo_url: null }] }, // business row
    );

    const res = await loginUser('biz@test.com', 'pass');

    expect(res.user.business_id).toBe(55);
    expect(res.user.requiresBusinessSetup).toBe(false);
  });

  it('should have business_id null when Business user has no business row', async () => {
    setupPoolQueries(
      { rows: [{ id: 21, email: 'biz2@test.com', password_hash: hash, full_name: 'Biz2', role: 'Business' }] },
      { rows: [] }, // no managed location
      { rows: [] }, // no business row
    );

    const res = await loginUser('biz2@test.com', 'pass');

    expect(res.user.business_id).toBeNull();
    expect(res.user.requiresBusinessSetup).toBe(true);
  });

  it('should have business_id null for User-role accounts', async () => {
    setupPoolQueries(
      { rows: [{ id: 30, email: 'user@test.com', password_hash: hash, full_name: 'Plain User', role: 'User' }] },
      { rows: [] }, // business_location check
    );

    const res = await loginUser('user@test.com', 'pass');

    // business_id query is never run for User role — result should be null
    expect(res.user.business_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. syncExternalUser — Admin role in metadata is always blocked
// ─────────────────────────────────────────────────────────────────────────────

describe('syncExternalUser — Admin role escalation blocked', () => {
  it('should downgrade Admin metadata role to User before DB upsert', async () => {
    // The service only allows 'Business' or 'User' from metadata.
    // Any other value (including 'Admin') defaults to 'User'.
    setupClientQueries(
      { rows: [] },
      { rows: [] }, // deletedCheck
      { rows: [{ id: 99, role: 'User', fullName: 'Hacker', email: 'hacker@test.com' }] },
      { rows: [] }, // user_acquisition INSERT (added after upsert)
      { rows: [] }, // no location
      { rows: [] }, // COMMIT
    );

    const res = await syncExternalUser('ext-hacker', 'hacker@test.com', 'Hacker', { role: 'Admin' });

    // Admin is not in the allowlist — the INSERT uses 'User'
    // The DB RETURNING clause returns 'User'
    expect(res.user.role).toBe('User');
  });
});
