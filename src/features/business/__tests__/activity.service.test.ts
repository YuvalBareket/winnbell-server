/**
 * QA Tests — activity.service.ts (getBusinessActivity)
 *
 * Covers:
 *   receipts_today   — counts anchor receipt rows (receipt_identifier IS NOT NULL)
 *                      + non-receipt entries; does NOT double-count bonus rows
 *   receipts_this_month — same logic over the month window
 *   entries_today    — counts ALL ticket rows (including bonus multi-entry rows)
 *   entry_count on feed items — counts only non-quarantined tickets per submission
 *   quarantined tickets excluded from ALL summary counts
 *   SQL correctness — WHERE clauses verified via captured SQL strings
 *
 * Mock pattern: pool.query(sql, params) → { rows, rowCount }
 *
 * getBusinessActivity fires queries in this order for a business owner:
 *   1. bizRes   — SELECT id FROM business WHERE user_id = $1
 *   2. summaryRes — KPI aggregates for today
 *   3. monthlyRes — monthly aggregates + cap
 *   4. feedRes  — paginated activity feed
 */

// ── Mock DB before any imports ────────────────────────────────────────────────
const mockQuery = jest.fn();

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockQuery }),
}));

import { getBusinessActivity } from '../activity.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

type QueryResponse = { rows: unknown[]; rowCount?: number | null };

