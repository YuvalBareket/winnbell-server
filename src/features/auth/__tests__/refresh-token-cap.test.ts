/**
 * Tests — role-based refresh-token cap (F12).
 *
 * Regular consumers ('User') keep at most 3 live sessions; Business owners + location managers
 * (both stored as 'Business') and internal Admins keep 8. The cap is the LIMIT in the prune
 * DELETE inside insertRefreshTokenCapped.
 */

const mockQuery = jest.fn();
jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockQuery }),
}));

import { refreshTokenCapForRole, insertRefreshTokenCapped } from '../auth.service';

describe('refreshTokenCapForRole', () => {
  test('User (regular consumer) -> 3', () => {
    expect(refreshTokenCapForRole('User')).toBe(3);
  });
  test('Business (owner + location manager) -> 8', () => {
    expect(refreshTokenCapForRole('Business')).toBe(8);
  });
  test('Admin -> 8', () => {
    expect(refreshTokenCapForRole('Admin')).toBe(8);
  });
  test('unknown/empty role falls back to the safe default (3)', () => {
    expect(refreshTokenCapForRole('')).toBe(3);
    expect(refreshTokenCapForRole('Weird')).toBe(3);
  });
});

describe('insertRefreshTokenCapped prunes to the role cap', () => {
  const exec = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  beforeEach(() => exec.query.mockClear());

  const limitPassedFor = async (role: string): Promise<number> => {
    await insertRefreshTokenCapped(exec, 713, 'hash', new Date('2026-01-01T00:00:00Z'), role);
    // 2nd query is the prune DELETE; its params are [userId, cap].
    const deleteCall = exec.query.mock.calls.find((c) => /DELETE FROM refresh_token/i.test(String(c[0])));
    return (deleteCall![1] as unknown[])[1] as number;
  };

  test('User prunes to 3', async () => {
    expect(await limitPassedFor('User')).toBe(3);
  });
  test('Business prunes to 8', async () => {
    expect(await limitPassedFor('Business')).toBe(8);
  });
});
