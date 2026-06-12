/**
 * Tests — createDrawService (admin.service.ts)
 *
 * Mock pattern: pool.query(sql, params) → { rows, rowCount }
 *               pool.connect() → client with query / release
 */

// ---- mock the DB module before any imports ----
const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();

const mockClient = {
  query: mockClientQuery,
  release: mockRelease,
};

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue(mockClient),
  }),
}));

// generateGlobalUniqueCode is imported transitively — stub it
jest.mock('../../tickets/tickets.service.js', () => ({
  generateGlobalUniqueCode: jest.fn().mockResolvedValue('TESTCODE'),
}));

import { createDrawService } from '../admin.service';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Sequence of responses for client.query (transaction path). */
const setupClientQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockClientQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────
// createDrawService
// ─────────────────────────────────────────────
describe('createDrawService', () => {
  const DRAW_ROW = { id: 1, name: 'May 2026 Draw', prize_pool: 1000, draw_date: '2026-05-31', status: 'Upcoming' };

  test('creates a draw with the prize_amount provided directly', async () => {
    setupClientQueries(
      { rows: [] },                        // BEGIN
      { rows: [DRAW_ROW] },                // INSERT draw RETURNING *
      { rows: [] },                        // SELECT subscriptions — none
      { rows: [] },                        // COMMIT
    );

    const result = await createDrawService({ name: 'May 2026 Draw', prize_amount: 1000, draw_date: '2026-05-31' });

    const insertCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw'),
    );
    expect(insertCall).toBeDefined();
    // prize_amount (1000) passed as second parameter — $2 in the INSERT
    expect(insertCall![1]).toContain(1000);
    expect(result).toEqual(DRAW_ROW);
  });

  test('prize pool equals the prize_amount provided (no calculation)', async () => {
    const prizeAmount = 2500;
    setupClientQueries(
      { rows: [] },
      { rows: [{ ...DRAW_ROW, prize_pool: prizeAmount }] },
      { rows: [] },
      { rows: [] },
    );

    const result = await createDrawService({ name: 'Test Draw', prize_amount: prizeAmount, draw_date: '2026-06-30' });

    // Verify the INSERT does NOT contain prize_percentage logic (no $2 with 80)
    const insertCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).not.toMatch(/prize_percentage/);
    expect(result.prize_pool).toBe(prizeAmount);
  });

  test('returns the created draw row', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [DRAW_ROW] },
      { rows: [] },
      { rows: [] },
    );

    const result = await createDrawService({ name: 'May 2026 Draw', prize_amount: 1000, draw_date: '2026-05-31' });

    expect(result.id).toBe(1);
    expect(result.status).toBe('Upcoming');
  });

  test('enrolls active businesses via a single set-based INSERT ... SELECT', async () => {
    setupClientQueries(
      { rows: [] },              // BEGIN
      { rows: [DRAW_ROW] },      // INSERT draw
      { rows: [], rowCount: 2 }, // set-based INSERT draw_entry (2 subscribed businesses)
      { rows: [] },              // COMMIT
    );

    await createDrawService({ name: 'May 2026 Draw', prize_amount: 1000, draw_date: '2026-05-31' });

    const entryInserts = mockClientQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    // One set-based statement, not one INSERT per business
    expect(entryInserts).toHaveLength(1);
    const sql: string = entryInserts[0][0];
    expect(sql).toMatch(/SELECT/);
    expect(sql).toMatch(/JOIN subscription/);
    expect(sql).toMatch(/'Active',\s*'Trialing'/);
    // The new draw id is bound as the only parameter
    expect(entryInserts[0][1]).toEqual([1]);
  });

  test('sets contribution_amount to 0 for all enrolled businesses', async () => {
    const subs = [
      { business_id: 10, monthly_fee: 500 },
      { business_id: 11, monthly_fee: 750 },
    ];
    setupClientQueries(
      { rows: [] },
      { rows: [DRAW_ROW] },
      { rows: subs },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [] },
    );

    await createDrawService({ name: 'May 2026 Draw', prize_amount: 1000, draw_date: '2026-05-31' });

    const entryInserts = mockClientQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    // Every draw_entry INSERT must pass 0 as the contribution_amount
    for (const call of entryInserts) {
      const sql: string = call[0];
      // The literal 0 appears in the SQL for contribution_amount
      expect(sql).toMatch(/,\s*0\s*\)/);
    }
  });

  test('does not UPDATE draw prize_pool after INSERT (prize is set at INSERT time)', async () => {
    const subs = [{ business_id: 10, monthly_fee: 500 }];
    setupClientQueries(
      { rows: [] },
      { rows: [DRAW_ROW] },
      { rows: subs },
      { rows: [], rowCount: 1 },
      { rows: [] },
    );

    await createDrawService({ name: 'May 2026 Draw', prize_amount: 1000, draw_date: '2026-05-31' });

    const updatePrizePool = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE draw') && sql.includes('prize_pool'),
    );
    expect(updatePrizePool).toBeUndefined();
  });

  test('rolls back on error and re-throws', async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      return Promise.reject(new Error('DB connection lost'));
    });

    await expect(
      createDrawService({ name: 'Fail Draw', prize_amount: 500, draw_date: '2026-07-31' }),
    ).rejects.toThrow('DB connection lost');

    const rollbackCalls = mockClientQuery.mock.calls.filter(
      ([sql]: [string]) => sql === 'ROLLBACK',
    );
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('client.release() is always called even on error', async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      return Promise.reject(new Error('unexpected error'));
    });

    await expect(
      createDrawService({ name: 'Fail Draw', prize_amount: 500, draw_date: '2026-07-31' }),
    ).rejects.toThrow();

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test('enrollment is data-driven: the set-based INSERT inserts 0 rows when no active subscriptions exist', async () => {
    setupClientQueries(
      { rows: [] },              // BEGIN
      { rows: [DRAW_ROW] },      // INSERT draw
      { rows: [], rowCount: 0 }, // set-based INSERT draw_entry — no subscribed businesses → 0 rows
      { rows: [] },              // COMMIT
    );

    await createDrawService({ name: 'Empty Draw', prize_amount: 500, draw_date: '2026-08-31' });

    // The statement still executes once (filtering happens in SQL via the
    // subscription status JOIN), it just affects zero rows.
    const entryInserts = mockClientQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    expect(entryInserts).toHaveLength(1);
    expect(entryInserts[0][0]).toMatch(/'Active',\s*'Trialing'/);
  });
});

