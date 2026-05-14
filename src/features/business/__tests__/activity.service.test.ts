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

/** Build a summary row for pool query #2 */
const summaryRow = (opts: {
  receipts_today?: number;
  revenue_today?: number | string;
  entries_today?: number;
}) => ({
  rows: [{
    receipts_today: opts.receipts_today ?? 0,
    revenue_today: String(opts.revenue_today ?? 0),
    entries_today: opts.entries_today ?? 0,
  }],
});

/** Build a monthly row for pool query #3 */
const monthlyRow = (opts: {
  entries_this_month?: number;
  receipts_this_month?: number;
  monthly_cap?: number | null;
}) => ({
  rows: [{
    entries_this_month: opts.entries_this_month ?? 0,
    receipts_this_month: opts.receipts_this_month ?? 0,
    monthly_cap: opts.monthly_cap ?? null,
  }],
});

/** Empty feed response */
const emptyFeed = (): QueryResponse => ({ rows: [] });

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. receipts_today — counts anchor + non-receipt, not bonus rows
// ─────────────────────────────────────────────────────────────────────────────
describe('receipts_today count', () => {
  it('should return receipts_today as reported by the summary query', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({ receipts_today: 5, entries_today: 8 }),
      monthlyRow({}),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.summary.receipts_today).toBe(5);
  });

  it('should return 0 receipts_today when there are no entries today', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({ receipts_today: 0, entries_today: 0 }),
      monthlyRow({}),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.summary.receipts_today).toBe(0);
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
    expect(summarySql).toMatch(/entries_today/i);
    // Ensure there is at least one COUNT(*) that does NOT have the receipt filter
    // (i.e. a plain COUNT(*) AS entries_today)
    expect(summarySql).toMatch(/COUNT\(\*\)\s+AS\s+entries_today/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. entries_today — includes ALL ticket rows (anchor + bonus)
// ─────────────────────────────────────────────────────────────────────────────
describe('entries_today count', () => {
  it('should return entries_today as reported by the summary query', async () => {
    // 2 receipt submissions: first earns 3 entries, second earns 2 → entries=5, receipts=2
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({ receipts_today: 2, entries_today: 5 }),
      monthlyRow({}),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.summary.entries_today).toBe(5);
    // entries_today must be >= receipts_today (bonus rows can only add)
    expect(result.summary.entries_today).toBeGreaterThanOrEqual(result.summary.receipts_today);
  });

  it('entries_today can be larger than receipts_today due to bonus entries', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({ receipts_today: 3, entries_today: 10 }),
      monthlyRow({}),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.summary.entries_today).toBe(10);
    expect(result.summary.receipts_today).toBe(3);
    // The difference is the bonus entries (7 bonus tickets from 3 submissions)
    expect(result.summary.entries_today - result.summary.receipts_today).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. receipts_this_month — same logic as today but over the month
// ─────────────────────────────────────────────────────────────────────────────
describe('receipts_this_month count', () => {
  it('should return receipts_this_month from the monthly query', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({ receipts_this_month: 42, entries_this_month: 80 }),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, null);

    expect(result.summary.receipts_this_month).toBe(42);
  });

  it('monthly SQL should filter receipts using receipt_identifier IS NOT NULL', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({ receipts_this_month: 10 }),
      emptyFeed(),
    );

    await getBusinessActivity(1, null);

    const monthlySql = mockQuery.mock.calls[2]?.[0] as string;
    expect(monthlySql).toBeDefined();
    expect(monthlySql).toMatch(/receipt_identifier IS NOT NULL/i);
    expect(monthlySql).toMatch(/entry_source\s*!=\s*'receipt'/i);
  });

  it('monthly SQL should exclude quarantined rows from receipts_this_month', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({ receipts_this_month: 5 }),
      emptyFeed(),
    );

    await getBusinessActivity(1, null);

    const monthlySql = mockQuery.mock.calls[2]?.[0] as string;
    // The FILTER for receipts_this_month must require is_quarantined = FALSE
    expect(monthlySql).toMatch(/is_quarantined\s*=\s*FALSE/i);
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

  it('feed SQL WHERE clause should include is_quarantined = FALSE', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      emptyFeed(),
    );

    await getBusinessActivity(1, null);

    const feedSql = mockQuery.mock.calls[3]?.[0] as string;
    expect(feedSql).toBeDefined();
    expect(feedSql).toMatch(/is_quarantined\s*=\s*FALSE/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. entry_count on feed items — only non-quarantined tickets per submission
// ─────────────────────────────────────────────────────────────────────────────
describe('entry_count on feed items', () => {
  it('should map entry_count from the subquery result on each feed row', async () => {
    const feedRow = {
      ticket_id: 10,
      location_name: 'Shop A',
      transaction_amount: '50.00',
      receipt_identifier: 'RCP-001',
      entry_source: 'receipt',
      is_quarantined: false,
      quarantine_reason: null,
      created_at: new Date().toISOString(),
      entry_count: 3, // 3 non-quarantined tickets for this submission
    };

    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      { rows: [feedRow] },
    );

    const result = await getBusinessActivity(1, null);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].entry_count).toBe(3);
  });

  it('should default entry_count to 1 when the subquery returns null/0', async () => {
    const feedRow = {
      ticket_id: 11,
      location_name: 'Shop B',
      transaction_amount: null,
      receipt_identifier: null,
      entry_source: 'code',
      is_quarantined: false,
      quarantine_reason: null,
      created_at: new Date().toISOString(),
      entry_count: null, // subquery returned null for non-receipt
    };

    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      { rows: [feedRow] },
    );

    const result = await getBusinessActivity(1, null);

    expect(result.items[0].entry_count).toBe(1);
  });

  it('feed SQL entry_count subquery should filter t2.is_quarantined = FALSE', async () => {
    setupPoolQueries(
      BIZ_ROW,
      summaryRow({}),
      monthlyRow({}),
      emptyFeed(),
    );

    await getBusinessActivity(1, null);

    const feedSql = mockQuery.mock.calls[3]?.[0] as string;
    // The entry_count subquery (SELECT COUNT(*) FROM ticket t2 WHERE ...) must exclude quarantined
    expect(feedSql).toMatch(/t2\.is_quarantined\s*=\s*FALSE/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. monthly_cap returned correctly
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
      summaryRow({ receipts_today: 3, entries_today: 5 }),
      monthlyRow({ receipts_this_month: 8 }),
      emptyFeed(),
    );

    const result = await getBusinessActivity(1, 7); // jwtLocationId = 7

    expect(result.summary.receipts_today).toBe(3);
    expect(result.summary.entries_today).toBe(5);
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
  it('should throw "Business not found" when no business row for userId', async () => {
    setupPoolQueries({ rows: [] }); // no biz row

    await expect(getBusinessActivity(999, null)).rejects.toThrow('Business not found');
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
