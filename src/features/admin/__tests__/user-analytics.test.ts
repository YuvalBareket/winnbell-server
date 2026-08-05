/**
 * Tests — user triage analytics (admin)
 *
 * Covers:
 *  - getUserAnalyticsSummaryService: all nine numeric fields returned + zeros on empty row
 *  - getUserAnalytics controller: 200 shape + 500 on DB error
 *  - getAllUsersService segment whitelist: junk segment is silently ignored (no clause injected)
 *  - getAllUsersService: each valid segment adds the correct predicate to the SQL
 *  - getAllUsersService: segment + riskLevel compose cleanly (both AND-ed)
 *  - getAllUsersService: risk segments use risk_score DESC order; others use created_at DESC
 *  - SQL safety: USER_SEGMENT_PREDICATES strings never expose raw user input
 *
 * Mock pattern: pool.query(sql, params) -> { rows, rowCount }
 * No real DB is touched.
 */

// ── DB mock (must be declared before any imports) ─────────────────────────────
const mockQuery = jest.fn();

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockQuery }),
}));

// ── Cache stubs (imported transitively by admin.service) ──────────────────────
jest.mock('../../../shared/cache/cache.js', () => ({
  getPlatformSettings: jest.fn().mockResolvedValue({}),
  invalidatePlatformSettings: jest.fn(),
  invalidatePublicBusinessData: jest.fn(),
  invalidateUserAuth: jest.fn(),
}));

// ── Email stub ────────────────────────────────────────────────────────────────
jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
  sendFoundingFinalCampaignEmail: jest.fn(),
}));

// ── Risk service stub ─────────────────────────────────────────────────────────
jest.mock('../../risk/risk.service.js', () => ({
  decayAllUserRiskScores: jest.fn().mockResolvedValue({ unquarantinedUserIds: [] }),
  updateUserRiskScore: jest.fn().mockResolvedValue(undefined),
  syncUserQuarantineState: jest.fn().mockResolvedValue(undefined),
}));

// ── Ticket service stub ───────────────────────────────────────────────────────
jest.mock('../../tickets/tickets.service.js', () => ({
  generateGlobalUniqueCode: jest.fn().mockResolvedValue('TESTCODE'),
}));

// ── Notifications service stub ────────────────────────────────────────────────
jest.mock('../../notifications/notifications.service.js', () => ({
  sendToAudience: jest.fn().mockResolvedValue(0),
  logNotification: jest.fn().mockResolvedValue(undefined),
  getNotificationHistory: jest.fn().mockResolvedValue([]),
}));

// ── Growth service stub ───────────────────────────────────────────────────────
jest.mock('../growth.service.js', () => ({
  getGrowthAnalyticsService: jest.fn().mockResolvedValue({}),
}));

import {
  getUserAnalyticsSummaryService,
  getAllUsersService,
} from '../admin.service';
import { getUserAnalytics } from '../admin.controller';

// ── Minimal request / response fakes ─────────────────────────────────────────
function makeReq(
  query: Record<string, string> = {},
  params: Record<string, string> = {},
): ReturnType<typeof Object.create> {
  return { query, params };
}

function makeRes() {
  const res = {
    _status: 200,
    _body: undefined as unknown,
    status(code: number) { this._status = code; return this; },
    json(body: unknown) { this._body = body; return this; },
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ─────────────────────────────────────────────
// getUserAnalyticsSummaryService — shape
// ─────────────────────────────────────────────
describe('getUserAnalyticsSummaryService — response shape', () => {
  test('returns all ten numeric fields when the DB returns a row', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        total:       100,
        users:        75,
        businesses:   20,
        managers:      5,
        high_risk:     5,
        medium_risk:   8,
        suspended:     2,
        unverified:   12,
        new_7d:       15,
        active_30d:   40,
      }],
    });

    const result = await getUserAnalyticsSummaryService();

    expect(result).toEqual({
      total:       100,
      users:        75,
      businesses:   20,
      managers:      5,
      high_risk:     5,
      medium_risk:   8,
      suspended:     2,
      unverified:   12,
      new_7d:       15,
      active_30d:   40,
    });
  });

  test('returns zeros for all fields when no users exist (empty row)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{}] });

    const result = await getUserAnalyticsSummaryService();

    expect(result.total).toBe(0);
    expect(result.users).toBe(0);
    expect(result.businesses).toBe(0);
    expect(result.managers).toBe(0);
    expect(result.high_risk).toBe(0);
    expect(result.medium_risk).toBe(0);
    expect(result.suspended).toBe(0);
    expect(result.unverified).toBe(0);
    expect(result.new_7d).toBe(0);
    expect(result.active_30d).toBe(0);
  });

  test('SQL excludes Admins (role != Admin baseline)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await getUserAnalyticsSummaryService();

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/u\.role != 'Admin'/);
  });

  test('SQL uses COUNT...FILTER for all segment counts (single query, no subqueries per segment)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await getUserAnalyticsSummaryService();

    const [sql] = mockQuery.mock.calls[0] as [string];
    // All nine aggregates must appear in one SELECT
    expect(sql).toMatch(/COUNT\(\*\).*AS total/s);
    expect(sql).toMatch(/COUNT\(\*\).*AS users/s);
    expect(sql).toMatch(/COUNT\(\*\).*AS businesses/s);
    expect(sql).toMatch(/COUNT\(\*\).*AS high_risk/s);
    expect(sql).toMatch(/COUNT\(\*\).*AS medium_risk/s);
    expect(sql).toMatch(/COUNT\(\*\).*AS suspended/s);
    expect(sql).toMatch(/COUNT\(\*\).*AS unverified/s);
    expect(sql).toMatch(/COUNT\(\*\).*AS new_7d/s);
    expect(sql).toMatch(/COUNT\(\*\).*AS active_30d/s);
    // Single DB round-trip — mockQuery called exactly once
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('unverified segment targets User role only (Business exempt)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await getUserAnalyticsSummaryService();

    const [sql] = mockQuery.mock.calls[0] as [string];
    // The unverified FILTER must scope to role='User'
    expect(sql).toMatch(/role = 'User' AND u\.is_phone_verified = FALSE/);
  });
});

