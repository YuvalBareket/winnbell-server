/**
 * Security tests — syncUser controller (post-Supabase migration)
 *
 * Scope: auth.controller.ts → syncUser endpoint only.
 * Service calls are mocked — this tests the controller's security invariants:
 *
 *   - role in req.body is IGNORED — only JWT user_metadata['role'] is trusted
 *   - Business role in JWT metadata is forwarded correctly
 *   - invite_token embedded in JWT user_metadata (OAuth flow) is forwarded
 *   - 500 returned on unexpected service error
 */

import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';

// ── Env ───────────────────────────────────────────────────────────────────────
const SUPABASE_JWT_SECRET = 'test-supabase-secret';
process.env.SUPABASE_JWT_SECRET = SUPABASE_JWT_SECRET;
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.JWT_SECRET = 'test-internal-secret';

// ── Mock jose (ESM-only) ──────────────────────────────────────────────────────
jest.mock('jose', () => {
  const jwtLib = require('jsonwebtoken');
  const SECRET = 'test-supabase-secret';
  return {
    createRemoteJWKSet: jest.fn().mockReturnValue('__mock_jwks__'),
    jwtVerify: jest.fn().mockImplementation(
      (token: string, _keyset: unknown) => {
        const payload = jwtLib.verify(token, SECRET);
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
  registerUser: jest.fn(),
  loginUser: jest.fn(),
  getRegionFromIp: jest.fn().mockResolvedValue({ country: null, stateCode: null }),
  evaluateRegionRestriction: jest.fn().mockResolvedValue({ blocked: false, country: null, state: null }),
  changePasswordService: jest.fn(),
}));

import { syncUser } from '../auth.controller';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeToken = (
  payload: Record<string, unknown>,
  expiresIn: jwt.SignOptions['expiresIn'] = '1h',
) => jwt.sign(payload, SUPABASE_JWT_SECRET, { expiresIn });

const makeReq = (overrides: Partial<Request> = {}): Request =>
  ({ headers: {}, body: {}, ip: '127.0.0.1', ...overrides }) as unknown as Request;

const makeRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

const makeInviteToken = (locationId: number) =>
  jwt.sign(
    { type: 'MANAGER_INVITE', locationId, businessId: 99 },
    'test-internal-secret',
    { expiresIn: '1h' },
  );

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// Role source security — role MUST come from JWT, not from req.body
// ─────────────────────────────────────────────────────────────────────────────

describe('syncUser controller — role source security', () => {
  it('should ignore role in req.body and read role from JWT user_metadata only', async () => {
    // An attacker who sends role: 'Admin' in the body must NOT have it forwarded.
    const token = makeToken({
      sub: 'attacker-sub',
      email: 'attacker@test.com',
      user_metadata: { role: 'User' }, // JWT says User
    });

    mockSyncExternalUser.mockResolvedValueOnce({ token: 'tok', user: { id: 1, role: 'User' } });

    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
      body: { role: 'Admin' }, // attacker tries to escalate via body
    });
    const res = makeRes();

    await syncUser(req, res);

    // role passed to syncExternalUser must come from JWT ('User'), not body ('Admin')
    expect(mockSyncExternalUser).toHaveBeenCalledWith(
      'attacker-sub',
      'attacker@test.com',
      '',
      expect.objectContaining({ role: 'User' }),
    );
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('forwards req.body.role to service when JWT has no role in metadata (OAuth fallback)', async () => {
    // OAuth sign-ups have no user_metadata.role in the JWT.
    // The controller falls back to req.body.role (set from pendingRole in localStorage by the client).
    // The service still sanitizes: only 'Business' passes through; anything else (including 'Admin')
    // becomes 'User' — so the forwarding is safe.
    const token = makeToken({
      sub: 'attacker2-sub',
      email: 'attacker2@test.com',
      user_metadata: {}, // no role in metadata → falls back to body
    });

    mockSyncExternalUser.mockResolvedValueOnce({ token: 'tok', user: { id: 1, role: 'User' } });

    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
      body: { role: 'Admin' }, // attacker tries to escalate via body
    });
    const res = makeRes();

    await syncUser(req, res);

    // Controller passes 'Admin' to the service, but service clamps it to 'User'
    expect(mockSyncExternalUser).toHaveBeenCalledWith(
      'attacker2-sub',
      'attacker2@test.com',
      '',
      expect.objectContaining({ role: 'Admin' }),
    );
    // Importantly, the response reflects what the service returned (role: 'User'), not 'Admin'
    expect(res.json).toHaveBeenCalledWith({ token: 'tok', user: { id: 1, role: 'User' } });
  });

  it('should forward Business role from JWT user_metadata to syncExternalUser', async () => {
    const token = makeToken({
      sub: 'biz-sub',
      email: 'biz@test.com',
      user_metadata: { full_name: 'Biz Owner', role: 'Business' },
    });

    mockSyncExternalUser.mockResolvedValueOnce({
      token: 'tok',
      user: { id: 2, role: 'Business', requiresBusinessSetup: true },
    });

    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
      body: {},
    });
    const res = makeRes();

    await syncUser(req, res);

    expect(mockSyncExternalUser).toHaveBeenCalledWith(
      'biz-sub',
      'biz@test.com',
      'Biz Owner',
      expect.objectContaining({ role: 'Business' }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ role: 'Business' }) }),
    );
  });

  it('should forward invite_token embedded in JWT user_metadata (OAuth flow)', async () => {
    // OAuth users cannot pass inviteToken through the body because the redirect
    // fires before page code runs. The token is stored in JWT metadata at sign-up time.
    const embeddedInviteToken = makeInviteToken(55);
    const token = makeToken({
      sub: 'oauth-sub',
      email: 'oauth@test.com',
      user_metadata: { name: 'OAuth User', invite_token: embeddedInviteToken },
    });

    mockSyncExternalUser.mockResolvedValueOnce({ token: 'tok', user: { id: 3 } });

    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
      body: {}, // no body inviteToken — comes from JWT metadata
    });
    const res = makeRes();

    await syncUser(req, res);

    expect(mockSyncExternalUser).toHaveBeenCalledWith(
      'oauth-sub',
      'oauth@test.com',
      'OAuth User',
      expect.objectContaining({ inviteToken: embeddedInviteToken }),
    );
  });

  it('should return 500 when syncExternalUser throws an unexpected error', async () => {
    const token = makeToken({ sub: 'sub-err', email: 'err@test.com' });
    mockSyncExternalUser.mockRejectedValueOnce(new Error('Unexpected DB failure'));

    const req = makeReq({ headers: { authorization: `Bearer ${token}` }, body: {} });
    const res = makeRes();

    await syncUser(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Server error' });
  });
});
