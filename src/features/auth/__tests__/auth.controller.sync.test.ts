/**
 * Tests — auth.controller.ts → syncUser (Supabase JWT verification)
 *
 * Covers:
 *   - No token → 401
 *   - Invalid / tampered token → 401
 *   - REGION_RESTRICTED thrown by service → 403
 *   - Valid Supabase JWT → 200 + calls syncExternalUser with correct args
 */

import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';

// ── Env setup ─────────────────────────────────────────────────────────────────
const SUPABASE_JWT_SECRET = 'test-supabase-secret';
process.env.SUPABASE_JWT_SECRET = SUPABASE_JWT_SECRET;
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.JWT_SECRET = 'test-internal-secret';

// ── Mock jose (ESM-only package) before controller is imported ─────────────────
// jose uses ES module syntax which CommonJS Jest cannot parse.
// We replace it with a CJS-compatible stub that delegates token verification to
// jsonwebtoken using the same SUPABASE_JWT_SECRET the test signs tokens with.
jest.mock('jose', () => {
  const jwtLib = require('jsonwebtoken');
  return {
    createRemoteJWKSet: jest.fn().mockReturnValue('__mock_jwks__'),
    jwtVerify: jest.fn().mockImplementation(
      (token: string, _keyset: unknown) => {
        // Verify with the shared test secret — throws on invalid/expired token
        const payload = jwtLib.verify(token, SUPABASE_JWT_SECRET);
        return Promise.resolve({ payload });
      },
    ),
  };
});

// ── Mock DB (getPool imported by auth.controller) ─────────────────────────────
jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows: [{ allowed_states: [] }] }),
  }),
}));

// ── Mock auth service ─────────────────────────────────────────────────────────
const mockSyncExternalUser = jest.fn();
jest.mock('../auth.service.js', () => ({
  syncExternalUser: (...args: unknown[]) => mockSyncExternalUser(...args),
  // Remaining exports not needed by syncUser controller
  registerUser: jest.fn(),
  loginUser: jest.fn(),
  getRegionFromIp: jest.fn().mockResolvedValue({ country: null, stateCode: null }),
  evaluateRegionRestriction: jest.fn().mockResolvedValue({ blocked: false, country: null, state: null }),
  changePasswordService: jest.fn(),
}));

import { syncUser } from '../auth.controller';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a Supabase-style access token signed with our test secret. */
const makeToken = (
  payload: Record<string, unknown>,
  expiresIn: jwt.SignOptions['expiresIn'] = '1h',
) => jwt.sign(payload, SUPABASE_JWT_SECRET, { expiresIn });

const makeReq = (overrides: Partial<Request> = {}): Request =>
  ({
    headers: {},
    body: {},
    ip: '127.0.0.1',
    ...overrides,
  }) as unknown as Request;

const makeRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('syncUser controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();

    await syncUser(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'No token provided' });
    expect(mockSyncExternalUser).not.toHaveBeenCalled();
  });

  it('returns 401 when token is invalid / tampered', async () => {
    const req = makeReq({
      headers: { authorization: 'Bearer invalid.token.here' },
    });
    const res = makeRes();

    await syncUser(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid or expired token' });
  });

  it('returns 401 when token is signed with wrong secret', async () => {
    const token = jwt.sign({ sub: 'user-123', email: 'test@test.com' }, 'wrong-secret');
    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
    });
    const res = makeRes();

    await syncUser(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when token is expired', async () => {
    const token = makeToken({ sub: 'user-123', email: 'test@test.com' }, '-1s');
    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
    });
    const res = makeRes();

    await syncUser(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 when service throws REGION_RESTRICTED', async () => {
    const token = makeToken({ sub: 'user-123', email: 'blocked@test.com' });
    mockSyncExternalUser.mockRejectedValueOnce(new Error('REGION_RESTRICTED'));

    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
    });
    const res = makeRes();

    await syncUser(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'REGION_RESTRICTED' });
  });

  it('calls syncExternalUser with correct args and returns 200 on success', async () => {
    const userId = 'supabase-uuid-abc123';
    const email = 'user@example.com';
    const fullName = 'Jane Doe';
    // Role MUST come from JWT user_metadata — controller reads meta['role'], not req.body
    const token = makeToken({
      sub: userId,
      email,
      user_metadata: { full_name: fullName, role: 'User' },
    });

    const mockResult = { token: 'internal-jwt', user: { id: 1, email, role: 'User' } };
    mockSyncExternalUser.mockResolvedValueOnce(mockResult);

    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
      body: { inviteToken: null },
    });
    const res = makeRes();

    await syncUser(req, res);

    // role comes from JWT metadata, NOT from req.body — this is the key security invariant
    expect(mockSyncExternalUser).toHaveBeenCalledWith(
      userId,
      email,
      fullName,
      expect.objectContaining({ role: 'User', inviteToken: null }),
    );
    expect(res.json).toHaveBeenCalledWith(mockResult);
    expect(res.status).not.toHaveBeenCalledWith(401);
  });

  it('extracts full_name from user_metadata.name fallback', async () => {
    const token = makeToken({
      sub: 'user-456',
      email: 'google@user.com',
      user_metadata: { name: 'Google User' },
    });
    mockSyncExternalUser.mockResolvedValueOnce({ token: 'tok', user: { id: 2 } });

    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
      body: {},
    });
    const res = makeRes();

    await syncUser(req, res);

    expect(mockSyncExternalUser).toHaveBeenCalledWith(
      'user-456',
      'google@user.com',
      'Google User',
      expect.anything(),
    );
  });

  it('passes inviteToken from request body', async () => {
    const token = makeToken({ sub: 'user-789', email: 'invited@test.com' });
    mockSyncExternalUser.mockResolvedValueOnce({ token: 'tok', user: { id: 3 } });

    const inviteToken = 'some-invite-token';
    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
      body: { inviteToken },
    });
    const res = makeRes();

    await syncUser(req, res);

    expect(mockSyncExternalUser).toHaveBeenCalledWith(
      'user-789',
      'invited@test.com',
      '',
      expect.objectContaining({ inviteToken }),
    );
  });
});