const setupPoolQueries = (...responses: QueryResponse[]) => {
  let i = 0;
  mockQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

/** Standard biz row: business owner with id=42 */
const BIZ_ROW = { rows: [{ id: 42 }] };

/** Build a summary row for pool query #2 (receipts_period / entries_period / revenue_period) */
const summaryRow = (opts: {
  receipts_period?: number;
  revenue_period?: number | string;
  entries_period?: number;
  /** @deprecated old field name — alias for receipts_period for backward compat in test helpers */
  receipts_today?: number;
  /** @deprecated old field name — alias for entries_period */
  entries_today?: number;
  /** @deprecated old field name — alias for revenue_period */
  revenue_today?: number | string;
}) => ({
  rows: [{
    receipts_period: opts.receipts_period ?? opts.receipts_today ?? 0,
    revenue_period: String(opts.revenue_period ?? opts.revenue_today ?? 0),
    entries_period: opts.entries_period ?? opts.entries_today ?? 0,
  }],
});

/** Build a cap row for pool query #3 (monthly_cap only — no longer returns monthly counts) */
const monthlyRow = (opts: {
  monthly_cap?: number | null;
  /** @deprecated receipts_this_month removed from service; kept for backward compat in call sites */
  receipts_this_month?: number;
  /** @deprecated entries_this_month removed from service */
  entries_this_month?: number;
}) => ({
  rows: [{
    monthly_cap: opts.monthly_cap ?? null,
  }],
});

/** Empty feed response */
const emptyFeed = (): QueryResponse => ({ rows: [] });

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. receipts_period — counts anchor + non-receipt, not bonus rows
// ─────────────────────────────────────────────────────────────────────────────
describe('receipts_period count', () => {
  it('should return receipts_period as reported by the summary query', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({ receipts_period: 5, entries_period: 8 }),
      monthlyRow({}),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.summary.receipts_period).toBe(5);
  });

  it('should return 0 receipts_period when there are no entries today', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({ receipts_period: 0, entries_period: 0 }),
      monthlyRow({}),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.summary.receipts_period).toBe(0);
  });

  it('summary SQL should filter receipts using receipt_identifier IS NOT NULL for receipt source', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({ receipts_today: 2 }),
      monthlyRow({}),
      emptyFeed(),
    );

    await getBusinessActivity(1, null);

    // Summary is query index 1 (after bizRes)
    const summarySql = mockQuery.mock.calls[1]?.[0] as string;
    expect(summarySql).toBeDefined();
    // The FILTER clause must distinguish non-receipt sources OR anchor receipt rows
    expect(summarySql).toMatch(/receipt_identifier IS NOT NULL/i);
    expect(summarySql).toMatch(/entry_source\s*!=\s*'receipt'/i);
  });

  it('summary SQL should use separate COUNT for entries_today (all rows)', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({ receipts_today: 2, entries_today: 5 }),
      monthlyRow({}),
      emptyFeed(),
    );

    await getBusinessActivity(1, null);

    const summarySql = mockQuery.mock.calls[1]?.[0] as string;
    // entries_today must be an unfiltered COUNT(*) — no extra FILTER on source
    expect(summarySql).toMatch(/entries_period/i);
    // Ensure there is at least one COUNT(*) that does NOT have the receipt filter
    // (i.e. a plain COUNT(*) AS entries_period)
    expect(summarySql).toMatch(/COUNT\(\*\)\s+AS\s+entries_period/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. entries_period — includes ALL ticket rows (anchor + bonus)
// ─────────────────────────────────────────────────────────────────────────────
describe('entries_period count', () => {
  it('should return entries_period as reported by the summary query', async () => {
    // 2 receipt submissions: first earns 3 entries, second earns 2 → entries=5, receipts=2
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({ receipts_period: 2, entries_period: 5 }),
      monthlyRow({}),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.summary.entries_period).toBe(5);
    // entries_period must be >= receipts_period (bonus rows can only add)
    expect(result.summary.entries_period).toBeGreaterThanOrEqual(result.summary.receipts_period);
  });

  it('entries_period can be larger than receipts_period due to bonus entries', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({ receipts_period: 3, entries_period: 10 }),
      monthlyRow({}),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.summary.entries_period).toBe(10);
    expect(result.summary.receipts_period).toBe(3);
    // The difference is the bonus entries (7 bonus tickets from 3 submissions)
    expect(result.summary.entries_period - result.summary.receipts_period).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. monthly_cap query (formerly receipts_this_month)
// NOTE: The service was refactored — monthly counts (receipts_this_month,
// entries_this_month) were consolidated into receipts_period / entries_period.
// The third query is now a cap query that only returns monthly_cap.
// ─────────────────────────────────────────────────────────────────────────────
describe('cap query (query index 2)', () => {
  it('should return the monthly_cap from the cap query', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({ monthly_cap: 42 }),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.summary.monthly_cap).toBe(42);
  });

  it('cap SQL should select monthly_cap using COALESCE of business and platform caps', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      emptyFeed(),
    );

    await getBusinessActivity(1, null);

    const capSql = mockQuery.mock.calls[2]?.[0] as string;
    expect(capSql).toBeDefined();
    expect(capSql).toMatch(/monthly_cap/i);
    expect(capSql).toMatch(/COALESCE/i);
  });

  it('summary SQL should filter receipts using receipt_identifier IS NOT NULL', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      emptyFeed(),
    );

    await getBusinessActivity(1, null);

    const summarySql = mockQuery.mock.calls[1]?.[0] as string;
    expect(summarySql).toBeDefined();
    expect(summarySql).toMatch(/receipt_identifier IS NOT NULL/i);
    expect(summarySql).toMatch(/entry_source\s*!=\s*'receipt'/i);
  });

  it('summary SQL should exclude quarantined rows', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      emptyFeed(),
    );

    await getBusinessActivity(1, null);

    const summarySql = mockQuery.mock.calls[1]?.[0] as string;
    expect(summarySql).toMatch(/is_quarantined\s*=\s*FALSE/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Quarantined tickets excluded from summary
// ─────────────────────────────────────────────────────────────────────────────
describe('quarantined tickets excluded from all summary counts', () => {
  it('summary SQL WHERE clause should include is_quarantined = FALSE', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      emptyFeed(),
    );

    await getBusinessActivity(1, null);

    const summarySql = mockQuery.mock.calls[1]?.[0] as string;
    expect(summarySql).toMatch(/is_quarantined\s*=\s*FALSE/i);
  });

  // NOTE: the FEED intentionally does NOT filter is_quarantined — under-review entries
  // are shown to the business (mapped to status 'under_review') so they can act on them.
  // Only the summary counts exclude quarantined.
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. monthly_cap returned correctly
// ─────────────────────────────────────────────────────────────────────────────
describe('monthly_cap handling', () => {
  it('should return monthly_cap as a number when set', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({ monthly_cap: 5000 }),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.summary.monthly_cap).toBe(5000);
  });

  it('should return monthly_cap as null when not set (unlimited)', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({ monthly_cap: null }),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.summary.monthly_cap).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Feed pagination — next_cursor and hasMore
// ─────────────────────────────────────────────────────────────────────────────
describe('feed pagination', () => {
  it('should set next_cursor to the last item ticket_id when there is a next page', async () => {
    // limit=2 but we fetch safeLimit+1=3 rows — means hasMore=true
    const makeRow = (id: number) => ({
      ticket_id: id,
      location_name: 'Loc',
      transaction_amount: null,
      receipt_identifier: null,
      entry_source: 'code',
      is_quarantined: false,
      quarantine_reason: null,
      created_at: new Date().toISOString(),
      entry_count: 1,
    });

    // Feed query returns 3 rows for limit=2 (safeLimit+1)
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      { rows: [makeRow(30), makeRow(20), makeRow(10)] }, // 3 rows > safeLimit 2
    );

    const result = await getBusinessActivity(1, null, undefined, 'today', undefined, 2);

    expect(result.items).toHaveLength(2);               // extra row popped
    expect(result.next_cursor).toBe(20);                // last remaining item id
  });

  it('should set next_cursor to null when all items fit on one page', async () => {
    const row = {
      ticket_id: 5,
      location_name: 'Loc',
      transaction_amount: null,
      receipt_identifier: null,
      entry_source: 'code',
      is_quarantined: false,
      quarantine_reason: null,
      created_at: new Date().toISOString(),
      entry_count: 1,
    };

    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      { rows: [row] }, // only 1 row for limit=25 → no next page
    );

    const result = await getBusinessActivity(1, null);

    expect(result.next_cursor).toBeNull();
  });

  it('should return empty items array with next_cursor null for empty feed', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.items).toHaveLength(0);
    expect(result.next_cursor).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Location manager scoping
// ─────────────────────────────────────────────────────────────────────────────
describe('location manager scoping (jwtLocationId)', () => {
  it('should scope to the manager location when jwtLocationId is provided', async () => {
    /**
     * When jwtLocationId is set the service fires:
     *   1. locRes  — SELECT business_id FROM business_location WHERE id = $1
     *   2. summaryRes
     *   3. monthlyRes
     *   4. feedRes
     */
    setupPoolQueries(
      { rows: [{ business_id: 42 }] }, // locRes
      summaryRow({ receipts_period: 3, entries_period: 5 }),
      monthlyRow({}),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, 7); // jwtLocationId = 7

    expect(result.summary.receipts_period).toBe(3);
    expect(result.summary.entries_period).toBe(5);
  });

  it('should throw "Location not found" when jwtLocationId resolves to no row', async () => {
    setupPoolQueries({ rows: [] }); // no location row

    await expect(getBusinessActivity(1, 99)).rejects.toThrow('Location not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Business not found
// ─────────────────────────────────────────────────────────────────────────────
describe('business owner not found', () => {
  it('should return empty activity when no business row exists for userId', async () => {
    // NOTE: the service was updated to return an empty result rather than throw
    // when a business owner has no business row yet (e.g., setup incomplete).
    setupPoolQueries({ rows: [] }); // no biz row

    const result = await getBusinessActivity(999, null);

    expect(result.items).toHaveLength(0);
    expect(result.next_cursor).toBeNull();
    expect(result.summary.receipts_period).toBe(0);
    expect(result.summary.entries_period).toBe(0);
    expect(result.summary.monthly_cap).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. receipt_identifier masking in feed items
// ─────────────────────────────────────────────────────────────────────────────
describe('receipt_identifier masking', () => {
  it('should mask receipt_identifier in feed items (not expose raw value)', async () => {
    const feedRow = {
      ticket_id: 20,
      location_name: 'Shop C',
      transaction_amount: '100.00',
      receipt_identifier: 'INVOICE-123456',
      entry_source: 'receipt',
      is_quarantined: false,
      quarantine_reason: null,
      created_at: new Date().toISOString(),
      entry_count: 1,
    };

    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      { rows: [feedRow] },
    );

    const result = await getBusinessActivity(1, null);

    const maskedId = result.items[0].receipt_identifier_masked;
    // Must not equal the raw value
    expect(maskedId).not.toBe('INVOICE-123456');
    // Must be a truthy masked string
    expect(maskedId).toBeTruthy();
    // Standard mask: starts with first 3 chars + "..." + last 4 chars
    expect(maskedId).toMatch(/^INV\.\.\.3456$/);
  });

  it('should return null receipt_identifier_masked when receipt_identifier is null', async () => {
    const feedRow = {
      ticket_id: 21,
      location_name: 'Shop D',
      transaction_amount: null,
      receipt_identifier: null,
      entry_source: 'code',
      is_quarantined: false,
      quarantine_reason: null,
      created_at: new Date().toISOString(),
      entry_count: 1,
    };

    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      { rows: [feedRow] },
    );

    const result = await getBusinessActivity(1, null);

    expect(result.items[0].receipt_identifier_masked).toBeNull();
  });
});
