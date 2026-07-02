/**
 * Tests — business.service.ts: removeLocationManagerService & deleteBusinessLocation
 *
 * Covers:
 *   removeLocationManagerService
 *     - Happy path: detaches manager (NULL), demotes to User, deletes refresh tokens,
 *       commits, and invalidates auth cache
 *     - Does NOT demote when user is an Admin
 *     - Does NOT demote when user owns a business
 *     - Does NOT demote when user still manages another location
 *     - Throws UNAUTHORIZED_OR_INVALID_LOCATION when owner does not own the location
 *     - Throws NO_MANAGER_ASSIGNED when there is no manager
 *     - Rolls back on mid-transaction DB failure
 *
 *   deleteBusinessLocation
 *     - Soft-deletes (is_active = false) and detaches manager in same UPDATE
 *     - Detaches manager BEFORE demotion check runs (so demote sees no managed location)
 *     - Demotes manager when one is assigned
 *     - Works without demotion path when no manager is assigned
 *     - Throws UNAUTHORIZED_OR_INVALID_LOCATION when owner does not own the location
 *     - Rolls back on mid-transaction failure
 *     - Calls invalidateUserAuth when a manager was assigned
 *     - Does NOT call invalidateUserAuth when no manager was assigned
 *
 * Mock pattern (matches existing business.service.test.ts):
 *   pool.query(sql, params) for non-transactional reads (ownership checks)
 *   pool.connect() → client (query / release) for transactional writes
 */

// ── Mock DB before any imports ────────────────────────────────────────────────
const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockClient = { query: mockClientQuery, release: mockClientRelease };

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({
    query: mockPoolQuery,
    connect: jest.fn().mockResolvedValue(mockClient),
  }),
}));

// ── Mock cache — we want to spy on invalidateUserAuth ─────────────────────────
const mockInvalidateUserAuth = jest.fn();
const mockInvalidatePublicBusinessData = jest.fn();
const mockInvalidatePublicLocation = jest.fn();

jest.mock('../../../shared/cache/cache.js', () => ({
  publicCache: { del: jest.fn(), get: jest.fn().mockReturnValue(undefined), set: jest.fn() },
  invalidatePublicBusinessData: (...args: unknown[]) => mockInvalidatePublicBusinessData(...args),
  invalidatePublicLocation: (...args: unknown[]) => mockInvalidatePublicLocation(...args),
  invalidateUserAuth: (...args: unknown[]) => mockInvalidateUserAuth(...args),
  getPlatformSettings: jest.fn().mockResolvedValue({}),
}));

import { removeLocationManagerService, deleteBusinessLocation } from '../business.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Sequential pool.query responses (ownership / read queries). */
const setupPoolQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockPoolQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

/** Sequential client.query responses (transactional writes). */
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
// removeLocationManagerService
// ─────────────────────────────────────────────────────────────────────────────