// ─────────────────────────────────────────────
// getUserAnalytics controller — 200 / 500
// ─────────────────────────────────────────────
describe('getUserAnalytics controller', () => {
  test('returns 200 with all nine fields on success', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        total: 50, users: 40, businesses: 10,
        high_risk: 3, medium_risk: 5, suspended: 1,
        unverified: 7, new_7d: 9, active_30d: 20,
      }],
    });

    const res = makeRes();
    await getUserAnalytics(makeReq() as never, res as never);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, number>;
    expect(typeof body.total).toBe('number');
    expect(typeof body.users).toBe('number');
    expect(typeof body.businesses).toBe('number');
    expect(typeof body.high_risk).toBe('number');
    expect(typeof body.medium_risk).toBe('number');
    expect(typeof body.suspended).toBe('number');
    expect(typeof body.unverified).toBe('number');
    expect(typeof body.new_7d).toBe('number');
    expect(typeof body.active_30d).toBe('number');
  });

  test('returns 500 when the DB throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB failure'));

    const res = makeRes();
    await getUserAnalytics(makeReq() as never, res as never);

    expect(res._status).toBe(500);
    const body = res._body as { message: string };
    expect(body.message).toBe('Failed to fetch user analytics summary');
  });
});

// ─────────────────────────────────────────────
// getAllUsersService — segment whitelist
// ─────────────────────────────────────────────
describe('getAllUsersService — segment whitelist', () => {
  const setupTwoQueries = (rows: unknown[] = [], total = rows.length) => {
    mockQuery
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ count: String(total) }] });
  };

  test('junk segment is silently ignored — no segment clause injected into SQL', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'INVALID_SEGMENT_XYZ' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).not.toContain('INVALID_SEGMENT_XYZ');
  });

  test('empty string segment is silently ignored — no segment-specific predicate injected', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: '' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    // No segment-specific predicates should appear
    expect(sql).not.toMatch(/risk_score >= 20/);
    expect(sql).not.toMatch(/is_active = FALSE/);
    expect(sql).not.toMatch(/is_phone_verified/);
    expect(sql).not.toMatch(/INTERVAL '7 days'/);
    expect(sql).not.toMatch(/INTERVAL '30 days'/);
  });

  test('undefined segment produces no segment clause', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: undefined });

    const [sql] = mockQuery.mock.calls[0] as [string];
    // Baseline: role != Admin only — no segment-specific text
    expect(sql).not.toMatch(/risk_score >= 20/);
    expect(sql).not.toMatch(/is_active = FALSE/);
    expect(sql).not.toMatch(/INTERVAL '7 days'/);
  });
});

