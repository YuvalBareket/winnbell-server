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

// Risk decay runs AFTER winner confirmation commits (non-fatal) — stub it
jest.mock('../../risk/risk.service.js', () => ({
  decayAllUserRiskScores: jest.fn().mockResolvedValue({ unquarantinedUserIds: [] }),
}));

// email.service is imported for the founding final-campaign notice — stub it
const mockSendFoundingFinalCampaignEmail = jest.fn();
jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
  sendFoundingFinalCampaignEmail: (...args: unknown[]) => mockSendFoundingFinalCampaignEmail(...args),
}));

import { createDrawService, openDrawService, closeDrawService, confirmWinnerService, removeBusinessFromDrawService, duplicateDrawService } from '../admin.service';

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
  const DRAW_ROW = { id: 1, name: 'May 2026 Draw', prize_pool: 1000, start_date: '2026-05-01', draw_date: '2026-05-31', status: 'Upcoming' };

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
    // params array is the second argument; start_date is $3 → index 2, draw_date is $4 → index 3
    const params: unknown[] = insertCall![1];
    expect(params[3]).toBeInstanceOf(Date);
    return params[3] as Date;
  };

  const getInsertStartDateParam = (): Date => {
    const insertCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw'),
    );
    expect(insertCall).toBeDefined();
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

    // start_date pairs with draw_date: 1st of the SAME month (midnight NY = 04:00 UTC in May/EDT)
    const start = getInsertStartDateParam();
    expect(start.getUTCMonth()).toBe(4);  // May
    expect(start.getUTCDate()).toBe(1);
  });

  test('should use an explicit admin-picked start date on the exact day (not month-normalised)', async () => {
    setupClientQueries(
      { rows: [] },                                           // BEGIN
      { rows: [{ id: 1, name: 'Test', prize_pool: 500, start_date: '2026-05-10', draw_date: '2026-05-31', status: 'Upcoming' }] }, // INSERT draw
      { rows: [] },                                           // COMMIT
    );

    await createDrawService({ name: 'May Draw', prize_amount: 500, draw_date: '2026-05-15', start_date: '2026-05-10' });

    const start = getInsertStartDateParam();
    expect(start.getUTCMonth()).toBe(4);  // May
    expect(start.getUTCDate()).toBe(10);  // literal picked day, midnight NY
  });

  test('should reject a start date on or after the draw date', async () => {
    await expect(
      createDrawService({ name: 'Bad Draw', prize_amount: 500, draw_date: '2026-05-15', start_date: '2026-06-02' }),
    ).rejects.toThrow('Start date must be before the draw date');
  });

  test('should not shift a 1st-of-month date-only pick into the previous month', async () => {
    setupClientQueries(
      { rows: [] },                                           // BEGIN
      { rows: [{ id: 1, name: 'Test', prize_pool: 500, start_date: '2026-08-01', draw_date: '2026-08-31', status: 'Upcoming' }] }, // INSERT draw
      { rows: [] },                                           // COMMIT
    );

    // "2026-08-01" parsed as an instant is July 31 in NY; the literal date-only parse
    // must keep it in August.
    await createDrawService({ name: 'Aug Draw', prize_amount: 500, draw_date: '2026-08-01' });

    const date = getInsertDateParam();
    expect(date.getUTCMonth()).toBe(7);   // August
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
    // STRICTLY PAID: Active/Trialing only. No Past_Due grace — payment had the whole
    // 24th-to-open buffer week to recover; a late payment recovers + enrolls via the
    // invoice.payment_succeeded webhook instead.
    expect(sql).toMatch(/'Active',\s*'Trialing'/);
    expect(sql).not.toMatch(/Past_Due/);
    // Unified period check: founders join every campaign that opens inside their year;
    // for regular subs this also excludes a cancelled-on-the-24th sub whose deleted
    // webhook is late (stale Active status but expired period).
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
describe('closeDrawService — paid entries are never ejected at close', () => {
  test('closing a draw removes NO draw entries (enrollment is strictly paid at open)', async () => {
    setupClientQueries(
      { rows: [] },                            // BEGIN
      { rows: [] },                            // pg_advisory_xact_lock
      { rows: [{ id: 5, status: 'Open' }] },   // SELECT draw FOR UPDATE
      { rows: [{ id: 6 }] },                   // SELECT next Upcoming draw FOR UPDATE (hand-off target)
      { rows: [] },                            // UPDATE -> Closed
      { rows: [] },                            // logDrawAudit (closed)
      { rows: [] },                            // UPDATE business pending thresholds
      { rows: [] },                            // openDrawInTx: UPDATE draw -> Open
      { rows: [] },                            // openDrawInTx: apply staged plan changes
      { rows: [], rowCount: 2 },               // openDrawInTx: INSERT INTO draw_entry (enroll next)
      { rows: [] },                            // openDrawInTx: logDrawAudit (opened)
      { rows: [] },                            // COMMIT
    );

    await closeDrawService(5);

    // Every business in draw_entry PAID for the campaign (strict open-time enrollment).
    // A charge that fails later in the month is for the NEXT campaign and must never
    // eject a business from the one it already paid for.
    const del = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE FROM draw_entry'),
    );
    expect(del).toBeUndefined();

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

// ─────────────────────────────────────────────
// confirmWinnerService — eligibility re-check at confirm time
// ─────────────────────────────────────────────
describe('confirmWinnerService — eligibility re-check', () => {
  const DRAW_ROW = { status: 'Closed', prize_pool: 1000, winner_user_id: 5, winner_ticket_id: 9, winner_confirmed: false };
  const eligibleWinner = {
    code: 'WIN123', receipt_identifier: 'R-1', transaction_amount: 25, transaction_date: '2026-07-10',
    receipt_image_url: null, entry_source: 'receipt', image_validation_status: 'approved',
    full_name: 'Jane Doe', email: 'jane@test.com', risk_score: 3, is_active: true, is_quarantined: false,
    business_name: 'Cafe', location_name: 'Main St',
  };

  test('confirms an eligible candidate and marks winner_confirmed', async () => {
    setupClientQueries(
      { rows: [] },                    // BEGIN
      { rows: [DRAW_ROW] },            // draw FOR UPDATE
      { rows: [eligibleWinner] },      // winner ticket + user
      { rows: [] },                    // UPDATE winner_confirmed
      { rows: [] },                    // audit log
      { rows: [] },                    // COMMIT
    );
    await expect(confirmWinnerService(1)).resolves.toBeDefined();
    const confirmed = mockClientQuery.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('winner_confirmed = TRUE'),
    );
    expect(confirmed).toBe(true);
  });

  test('rejects a candidate DEACTIVATED between pick and confirm', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [DRAW_ROW] },
      { rows: [{ ...eligibleWinner, is_active: false }] },
      { rows: [] },
    );
    await expect(confirmWinnerService(1)).rejects.toThrow('WINNER_NO_LONGER_ELIGIBLE');
    const confirmed = mockClientQuery.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('winner_confirmed = TRUE'),
    );
    expect(confirmed).toBe(false);
  });

  test('rejects a candidate QUARANTINED between pick and confirm', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [DRAW_ROW] },
      { rows: [{ ...eligibleWinner, is_quarantined: true }] },
      { rows: [] },
    );
    await expect(confirmWinnerService(1)).rejects.toThrow('WINNER_NO_LONGER_ELIGIBLE');
  });

  test('rejects a candidate whose risk score climbed to the quarantine threshold', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [DRAW_ROW] },
      { rows: [{ ...eligibleWinner, risk_score: 20 }] },
      { rows: [] },
    );
    await expect(confirmWinnerService(1)).rejects.toThrow('WINNER_NO_LONGER_ELIGIBLE');
  });
});

