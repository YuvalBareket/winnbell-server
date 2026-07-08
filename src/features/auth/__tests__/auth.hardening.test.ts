/**
 * Tests — auth hardening batch (F16, F18).
 *
 * F16: loginUser must run a bcrypt compare EVEN when the email is unknown, so a missing account
 *      is indistinguishable from a wrong password by timing (no user-enumeration oracle).
 * F18: the legacy /auth/register endpoint must reject passwords below the minimum length.
 */

const mockQuery = jest.fn();
jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockQuery, connect: jest.fn() }),
}));
// jose is ESM-only; the controller imports it. Mock so ts-jest can load the module.
jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import bcrypt from 'bcryptjs';
import { loginUser } from '../auth.service';
import { register } from '../auth.controller';

process.env.JWT_SECRET = 'test-secret';

type Res = { status: jest.Mock; json: jest.Mock; statusCode?: number };
const makeRes = (): Res => {
  const res = {} as Res;
  res.status = jest.fn().mockImplementation((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn().mockReturnValue(res);
  return res;
};
const makeReq = (body: Record<string, unknown>) =>
  ({ body, headers: {} } as unknown as Parameters<typeof register>[0]);

beforeEach(() => {
  mockQuery.mockReset();
  jest.restoreAllMocks();
});

describe('F16 — login timing equalization', () => {
  test('unknown email still runs bcrypt.compare (no early-out) and rejects the same way', async () => {
    mockQuery.mockResolvedValue({ rows: [] }); // no such user
    const compareSpy = jest.spyOn(bcrypt, 'compare');

    await expect(loginUser('nobody@example.com', 'somepassword')).rejects.toThrow('Invalid credentials');

    // The dummy compare ran, so an unknown email costs ~the same as a wrong password.
    expect(compareSpy).toHaveBeenCalledTimes(1);
    expect(compareSpy.mock.calls[0][0]).toBe('somepassword');
  });
});

describe('F18 — legacy register minimum password length', () => {
  test('rejects a password shorter than 8 chars with 400, before hitting the service', async () => {
    const res = makeRes();
    await register(makeReq({ fullName: 'Test User', email: 'a@b.com', password: 'short' }), res as never);

    expect(res.statusCode).toBe(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/at least 8/i);
    expect(mockQuery).not.toHaveBeenCalled(); // never reached registerUser's DB work
  });

  test('accepts an 8+ char password (passes the length guard into the service path)', async () => {
    // Let the service run far enough to prove the guard did NOT block a valid-length password.
    // registerUser will fail later on the mocked DB; we only assert it got PAST the 400 guard.
    mockQuery.mockRejectedValue(new Error('db not wired for this test'));
    const res = makeRes();
    await register(makeReq({ fullName: 'Test User', email: 'a@b.com', password: 'longenough1' }), res as never);

    // Not a 400 length rejection — it proceeded and hit the (mocked) service/DB -> 500.
    expect(res.statusCode).not.toBe(400);
  });
});