// ─────────────────────────────────────────────
// getAllUsersService — each valid segment
// ─────────────────────────────────────────────
describe('getAllUsersService — valid segment predicates', () => {
  const setupTwoQueries = (rows: unknown[] = [], total = rows.length) => {
    mockQuery
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ count: String(total) }] });
  };

  test('segment=high_risk: SQL contains risk_score >= 20', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'high_risk' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/u\.risk_score >= 20/);
  });

  test('segment=medium_risk: SQL contains risk_score >= 10 AND risk_score < 20', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'medium_risk' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/u\.risk_score >= 10 AND u\.risk_score < 20/);
  });

  test('segment=suspended: SQL contains is_active = FALSE', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'suspended' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/u\.is_active = FALSE/);
  });

  test('segment=unverified: SQL scopes to User role + is_phone_verified = FALSE', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'unverified' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/u\.role = 'User' AND u\.is_phone_verified = FALSE/);
  });

  test('segment=new_7d: SQL contains INTERVAL \'7 days\'', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'new_7d' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/u\.created_at >= NOW\(\) - INTERVAL '7 days'/);
  });

  test('segment=active_30d: SQL contains EXISTS subquery with activated_at INTERVAL 30 days', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'active_30d' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/EXISTS[\s\S]*activated_at >= NOW\(\) - INTERVAL '30 days'/);
    // Cap rule: both filters required
    expect(sql).toMatch(/is_quarantined = FALSE/);
  });
});

// ─────────────────────────────────────────────
// getAllUsersService — ORDER BY per segment
// ─────────────────────────────────────────────
describe('getAllUsersService — segment-aware ordering', () => {
  const setupTwoQueries = (rows: unknown[] = [], total = rows.length) => {
    mockQuery
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ count: String(total) }] });
  };

  test('segment=high_risk: ORDER BY risk_score DESC, created_at DESC', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'high_risk' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/ORDER BY u\.risk_score DESC, u\.created_at DESC/);
  });

  test('segment=medium_risk: ORDER BY risk_score DESC, created_at DESC', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'medium_risk' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/ORDER BY u\.risk_score DESC, u\.created_at DESC/);
  });

  test('segment=suspended: ORDER BY created_at DESC', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'suspended' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/ORDER BY u\.created_at DESC/);
    expect(sql).not.toMatch(/ORDER BY u\.risk_score/);
  });

  test('segment=new_7d: ORDER BY created_at DESC', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'new_7d' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/ORDER BY u\.created_at DESC/);
    expect(sql).not.toMatch(/ORDER BY u\.risk_score/);
  });

  test('no segment: ORDER BY created_at DESC (preserves existing default)', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25 });

    const [sql] = mockQuery.mock.calls[0] as [string];
    // Default ordering falls through to the non-risk branch
    expect(sql).toMatch(/ORDER BY u\.created_at DESC/);
  });
});

// ─────────────────────────────────────────────
// getAllUsersService — segment + riskLevel compose
// ─────────────────────────────────────────────
describe('getAllUsersService — segment composes with other filters', () => {
  const setupTwoQueries = (rows: unknown[] = [], total = rows.length) => {
    mockQuery
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ count: String(total) }] });
  };

  test('segment=suspended + riskLevel=high: both predicates AND-ed in WHERE', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'suspended', riskLevel: 'high' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/u\.is_active = FALSE/);
    expect(sql).toMatch(/u\.risk_score >= 20/);
  });

  test('segment=new_7d + search: search value is a bound param, segment is literal SQL', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'new_7d', search: 'alice' });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain('%alice%');
    expect(sql).toMatch(/u\.created_at >= NOW\(\) - INTERVAL '7 days'/);
  });

  test('segment=unverified + role=User: role filter AND segment filter both applied', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, segment: 'unverified', role: 'User' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    // role filter ($n parameterized) AND segment literal both present
    expect(sql).toMatch(/u\.role = \$\d/);
    expect(sql).toMatch(/u\.role = 'User' AND u\.is_phone_verified = FALSE/);
  });

  test('role=manager maps to Business-role accounts WITHOUT an owned business (Manager enum unused)', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, role: 'manager' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/u\.role = 'Manager' OR \(u\.role = 'Business' AND NOT EXISTS/);
  });

  test('role=business scopes to business OWNERS only (managers excluded)', async () => {
    setupTwoQueries([]);

    await getAllUsersService({ page: 1, limit: 25, role: 'business' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/u\.role = 'Business' AND EXISTS \(SELECT 1 FROM business b2/);
  });
});

// ─────────────────────────────────────────────
// SQL safety — predicates use literals, not user input
// ─────────────────────────────────────────────
describe('SQL safety — segment predicates are literals, not user interpolation', () => {
  const setupTwoQueries = () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });
  };

  test('a malicious segment string is not interpolated into SQL', async () => {
    setupTwoQueries();

    await getAllUsersService({ page: 1, limit: 25, segment: "'; DROP TABLE \"user\";--" });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).not.toContain('DROP TABLE');
  });

  test('search user input lands in params array, not SQL text', async () => {
    setupTwoQueries();

    await getAllUsersService({ page: 1, limit: 25, search: "'; DROP TABLE \"user\";--" });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('DROP TABLE');
    expect(params.some(p => typeof p === 'string' && p.includes('DROP TABLE'))).toBe(true);
  });
});
