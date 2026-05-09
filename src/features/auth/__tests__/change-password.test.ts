/**
 * QA/Security Tests — changePasswordService (auth.service.ts)
 *
 * Mock pattern: pool.query(sql, params) → { rows, rowCount }
 *               bcryptjs mocked for compare / genSalt / hash
 */

// ── Mock the DB module before any imports ────────────────────────────────────
const mockQuery = jest.fn();

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockQuery }),
}));

jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  genSalt: jest.fn().mockResolvedValue('salt'),
  hash: jest.fn().mockResolvedValue('newhash'),
}));

import bcrypt from 'bcryptjs';
import { changePasswordService } from '../auth.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Set up sequential pool.query responses. Repeats last entry if exhausted. */
const setupPoolQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// changePasswordService
// ─────────────────────────────────────────────────────────────────────────────
describe('changePasswordService', () => {
  it('should resolve without error on the happy path when all inputs are valid', async () => {
    setupPoolQueries(
      { rows: [{ password_hash: 'oldhash' }] }, // SELECT password_hash
      { rows: [], rowCount: 1 },                 // UPDATE password_hash
    );
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    await expect(
      changePasswordService(1, 'currentpass', 'newpassword123'),
    ).resolves.toBeUndefined();

    // Both SELECT and UPDATE queries must have fired
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('should throw USER_NOT_FOUND when the SELECT returns no rows', async () => {
    setupPoolQueries({ rows: [] });

    await expect(
      changePasswordService(99, 'currentpass', 'newpassword123'),
    ).rejects.toThrow('USER_NOT_FOUND');

    // No UPDATE should be attempted
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should throw SSO_ACCOUNT when the user row has a null password_hash', async () => {
    setupPoolQueries({ rows: [{ password_hash: null }] });

    await expect(
      changePasswordService(2, 'currentpass', 'newpassword123'),
    ).rejects.toThrow('SSO_ACCOUNT');

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should throw WRONG_PASSWORD when bcrypt.compare returns false', async () => {
    setupPoolQueries({ rows: [{ password_hash: 'oldhash' }] });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(
      changePasswordService(3, 'wrongpass', 'newpassword123'),
    ).rejects.toThrow('WRONG_PASSWORD');

    // No UPDATE should be attempted
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should throw PASSWORD_TOO_SHORT when newPassword is 7 characters', async () => {
    setupPoolQueries({ rows: [{ password_hash: 'oldhash' }] });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    await expect(
      changePasswordService(4, 'currentpass', 'short12'), // exactly 7 chars
    ).rejects.toThrow('PASSWORD_TOO_SHORT');

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should succeed without throwing when newPassword is exactly 8 characters', async () => {
    setupPoolQueries(
      { rows: [{ password_hash: 'oldhash' }] },
      { rows: [], rowCount: 1 },
    );
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    await expect(
      changePasswordService(5, 'currentpass', 'exactly8'), // exactly 8 chars
    ).resolves.toBeUndefined();
  });

  it('should call the UPDATE query with the new hash produced by bcrypt', async () => {
    const capturedCalls: Array<[string, unknown[]]> = [];
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      capturedCalls.push([sql, params]);
      return Promise.resolve({ rows: [{ password_hash: 'oldhash' }], rowCount: 1 });
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    // First call returns the user row; second is the UPDATE
    mockQuery
      .mockResolvedValueOnce({ rows: [{ password_hash: 'oldhash' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await changePasswordService(6, 'currentpass', 'newpassword123');

    const updateCall = mockQuery.mock.calls.find(([sql]: [string]) =>
      sql.includes('UPDATE'),
    );
    expect(updateCall).toBeDefined();
    const [updateSql, updateParams] = updateCall as [string, unknown[]];
    expect(updateSql).toMatch(/UPDATE "user" SET password_hash/);
    expect(updateParams).toContain('newhash'); // value from mocked bcrypt.hash
  });

  it('should call bcrypt.compare with the supplied currentPassword and the stored hash', async () => {
    setupPoolQueries(
      { rows: [{ password_hash: 'oldhash' }] },
      { rows: [], rowCount: 1 },
    );
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    await changePasswordService(7, 'mysecretpassword', 'newpassword123');

    expect(bcrypt.compare).toHaveBeenCalledWith('mysecretpassword', 'oldhash');
  });
});