describe('removeLocationManagerService', () => {
  it('should detach the manager (UPDATE SET manager_user_id = NULL), demote to User, delete refresh tokens, commit, and invalidate auth cache', async () => {
    const MANAGER_ID = 42;
    const LOCATION_ID = 7;
    const OWNER_ID = 1;

    // Ownership check returns the manager
    setupPoolQueries({ rows: [{ manager_user_id: MANAGER_ID }] });

    // Transaction: BEGIN, UPDATE biz_loc (detach), UPDATE user (demote), DELETE refresh_token, COMMIT
    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [], rowCount: 1 }, // UPDATE business_location SET manager_user_id = NULL
      { rows: [], rowCount: 1 }, // UPDATE "user" SET role = 'User' (demotion)
      { rows: [], rowCount: 1 }, // DELETE FROM refresh_token
      { rows: [] }, // COMMIT
    );

    await removeLocationManagerService(LOCATION_ID, OWNER_ID);

    // Ownership check fired against pool
    const ownerCheckCall = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(ownerCheckCall[0]).toMatch(/SELECT bl\.manager_user_id/);
    expect(ownerCheckCall[1]).toContain(LOCATION_ID);
    expect(ownerCheckCall[1]).toContain(OWNER_ID);

    // Detach call
    const detachCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('SET manager_user_id = NULL'),
    );
    expect(detachCall).toBeDefined();
    expect(detachCall![1]).toContain(LOCATION_ID);

    // Demotion call
    const demoteCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("SET role = 'User'"),
    );
    expect(demoteCall).toBeDefined();
    expect(demoteCall![1]).toContain(MANAGER_ID);

    // Refresh token deletion
    const deleteTokenCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE FROM refresh_token'),
    );
    expect(deleteTokenCall).toBeDefined();
    expect(deleteTokenCall![1]).toContain(MANAGER_ID);

    // COMMIT issued
    const hasCommit = mockClientQuery.mock.calls.some(([s]: [string]) => s === 'COMMIT');
    expect(hasCommit).toBe(true);

    // Auth cache invalidated for the manager
    expect(mockInvalidateUserAuth).toHaveBeenCalledWith(MANAGER_ID);

    // Client released
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('should NOT demote when the user is an Admin (demotion query condition excludes Admin)', async () => {
    // The SQL has: AND role != 'Admin' — so if the DB user is Admin, no rows are updated.
    // We still expect the DELETE from refresh_token and the query to be issued.
    setupPoolQueries({ rows: [{ manager_user_id: 99 }] });
    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [], rowCount: 1 }, // detach
      { rows: [], rowCount: 0 }, // demotion — 0 rows means Admin was skipped
      { rows: [], rowCount: 0 }, // DELETE refresh_token
      { rows: [] }, // COMMIT
    );

    await removeLocationManagerService(7, 1);

    const demoteCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("SET role = 'User'"),
    );
    // The query IS still issued — the DB engine (not the service) enforces the Admin guard
    expect(demoteCall).toBeDefined();
    const demoteSql = demoteCall![0] as string;
    expect(demoteSql).toMatch(/role != 'Admin'/);
  });

  it('should NOT demote when the user owns a business (demotion query checks NOT EXISTS business)', async () => {
    setupPoolQueries({ rows: [{ manager_user_id: 55 }] });
    setupClientQueries(
      { rows: [] },
      { rows: [], rowCount: 1 }, // detach
      { rows: [], rowCount: 0 }, // demotion skipped — owns a business
      { rows: [], rowCount: 0 }, // token revoke
      { rows: [] }, // COMMIT
    );

    await removeLocationManagerService(7, 1);

    const demoteCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("SET role = 'User'"),
    );
    expect(demoteCall).toBeDefined();
    const demoteSql = demoteCall![0] as string;
    expect(demoteSql).toMatch(/NOT EXISTS.*business/s);
  });

  it('should NOT demote when the user still manages another location (demotion query checks NOT EXISTS business_location)', async () => {
    setupPoolQueries({ rows: [{ manager_user_id: 66 }] });
    setupClientQueries(
      { rows: [] },
      { rows: [], rowCount: 1 }, // detach
      { rows: [], rowCount: 0 }, // demotion skipped — still manages another location
      { rows: [], rowCount: 1 }, // token revoke still fires
      { rows: [] }, // COMMIT
    );

    await removeLocationManagerService(7, 1);

    const demoteCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("SET role = 'User'"),
    );
    expect(demoteCall).toBeDefined();
    const demoteSql = demoteCall![0] as string;
    expect(demoteSql).toMatch(/NOT EXISTS.*business_location/s);
  });

  it('should throw UNAUTHORIZED_OR_INVALID_LOCATION when the owner does not own the location', async () => {
    setupPoolQueries({ rows: [] }); // ownership check returns empty

    await expect(removeLocationManagerService(7, 999)).rejects.toThrow(
      'UNAUTHORIZED_OR_INVALID_LOCATION',
    );

    // No transaction should be started
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('should throw NO_MANAGER_ASSIGNED when there is no manager on the location', async () => {
    setupPoolQueries({ rows: [{ manager_user_id: null }] });

    await expect(removeLocationManagerService(7, 1)).rejects.toThrow('NO_MANAGER_ASSIGNED');

    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('should roll back and rethrow when a mid-transaction DB failure occurs', async () => {
    setupPoolQueries({ rows: [{ manager_user_id: 42 }] });

    let i = 0;
    const responses = [
      () => Promise.resolve({ rows: [] }),        // BEGIN
      () => Promise.resolve({ rows: [], rowCount: 1 }), // detach
      () => Promise.reject(new Error('DB exploded')),   // demote fails
    ];
    mockClientQuery.mockImplementation(() => {
      const fn = responses[i] ?? responses[responses.length - 1];
      i++;
      return fn();
    });

    await expect(removeLocationManagerService(7, 1)).rejects.toThrow('DB exploded');

    const hasRollback = mockClientQuery.mock.calls.some(([s]: [string]) => s === 'ROLLBACK');
    expect(hasRollback).toBe(true);
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteBusinessLocation
// ─────────────────────────────────────────────────────────────────────────────

describe('deleteBusinessLocation', () => {
  it('should soft-delete the location (is_active = false) and detach manager in the same UPDATE statement', async () => {
    // With a manager assigned
    const MANAGER_ID = 77;
    const LOCATION_ID = 10;
    const OWNER_ID = 2;

    setupPoolQueries({
      rows: [{ id: LOCATION_ID, manager_user_id: MANAGER_ID }],
    });

    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [], rowCount: 1 }, // UPDATE biz_loc SET is_active=false, manager_user_id=NULL
      { rows: [], rowCount: 1 }, // demote
      { rows: [], rowCount: 1 }, // DELETE refresh_token
      { rows: [] }, // COMMIT
    );

    await deleteBusinessLocation(LOCATION_ID, OWNER_ID);

    const softDeleteCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === 'string' &&
        sql.includes('is_active = false') &&
        sql.includes('manager_user_id = NULL'),
    );
    expect(softDeleteCall).toBeDefined();
    expect(softDeleteCall![1]).toContain(LOCATION_ID);
  });

  it('should detach the manager BEFORE the demotion check so the demote query does not see this location', async () => {
    // The critical ordering: UPDATE biz_loc (detach+soft-delete) must come BEFORE
    // demoteFormerManager runs. The demotion SQL checks:
    //   NOT EXISTS (SELECT 1 FROM business_location WHERE manager_user_id = $1)
    // If detach happens first, that subquery returns false and demotion proceeds correctly.
    const MANAGER_ID = 88;
    setupPoolQueries({ rows: [{ id: 10, manager_user_id: MANAGER_ID }] });
    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [], rowCount: 1 }, // soft-delete + detach (must be before demote)
      { rows: [], rowCount: 1 }, // demote
      { rows: [], rowCount: 1 }, // DELETE refresh_token
      { rows: [] }, // COMMIT
    );

    await deleteBusinessLocation(10, 2);

    // Verify ordering: soft-delete call index must be lower than demotion call index
    const calls = mockClientQuery.mock.calls as [string, unknown[]][];
    const softDeleteIdx = calls.findIndex(
      ([sql]) => typeof sql === 'string' && sql.includes('is_active = false') && sql.includes('manager_user_id = NULL'),
    );
    const demoteIdx = calls.findIndex(
      ([sql]) => typeof sql === 'string' && sql.includes("SET role = 'User'"),
    );
    expect(softDeleteIdx).toBeGreaterThanOrEqual(0);
    expect(demoteIdx).toBeGreaterThanOrEqual(0);
    expect(softDeleteIdx).toBeLessThan(demoteIdx);
  });

  it('should demote and revoke tokens for the manager when one is assigned', async () => {
    const MANAGER_ID = 77;
    setupPoolQueries({ rows: [{ id: 10, manager_user_id: MANAGER_ID }] });
    setupClientQueries(
      { rows: [] },
      { rows: [], rowCount: 1 }, // soft-delete+detach
      { rows: [], rowCount: 1 }, // demote
      { rows: [], rowCount: 1 }, // DELETE refresh_token
      { rows: [] }, // COMMIT
    );

    await deleteBusinessLocation(10, 2);

    const deleteCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE FROM refresh_token'),
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall![1]).toContain(MANAGER_ID);

    expect(mockInvalidateUserAuth).toHaveBeenCalledWith(MANAGER_ID);
  });

  it('should work without demotion when the location has no manager assigned', async () => {
    setupPoolQueries({ rows: [{ id: 10, manager_user_id: null }] });
    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [], rowCount: 1 }, // soft-delete (no detach needed — no manager)
      { rows: [] }, // COMMIT
    );

    await expect(deleteBusinessLocation(10, 2)).resolves.toBeUndefined();

    // No demotion query
    const demoteCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("SET role = 'User'"),
    );
    expect(demoteCall).toBeUndefined();

    // No token deletion
    const deleteTokenCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE FROM refresh_token'),
    );
    expect(deleteTokenCall).toBeUndefined();

    // invalidateUserAuth NOT called when no manager
    expect(mockInvalidateUserAuth).not.toHaveBeenCalled();
  });

  it('should throw UNAUTHORIZED_OR_INVALID_LOCATION when owner does not own the location', async () => {
    setupPoolQueries({ rows: [] }); // ownership check fails

    await expect(deleteBusinessLocation(10, 999)).rejects.toThrow(
      'UNAUTHORIZED_OR_INVALID_LOCATION',
    );

    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('should roll back and rethrow on mid-transaction failure', async () => {
    setupPoolQueries({ rows: [{ id: 10, manager_user_id: 42 }] });

    let i = 0;
    const responses = [
      () => Promise.resolve({ rows: [] }),              // BEGIN
      () => Promise.reject(new Error('disk full')),     // soft-delete fails
    ];
    mockClientQuery.mockImplementation(() => {
      const fn = responses[i] ?? responses[responses.length - 1];
      i++;
      return fn();
    });

    await expect(deleteBusinessLocation(10, 2)).rejects.toThrow('disk full');

    const hasRollback = mockClientQuery.mock.calls.some(([s]: [string]) => s === 'ROLLBACK');
    expect(hasRollback).toBe(true);
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it('should call invalidatePublicBusinessData and clear location cache after deletion', async () => {
    setupPoolQueries({ rows: [{ id: 10, manager_user_id: null }] });
    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [], rowCount: 1 }, // soft-delete
      { rows: [] }, // COMMIT
    );

    await deleteBusinessLocation(10, 2);

    expect(mockInvalidatePublicBusinessData).toHaveBeenCalled();
    // Location profile cache is cleared through the single source of truth (both key variants)
    expect(mockInvalidatePublicLocation).toHaveBeenCalledWith(10);
  });
});
