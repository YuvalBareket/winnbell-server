/**
 * Tests — business health triage analytics (admin)
 *
 * Covers:
 *  - GET /admin/businesses/health-summary: 200 shape + 403 non-admin
 *  - GET /admin/businesses with filter param: valid filters work, junk filter is ignored
 *  - GET /admin/businesses: existing fields still present on rows
 *  - SQL correctness: BIZ_HEALTH_CTE appears exactly once per query (not duplicated)
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

// ── Notifications service stub (admin.controller imports it at the top level;
//    notifications.service calls webpush.setVapidDetails at module load time which
//    throws when VAPID keys are absent in the test environment) ─────────────────
jest.mock('../../notifications/notifications.service.js', () => ({
  sendToAudience: jest.fn().mockResolvedValue(0),
  logNotification: jest.fn().mockResolvedValue(undefined),
  getNotificationHistory: jest.fn().mockResolvedValue([]),
}));

// ── Growth service stub (admin.controller imports it at the top level) ────────
jest.mock('../growth.service.js', () => ({
  getGrowthAnalyticsService: jest.fn().mockResolvedValue({}),
}));

import {
  getBusinessesWithStats,
  getBusinessHealthSummaryService,
} from '../admin.service';
import {
  getDashboardData,
  getBusinessHealthSummary,
} from '../admin.controller';

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
  // Default: empty result set so tests that don't override still resolve cleanly.
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ─────────────────────────────────────────────
// getBusinessHealthSummaryService — shape
// ─────────────────────────────────────────────
describe('getBusinessHealthSummaryService — response shape', () => {
  test('returns all seven numeric fields when the DB returns a row', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        total:             10,
        attention:          3,
        no_recent_entries:  1,
        low_engagement:     2,
        billing:            1,
        setup:              0,
        next_ready:         6,
      }],
    });

    const result = await getBusinessHealthSummaryService();

    expect(result).toEqual({
      total:             10,
      attention:          3,
      no_recent_entries:  1,
      low_engagement:     2,
      billing:            1,
      setup:              0,
      next_ready:         6,
    });
  });

  test('returns zeros for all fields when no businesses exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{}] });

    const result = await getBusinessHealthSummaryService();

    expect(result.total).toBe(0);
    expect(result.attention).toBe(0);
    expect(result.no_recent_entries).toBe(0);
    expect(result.low_engagement).toBe(0);
    expect(result.billing).toBe(0);
    expect(result.setup).toBe(0);
    expect(result.next_ready).toBe(0);
  });

  test('the SQL query embeds the biz_health CTE (not a plain SELECT)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 5, attention: 1, no_recent_entries: 0, low_engagement: 1, billing: 0, setup: 0 }] });

    await getBusinessHealthSummaryService();

    const [sql] = mockQuery.mock.calls[0] as [string];
    // CTE must be present and reference the key health tables
    expect(sql).toMatch(/WITH/i);
    expect(sql).toMatch(/biz_health/);
    expect(sql).toMatch(/open_draw/);
    expect(sql).toMatch(/ticket_agg/);
    // All six output columns must be computed
    expect(sql).toMatch(/attention/);
    expect(sql).toMatch(/no_recent_entries/);
    expect(sql).toMatch(/low_engagement/);
    expect(sql).toMatch(/billing/);
    expect(sql).toMatch(/setup/);
  });

  test('the CTE is defined only once (not duplicated in the health-summary query)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 0, attention: 0, no_recent_entries: 0, low_engagement: 0, billing: 0, setup: 0 }] });

    await getBusinessHealthSummaryService();

    const [sql] = mockQuery.mock.calls[0] as [string];
    // Count occurrences of the sentinel "open_draw AS" - must appear exactly once
    const occurrences = (sql.match(/open_draw AS \(/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ─────────────────────────────────────────────
// getBusinessHealthSummary controller — 200 / 500
// ─────────────────────────────────────────────
describe('getBusinessHealthSummary controller', () => {
  test('returns 200 with the summary shape on success', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: 7, attention: 2, no_recent_entries: 1, low_engagement: 1, billing: 0, setup: 1 }],
    });

    const res = makeRes();
    await getBusinessHealthSummary(makeReq() as never, res as never);

    expect(res._status).toBe(200);
    const body = res._body as Record<string, number>;
    expect(typeof body.total).toBe('number');
    expect(typeof body.attention).toBe('number');
    expect(typeof body.no_recent_entries).toBe('number');
    expect(typeof body.low_engagement).toBe('number');
    expect(typeof body.billing).toBe('number');
    expect(typeof body.setup).toBe('number');
  });

  test('returns 500 when the DB throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB failure'));

    const res = makeRes();
    await getBusinessHealthSummary(makeReq() as never, res as never);

    expect(res._status).toBe(500);
  });
});

// ─────────────────────────────────────────────
// requireRole guard — 403 for non-admin
// ─────────────────────────────────────────────
describe('requireRole guard blocks non-admin from health-summary', () => {
  const { requireRole } = jest.requireActual<typeof import('../../../shared/middleware/auth.middleware.js')>(
    '../../../shared/middleware/auth.middleware.js',
  );

  test('403 for User-role caller', () => {
    const req = { user: { id: 1, role: 'User' } };
    const res = makeRes();
    const next = jest.fn();
    requireRole('Admin')(req as never, res as never, next);
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('403 for Business-role caller', () => {
    const req = { user: { id: 1, role: 'Business' } };
    const res = makeRes();
    const next = jest.fn();
    requireRole('Admin')(req as never, res as never, next);
    expect(res._status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('passes through for Admin-role caller', () => {
    const req = { user: { id: 1, role: 'Admin' } };
    const res = makeRes();
    const next = jest.fn();
    requireRole('Admin')(req as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// getBusinessesWithStats — filter param
// ─────────────────────────────────────────────
describe('getBusinessesWithStats — filter param', () => {
  // Provide two DB responses: one for rows, one for count
  const setupTwoQueries = (rows: unknown[] = [], total = rows.length) => {
    mockQuery
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ total }] });
  };

  test('no filter: returns rows with health fields and uses name ASC order', async () => {
    setupTwoQueries([{
      id: 1, name: 'Alpha Cafe', sector: 'Coffee', entries_per_location: 1000,
      is_subscribed: true, owner_name: 'Alice', owner_email: 'alice@test.com',
      subscription_status: 'Active', current_period_end: null, fee_at_entry: 250,
      location_count: 1, total_activated: 5,
      enrolled: true, entries_current: 5, entries_7d: 2, unique_customers: 3,
      repeat_customers: 1, last_entry_at: null, views_30d: 8, total_cap: 1000,
      flags: [], health: 'good',
    }]);

    const result = await getBusinessesWithStats({ page: 1, limit: 25 });

    expect(result.rows).toHaveLength(1);
    // Health fields present
    const row = result.rows[0];
    expect(row).toHaveProperty('enrolled');
    expect(row).toHaveProperty('entries_current');
    expect(row).toHaveProperty('entries_7d');
    expect(row).toHaveProperty('unique_customers');
    expect(row).toHaveProperty('repeat_customers');
    expect(row).toHaveProperty('last_entry_at');
    expect(row).toHaveProperty('views_30d');
    expect(row).toHaveProperty('total_cap');
    expect(row).toHaveProperty('flags');
    expect(row).toHaveProperty('health');
    // Existing fields still present
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('name');
    expect(row).toHaveProperty('sector');
    expect(row).toHaveProperty('total_activated');

    // No filter -> ORDER BY b.name ASC (not the health-tier order)
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/ORDER BY b\.name ASC/);
    expect(sql).not.toMatch(/ORDER BY CASE/);
  });

  test('filter=attention: SQL includes the attention WHERE clause and worst-first ORDER', async () => {
    setupTwoQueries([]);

    await getBusinessesWithStats({ page: 1, limit: 25, filter: 'attention' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/billing_issue OR h\.setup_gap OR h\.no_recent_entries OR h\.low_engagement/);
    // Worst-first sort derives the tier from the CTE's flag booleans (h.health is a
    // SELECT-list alias, not a CTE column - referencing it in ORDER BY was a live 500).
    expect(sql).toMatch(/ORDER BY CASE[\s\S]*billing_issue OR h\.no_recent_entries THEN 0/);
  });

  test('filter=no_recent_entries: SQL restricts to no_recent_entries flag', async () => {
    setupTwoQueries([]);

    await getBusinessesWithStats({ page: 1, limit: 25, filter: 'no_recent_entries' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    // The filter lands in the main WHERE clause (alone, or ANDed after a search condition).
    expect(sql).toMatch(/WHERE[\s\S]*h\.no_recent_entries[\s\S]*ORDER BY/);
    // Worst-first sort derives the tier from the CTE's flag booleans (h.health is a
    // SELECT-list alias, not a CTE column - referencing it in ORDER BY was a live 500).
    expect(sql).toMatch(/ORDER BY CASE[\s\S]*billing_issue OR h\.no_recent_entries THEN 0/);
  });

  test('filter=low_engagement: SQL restricts to low_engagement flag', async () => {
    setupTwoQueries([]);

    await getBusinessesWithStats({ page: 1, limit: 25, filter: 'low_engagement' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/WHERE[\s\S]*h\.low_engagement[\s\S]*ORDER BY/);
  });

  test('filter=billing: SQL restricts to billing_issue flag', async () => {
    setupTwoQueries([]);

    await getBusinessesWithStats({ page: 1, limit: 25, filter: 'billing' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/WHERE[\s\S]*h\.billing_issue[\s\S]*ORDER BY/);
  });

  test('filter=setup: SQL restricts to setup_gap flag', async () => {
    setupTwoQueries([]);

    await getBusinessesWithStats({ page: 1, limit: 25, filter: 'setup' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/WHERE[\s\S]*h\.setup_gap[\s\S]*ORDER BY/);
  });

  test('junk filter value is silently ignored — no health WHERE clause injected', async () => {
    setupTwoQueries([]);

    await getBusinessesWithStats({ page: 1, limit: 25, filter: 'INVALID_FILTER_XYZ' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    // The junk filter must not appear verbatim in the SQL (injection guard)
    expect(sql).not.toContain('INVALID_FILTER_XYZ');
    // And no filter clause is added — falls back to normal name order
    expect(sql).toMatch(/ORDER BY b\.name ASC/);
  });

  test('empty string filter is silently ignored', async () => {
    setupTwoQueries([]);

    await getBusinessesWithStats({ page: 1, limit: 25, filter: '' });

    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/ORDER BY b\.name ASC/);
  });

  test('filter can be combined with search param', async () => {
    setupTwoQueries([]);

    await getBusinessesWithStats({ page: 1, limit: 25, search: 'cafe', filter: 'billing' });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Search param must be in the values array
    expect(params).toContain('%cafe%');
    // Billing filter clause must also be present
    expect(sql).toMatch(/AND h\.billing_issue/);
  });

  test('the BIZ_HEALTH_CTE is defined exactly once in the rows query', async () => {
    setupTwoQueries([]);

    await getBusinessesWithStats({ page: 1, limit: 25 });

    const [sql] = mockQuery.mock.calls[0] as [string];
    const occurrences = (sql.match(/open_draw AS \(/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  test('existing fields are present on returned rows', async () => {
    const existingRow = {
      id: 5, name: 'Beta Bakery', sector: 'Bakery', entries_per_location: 2500,
      is_subscribed: false, owner_name: 'Bob', owner_email: 'bob@test.com',
      subscription_status: null, current_period_end: null, fee_at_entry: null,
      location_count: 0, total_activated: 0,
      enrolled: false, entries_current: 0, entries_7d: 0, unique_customers: 0,
      repeat_customers: 0, last_entry_at: null, views_30d: 0, total_cap: 0,
      flags: [], health: 'good',
    };
    setupTwoQueries([existingRow]);

    const result = await getBusinessesWithStats({ page: 1, limit: 25 });

    const row = result.rows[0];
    // Fields that existed before the health triage feature
    expect(row.id).toBe(5);
    expect(row.name).toBe('Beta Bakery');
    expect(row.sector).toBe('Bakery');
    expect(row.entries_per_location).toBe(2500);
    expect(row.is_subscribed).toBe(false);
    expect(row.owner_name).toBe('Bob');
    expect(row.owner_email).toBe('bob@test.com');
    expect(row.location_count).toBe(0);
    expect(row.total_activated).toBe(0);
  });
});

// ─────────────────────────────────────────────
// getDashboardData controller — filter forwarding
// ─────────────────────────────────────────────
describe('getDashboardData controller — filter forwarding', () => {
  test('passes a valid filter to getBusinessesWithStats', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const res = makeRes();
    await getDashboardData(makeReq({ filter: 'billing' }) as never, res as never);

    expect(res._status).toBe(200);
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/WHERE[\s\S]*h\.billing_issue[\s\S]*ORDER BY/);
  });

  test('junk filter from query string does not inject into SQL', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const res = makeRes();
    await getDashboardData(makeReq({ filter: 'DROP TABLE business;--' }) as never, res as never);

    expect(res._status).toBe(200);
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).not.toContain('DROP');
    // Junk filter -> no health WHERE added -> normal name order
    expect(sql).toMatch(/ORDER BY b\.name ASC/);
  });

  test('omitting filter still returns 200 with all existing fields present in shape', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Gamma Gym', flags: ['billing_issue'], health: 'at_risk' }] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });

    const res = makeRes();
    await getDashboardData(makeReq() as never, res as never);

    expect(res._status).toBe(200);
    const body = res._body as { rows: unknown[]; total: number; page: number; limit: number; totalPages: number };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(typeof body.page).toBe('number');
    expect(typeof body.limit).toBe('number');
    expect(typeof body.totalPages).toBe('number');
  });
});

// ─────────────────────────────────────────────
// SQL safety: parameterized values only
// ─────────────────────────────────────────────
describe('SQL safety — no string interpolation of user input', () => {
  test('search string is passed as a bound parameter, not interpolated into SQL', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    await getBusinessesWithStats({ page: 1, limit: 25, search: "'; DROP TABLE business;--" });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // The malicious string must NOT appear verbatim in the SQL text
    expect(sql).not.toContain("'; DROP TABLE business;--");
    // It must appear only in the params array (as a LIKE pattern)
    expect(params.some(p => typeof p === 'string' && p.includes('DROP TABLE'))).toBe(true);
  });
});