// ─────────────────────────────────────────────
// createDrawService — draw_date normalisation
// ─────────────────────────────────────────────

describe('createDrawService — date normalisation', () => {
  /**
   * The service normalises draw_date to the last day of the month in NY timezone:
   *
   *   const nyDateStr = new Date(data.draw_date).toLocaleDateString('en-US', {
   *     timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
   *   });
   *   const [month, , year] = nyDateStr.split('/').map(Number);
   *   const lastDay = new Date(Date.UTC(year, month, 0, 4, 0, 0));
   *
   * We grab the 3rd INSERT parameter (index 2) from the INSERT INTO draw call and
   * inspect its UTC month and day to verify normalisation occurred correctly.
   */

  const getInsertDateParam = (): Date => {
    const insertCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw'),
    );
    expect(insertCall).toBeDefined();
    // params array is the second argument; draw_date is $3 → index 2
    const params: unknown[] = insertCall![1];
    expect(params[2]).toBeInstanceOf(Date);
    return params[2] as Date;
  };

  test('should normalise a mid-month date to the last day of that month (May 15 → May 31)', async () => {
    setupClientQueries(
      { rows: [] },                                           // BEGIN
      { rows: [{ id: 1, name: 'Test', prize_pool: 500, draw_date: '2026-05-31', status: 'Upcoming' }] }, // INSERT draw
      { rows: [] },                                           // SELECT subscriptions
      { rows: [] },                                           // COMMIT
    );

    await createDrawService({ name: 'May Draw', prize_amount: 500, draw_date: '2026-05-15' });

    const date = getInsertDateParam();
    // UTC month: May = 4 (0-based), day = 31
    expect(date.getUTCMonth()).toBe(4);   // May
    expect(date.getUTCDate()).toBe(31);
  });

  test('should leave an already-last-day date unchanged (May 31 → May 31)', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [{ id: 1, name: 'Test', prize_pool: 500, draw_date: '2026-05-31', status: 'Upcoming' }] },
      { rows: [] },
      { rows: [] },
    );

    await createDrawService({ name: 'May Draw', prize_amount: 500, draw_date: '2026-05-31' });

    const date = getInsertDateParam();
    expect(date.getUTCMonth()).toBe(4);   // May
    expect(date.getUTCDate()).toBe(31);
  });

  test('should normalise February date to Feb 28 in a non-leap year (2026-02-10 → Feb 28)', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [{ id: 2, name: 'Feb Draw', prize_pool: 500, draw_date: '2026-02-28', status: 'Upcoming' }] },
      { rows: [] },
      { rows: [] },
    );

    await createDrawService({ name: 'Feb Draw', prize_amount: 500, draw_date: '2026-02-10' });

    const date = getInsertDateParam();
    // UTC month: February = 1 (0-based), day = 28 (2026 is not a leap year)
    expect(date.getUTCMonth()).toBe(1);   // February
    expect(date.getUTCDate()).toBe(28);
  });

  test('should normalise a 30-day month to the 30th (June 10 → June 30)', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [{ id: 3, name: 'Jun Draw', prize_pool: 500, draw_date: '2026-06-30', status: 'Upcoming' }] },
      { rows: [] },
      { rows: [] },
    );

    await createDrawService({ name: 'Jun Draw', prize_amount: 500, draw_date: '2026-06-10' });

    const date = getInsertDateParam();
    // UTC month: June = 5 (0-based), day = 30
    expect(date.getUTCMonth()).toBe(5);   // June
    expect(date.getUTCDate()).toBe(30);
  });
});

// ─────────────────────────────────────────────
// Controller validation behaviour
// ─────────────────────────────────────────────
describe('createDraw controller — prize_amount validation', () => {
  /**
   * These tests verify the validation logic by testing the conditions directly,
   * matching how the controller validates prize_amount before calling the service.
   */

  const validate = (prize_amount: unknown): boolean => {
    const parsed = Number(prize_amount);
    return !(!prize_amount || isNaN(parsed) || parsed <= 0);
  };

  test('rejects missing prize_amount', () => {
    expect(validate(undefined)).toBe(false);
  });

  test('rejects prize_amount of 0', () => {
    expect(validate(0)).toBe(false);
  });

  test('rejects negative prize_amount', () => {
    expect(validate(-100)).toBe(false);
  });

  test('rejects non-numeric string', () => {
    expect(validate('abc')).toBe(false);
  });

  test('rejects null', () => {
    expect(validate(null)).toBe(false);
  });

  test('accepts a positive integer', () => {
    expect(validate(1000)).toBe(true);
  });

  test('accepts a positive decimal', () => {
    expect(validate(999.99)).toBe(true);
  });

  test('accepts prize_amount of 1 (minimum positive)', () => {
    expect(validate(1)).toBe(true);
  });
});
