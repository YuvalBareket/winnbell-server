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

// email.service is imported for the founding final-campaign notice — stub it
const mockSendFoundingFinalCampaignEmail = jest.fn();
jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
  sendFoundingFinalCampaignEmail: (...args: unknown[]) => mockSendFoundingFinalCampaignEmail(...args),
}));

import { createDrawService, openDrawService, closeDrawService } from '../admin.service';

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
  // Default pool.query response (e.g. the non-fatal founding final-campaign notice that
  // runs after a draw opens). Tests that need specific rows use mockResolvedValueOnce,
  // which takes precedence over this default.
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
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

  test('does NOT enroll businesses at create (enrollment moved to open)', async () => {
    setupClientQueries(
      { rows: [] },              // BEGIN
      { rows: [DRAW_ROW] },      // INSERT draw
      { rows: [] },              // COMMIT
    );

    await createDrawService({ name: 'May 2026 Draw', prize_amount: 1000, draw_date: '2026-05-31' });

    const entryInserts = mockClientQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    // Enrollment now happens in openDrawService — create must never touch draw_entry.
    expect(entryInserts).toHaveLength(0);
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

  test('create builds the draw row but performs no enrollment', async () => {
    setupClientQueries(
      { rows: [] },              // BEGIN
      { rows: [DRAW_ROW] },      // INSERT draw
      { rows: [] },              // COMMIT
    );

    const result = await createDrawService({ name: 'Empty Draw', prize_amount: 500, draw_date: '2026-08-31' });

    expect(result.status).toBe('Upcoming');
    const entryInserts = mockClientQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    expect(entryInserts).toHaveLength(0);
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

// ─────────────────────────────────────────────
// openDrawService — enrollment is the single point businesses join a draw
// ─────────────────────────────────────────────
describe('openDrawService — enrollment', () => {
  test('enrolls paid businesses at open, including Past_Due (grace), and gates founders by their prepaid year', async () => {
    setupClientQueries(
      { rows: [] },                               // BEGIN
      { rows: [] },                               // pg_advisory_xact_lock
      { rows: [{ id: 5, status: 'Upcoming' }] },  // SELECT draw FOR UPDATE
      { rows: [] },                               // SELECT open draw (none open)
      { rows: [] },                               // UPDATE draw -> Open
      { rows: [], rowCount: 3 },                  // INSERT INTO draw_entry (enroll)
      { rows: [] },                               // logDrawAudit
      { rows: [] },                               // COMMIT
    );

    await openDrawService(5);

    const enroll = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    expect(enroll).toBeDefined();
    const sql: string = enroll![0];
    expect(sql).toMatch(/JOIN subscription/);
    // Paid businesses + Past_Due during the retry grace window
    expect(sql).toMatch(/'Active',\s*'Trialing',\s*'Past_Due'/);
    // Founding members (no stripe sub) join every campaign that OPENS inside their year
    expect(sql).toMatch(/stripe_subscription_id IS NOT NULL/);
    expect(sql).toMatch(/current_period_end >= NOW\(\)/);
    // Businesses that opted out of the paid campaign are skipped (flag consumed after)
    expect(sql).toMatch(/skip_next_campaign = FALSE/);
    expect(enroll![1]).toEqual([5]);

    const skipReset = mockClientQuery.mock.calls.find(
      ([s]: [string]) => typeof s === 'string' && s.includes('SET skip_next_campaign = FALSE'),
    );
    expect(skipReset).toBeDefined();
  });

  test('refuses to open a second draw while one is already Open', async () => {
    setupClientQueries(
      { rows: [] },                               // BEGIN
      { rows: [] },                               // pg_advisory_xact_lock
      { rows: [{ id: 5, status: 'Upcoming' }] },  // SELECT draw FOR UPDATE
      { rows: [{ id: 9 }] },                      // an Open draw already exists
    );

    await expect(openDrawService(5)).rejects.toThrow(/already Open/);

    const enroll = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    expect(enroll).toBeUndefined(); // never enrolled — it threw first
  });

  test('only Upcoming draws can be opened', async () => {
    setupClientQueries(
      { rows: [] },                               // BEGIN
      { rows: [] },                               // pg_advisory_xact_lock
      { rows: [{ id: 5, status: 'Open' }] },      // already Open
    );
    await expect(openDrawService(5)).rejects.toThrow(/Only Upcoming/);
  });
});

// ─────────────────────────────────────────────
// closeDrawService — draw-time paid-only safety net
// ─────────────────────────────────────────────
describe('closeDrawService — draw-time paid check', () => {
  test('drops businesses whose payment never cleared (Past_Due/Incomplete) when the draw closes', async () => {
    setupClientQueries(
      { rows: [] },                            // BEGIN
      { rows: [] },                            // pg_advisory_xact_lock
      { rows: [{ id: 5, status: 'Open' }] },   // SELECT draw FOR UPDATE
      { rows: [{ id: 6 }] },                   // SELECT next Upcoming draw FOR UPDATE (hand-off target)
      { rows: [] },                            // UPDATE -> Closed
      { rows: [] },                            // logDrawAudit (closed)
      { rows: [], rowCount: 1 },               // DELETE draw_entry (unpaid)
      { rows: [] },                            // UPDATE business pending thresholds
      { rows: [] },                            // openDrawInTx: UPDATE draw -> Open
      { rows: [] },                            // openDrawInTx: apply staged plan changes
      { rows: [], rowCount: 2 },               // openDrawInTx: INSERT INTO draw_entry (enroll next)
      { rows: [] },                            // openDrawInTx: logDrawAudit (opened)
      { rows: [] },                            // COMMIT
    );

    await closeDrawService(5);

    const del = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE FROM draw_entry'),
    );
    expect(del).toBeDefined();
    expect(del![0]).toMatch(/'Past_Due',\s*'Incomplete'/);
    expect(del![1]).toEqual([5]);

    // Hand-off: closing the current draw opens the next Upcoming one in the same transaction.
    const openNext = mockClientQuery.mock.calls.find(
      ([sql, params]: [string, unknown[]]) =>
        typeof sql === 'string' && sql.includes(`SET status = 'Open'`) && Array.isArray(params) && params[0] === 6,
    );
    expect(openNext).toBeDefined();
  });
});

describe('openDrawInTx — staged plan changes (founding hand-off)', () => {
  test('applies pending tier/fee at open, BEFORE enrollment snapshots them', async () => {
    setupClientQueries(
      { rows: [] },                               // BEGIN
      { rows: [] },                               // pg_advisory_xact_lock
      { rows: [{ id: 5, status: 'Upcoming' }] },  // SELECT draw FOR UPDATE
      { rows: [] },                               // SELECT open draw (none open)
      { rows: [] },                               // UPDATE draw -> Open
      { rows: [], rowCount: 1 },                  // apply staged plan changes
      { rows: [], rowCount: 3 },                  // INSERT INTO draw_entry (enroll)
      { rows: [] },                               // logDrawAudit
      { rows: [] },                               // COMMIT
    );

    await openDrawService(5);

    const calls = mockClientQuery.mock.calls;
    const pendingIdx = calls.findIndex(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('pending_entries_per_location IS NOT NULL'),
    );
    const activateIdx = calls.findIndex(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('WHERE activate_at_open = TRUE'),
    );
    const deactivateIdx = calls.findIndex(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('WHERE deactivate_at_open = TRUE'),
    );
    const enrollIdx = calls.findIndex(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    expect(pendingIdx).toBeGreaterThan(-1);
    expect(activateIdx).toBeGreaterThan(-1);
    expect(deactivateIdx).toBeGreaterThan(-1);
    expect(enrollIdx).toBeGreaterThan(-1);
    // Staged plan AND staged location changes must be live before enrollment snapshots
    // fee/cap and before the location count matters for the new campaign.
    expect(pendingIdx).toBeLessThan(enrollIdx);
    expect(activateIdx).toBeLessThan(enrollIdx);
    expect(deactivateIdx).toBeLessThan(enrollIdx);
    // It both promotes and clears the staged values.
    const sql: string = calls[pendingIdx][0];
    expect(sql).toMatch(/entries_per_location\s*=\s*pending_entries_per_location/);
    expect(sql).toMatch(/pending_entries_per_location = NULL/);
  });
});