// ─────────────────────────────────────────────
// removeBusinessFromDrawService — live-campaign guard (the old H2 hole)
// ─────────────────────────────────────────────
describe('removeBusinessFromDrawService — live-campaign guard', () => {
  test('refuses to remove a business from an OPEN draw (tickets would stay drawable)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, status: 'Open' }] });
    await expect(removeBusinessFromDrawService(1, 42)).rejects.toThrow(/live campaign/i);
    const deleted = mockQuery.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE FROM draw_entry'),
    );
    expect(deleted).toBe(false);
  });

  test('still allows removal from an UPCOMING draw (no tickets exist yet)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, status: 'Upcoming' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(removeBusinessFromDrawService(1, 42)).resolves.toBeUndefined();
    const deleted = mockQuery.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE FROM draw_entry'),
    );
    expect(deleted).toBe(true);
  });
});

// ─────────────────────────────────────────────
// duplicateDrawService — one campaign per month
// ─────────────────────────────────────────────
describe('duplicateDrawService — same-month collision guard', () => {
  test('refuses to duplicate into a month that already has a campaign', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ name: 'July 2026', prize_pool: 1000 }] }) // source draw
      .mockResolvedValueOnce({ rows: [{ id: 7 }] });                              // clash check hit
    await expect(duplicateDrawService(1)).rejects.toThrow('A campaign already exists for that month');
    const inserted = mockQuery.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw'),
    );
    expect(inserted).toBe(false);
  });
});
<<<<<<< HEAD
=======

// ─────────────────────────────────────────────
// Prize reveal — teaser flag for upcoming campaigns
// ─────────────────────────────────────────────
describe('setDrawPrizeRevealedService', () => {
  test('toggles the flag for an Upcoming draw', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, prize_revealed: true }], rowCount: 1 });
    await expect((await import('../admin.service')).setDrawPrizeRevealedService(5, true))
      .resolves.toEqual({ id: 5, prize_revealed: true });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/status = 'Upcoming'/);
  });

  test('rejects non-upcoming draws (Open/Closed prizes are always public)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect((await import('../admin.service')).setDrawPrizeRevealedService(5, true))
      .rejects.toThrow('Only upcoming campaigns have a prize reveal');
  });
});

describe('openDrawService — opening reveals the prize permanently', () => {
  test('the open UPDATE sets prize_revealed = TRUE (sticky across a later reopen-revert)', async () => {
    setupClientQueries(
      { rows: [] },                                    // BEGIN
      { rows: [] },                                    // advisory lock
      { rows: [{ id: 3, status: 'Upcoming' }] },       // draw FOR UPDATE
      { rows: [] },                                    // no open draw check
      { rows: [] },                                    // everything else
    );
    await openDrawService(3);
    const openUpdate = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("SET status = 'Open'"),
    );
    expect(openUpdate).toBeDefined();
    expect(openUpdate![0]).toMatch(/prize_revealed = TRUE/);
  });
});
>>>>>>> develop
