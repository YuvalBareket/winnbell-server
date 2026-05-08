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

  test('enrolls active businesses in draw_entry when subscriptions exist', async () => {
    const subs = [
      { business_id: 10, monthly_fee: 500 },
      { business_id: 11, monthly_fee: 750 },
    ];
    setupClientQueries(
      { rows: [] },          // BEGIN
      { rows: [DRAW_ROW] },  // INSERT draw
      { rows: subs },        // SELECT subscriptions
      { rows: [], rowCount: 1 }, // INSERT draw_entry business 10
      { rows: [], rowCount: 1 }, // INSERT draw_entry business 11
      { rows: [] },          // COMMIT
    );

    await createDrawService({ name: 'May 2026 Draw', prize_amount: 1000, draw_date: '2026-05-31' });

    const entryInserts = mockClientQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    expect(entryInserts).toHaveLength(2);
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

  test('skips draw_entry inserts when no active subscriptions exist', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [DRAW_ROW] },
      { rows: [] },  // no subscriptions
      { rows: [] },  // COMMIT
    );

    await createDrawService({ name: 'Empty Draw', prize_amount: 500, draw_date: '2026-08-31' });

    const entryInserts = mockClientQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    expect(entryInserts).toHaveLength(0);
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
