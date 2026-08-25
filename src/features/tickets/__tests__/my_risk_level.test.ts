/**
 * QA Tests — getMyRiskLevel (tickets.controller.ts)
 *
 * Covers:
 *   welcomeBonusPending — the invited-signup welcome-entry prompt flag:
 *     - true passes through when the EXISTS finds an unrewarded referral/flyer acquisition
 *     - false for direct signups / already-rewarded users
 *     - the SQL predicate mirrors grantPendingReferralBonus eligibility EXACTLY
 *       (referral_rewarded_at IS NULL + referred_by) - a drift here silently kills the
 *       welcome prompt for every referred signup. Location flyer/QR signups no longer
 *       earn a welcome entry, so the flyer branch must NOT be in the predicate.
 *   response mapping — requiresImage (score > 9), isThrottled (score >= 20 + daily >= 1)
 *
 * Mock pattern: pool.query(sql, params) → { rows, rowCount }
 */

// ── Mock DB before any imports ────────────────────────────────────────────────
const mockQuery = jest.fn();

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockQuery }),
}));

import { getMyRiskLevel } from '../tickets.controller';
import type { Response } from 'express';
import type { AuthRequest } from '../../../shared/middleware/auth.middleware';

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  risk_score: 0,
  is_phone_verified: false,
  daily_count: 0,
  draw_entry_count: 0,
  welcome_bonus_pending: false,
  ...overrides,
});

const run = async (row: Record<string, unknown>) => {
  mockQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
  const req = { user: { id: 42 } } as AuthRequest;
  const json = jest.fn();
  const res = { json, status: jest.fn().mockReturnValue({ json }) } as unknown as Response;
  await getMyRiskLevel(req, res);
  return json.mock.calls[0][0];
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('getMyRiskLevel welcomeBonusPending', () => {
  test('true when the acquisition row has an unclaimed welcome bonus', async () => {
    const body = await run(makeRow({ welcome_bonus_pending: true }));
    expect(body.welcomeBonusPending).toBe(true);
  });

  test('false for direct signups / rewarded users, and defaults false on a missing column', async () => {
    expect((await run(makeRow({ welcome_bonus_pending: false }))).welcomeBonusPending).toBe(false);
    const { welcome_bonus_pending: _dropped, ...withoutColumn } = makeRow();
    expect((await run(withoutColumn)).welcomeBonusPending).toBe(false);
  });

  test('SQL predicate mirrors grantPendingReferralBonus eligibility', async () => {
    await run(makeRow());
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([42]);
    // The grant-eligibility conditions - if either disappears from the query, the client
    // prompt and the server grant no longer agree.
    expect(sql).toContain('referral_rewarded_at IS NULL');
    expect(sql).toContain('referred_by_user_id IS NOT NULL');
    // Location flyer/QR signups no longer earn a welcome entry, so the flyer branch is gone.
    expect(sql).not.toMatch(/source\s*=\s*'location_flyer'/);
  });
});

describe('getMyRiskLevel response mapping', () => {
  test('requiresImage only above score 9; throttled needs score >= 20 AND a submission today', async () => {
    const low = await run(makeRow({ risk_score: 9 }));
    expect(low.requiresImage).toBe(false);
    expect(low.isThrottled).toBe(false);

    const high = await run(makeRow({ risk_score: 20, daily_count: 1, is_phone_verified: true }));
    expect(high.requiresImage).toBe(true);
    expect(high.isThrottled).toBe(true);
    expect(high.isPhoneVerified).toBe(true);

    const highButQuiet = await run(makeRow({ risk_score: 25, daily_count: 0 }));
    expect(highButQuiet.isThrottled).toBe(false);
  });
});
