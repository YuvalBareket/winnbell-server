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

// Risk decay runs AFTER winner confirmation commits (non-fatal) — stub it.
// updateUserRiskScore/syncUserQuarantineState are dynamically imported by
// adminImageDecisionService — stub them too so its tests don't hit real SQL.
jest.mock('../../risk/risk.service.js', () => ({
  decayAllUserRiskScores: jest.fn().mockResolvedValue({ unquarantinedUserIds: [] }),
  updateUserRiskScore: jest.fn().mockResolvedValue(undefined),
  syncUserQuarantineState: jest.fn().mockResolvedValue(undefined),
}));

// email.service is imported for the founding final-campaign notice — stub it
const mockSendFoundingFinalCampaignEmail = jest.fn();
jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
  sendFoundingFinalCampaignEmail: (...args: unknown[]) => mockSendFoundingFinalCampaignEmail(...args),
}));

import { createDrawService, openDrawService, closeDrawService, pickDrawWinnerService, extendDrawWinnerOrderService, confirmWinnerService, getDrawWinnerOrderService, removeBusinessFromDrawService, duplicateDrawService, adminImageDecisionService } from '../admin.service';

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

    await openDrawService(5, 1);

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
    // Founding members who cancelled participation are never enrolled
    expect(sql).toMatch(/participation_paused = FALSE/);
    expect(enroll![1]).toEqual([5]);

    const skipReset = mockClientQuery.mock.calls.find(
      ([s]: [string]) => typeof s === 'string' && s.includes('SET skip_next_campaign = FALSE'),
    );
    expect(skipReset).toBeDefined();
    // The reset spares cancelling subs: their skip records "skipped the campaign they
    // already paid for" and must survive the open for the plan page to say so.
    expect(skipReset![0]).toMatch(/cancel_at_period_end = FALSE/);
  });

  test('refuses to open a second draw while one is already Open', async () => {
    setupClientQueries(
      { rows: [] },                               // BEGIN
      { rows: [] },                               // pg_advisory_xact_lock
      { rows: [{ id: 5, status: 'Upcoming' }] },  // SELECT draw FOR UPDATE
      { rows: [{ id: 9 }] },                      // an Open draw already exists
    );

    await expect(openDrawService(5, 1)).rejects.toThrow(/already Open/);

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
    await expect(openDrawService(5, 1)).rejects.toThrow(/Only Upcoming/);
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

    await closeDrawService(5, 1);

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

    await openDrawService(5, 1);

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
    await expect(confirmWinnerService(1, 1)).resolves.toBeDefined();
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
    await expect(confirmWinnerService(1, 1)).rejects.toThrow('WINNER_NO_LONGER_ELIGIBLE');
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
    await expect(confirmWinnerService(1, 1)).rejects.toThrow('WINNER_NO_LONGER_ELIGIBLE');
  });

  test('rejects a candidate whose risk score climbed to the quarantine threshold', async () => {
    setupClientQueries(
      { rows: [] },
      { rows: [DRAW_ROW] },
      { rows: [{ ...eligibleWinner, risk_score: 20 }] },
      { rows: [] },
    );
    await expect(confirmWinnerService(1, 1)).rejects.toThrow('WINNER_NO_LONGER_ELIGIBLE');
  });
});

// ─────────────────────────────────────────────
// pickDrawWinnerService — frozen selection order
// ─────────────────────────────────────────────
describe('pickDrawWinnerService — frozen selection order', () => {
  const CLOSED_DRAW = { id: 1, status: 'Closed', prize_pool: 1000, winner_user_id: null, winner_ticket_id: null, winner_confirmed: false };
  const WINNER_ROW = {
    ticket_id: 9, code: 'WIN123', activated_by_user_id: 5,
    receipt_identifier: 'R-1', transaction_amount: 25, transaction_date: '2026-07-10',
    receipt_image_url: null, entry_source: 'receipt', image_validation_status: 'passed',
    full_name: 'Jane Doe', email: 'jane@test.com', risk_score: 3,
    business_name: 'Cafe', location_name: 'Main St',
    queue_position: 1, queue_total: 3,
  };

  test('first pick generates the reachable prefix once, then takes the top entry by position', async () => {
    setupClientQueries(
      { rows: [] },                             // BEGIN
      { rows: [CLOSED_DRAW] },                  // draw FOR UPDATE
      { rows: [] },                             // SET LOCAL statement_timeout
      { rows: [] },                             // order-exists probe: empty -> generate
      { rows: [{ eligible: 40, stored: 3 }] },  // one-statement shuffle+insert+counts
      { rows: [] },                             // audit: winner_order_generated
      { rows: [WINNER_ROW] },                   // pick SELECT (top of order)
      { rows: [] },                             // UPDATE draw winner
      { rows: [] },                             // audit: winner_picked
      { rows: [] },                             // COMMIT
    );

    const result = await pickDrawWinnerService(1, false, undefined, 1) as { queuePosition: number; queueTotal: number };
    expect(result.queuePosition).toBe(1);
    expect(result.queueTotal).toBe(3);

    const calls = mockClientQuery.mock.calls.map(([sql]: [string]) => sql).filter((s: unknown) => typeof s === 'string');
    const genSql = calls.find((s: string) => s.includes('INSERT INTO draw_winner_order'));
    expect(genSql).toBeDefined();
    // The ranking is drawn once, uniformly at random, at generation time only...
    expect(genSql).toMatch(/row_number\(\) OVER \(ORDER BY random\(\)\)/);
    // ...and evaluated exactly once: the cutoff and the insert must see the SAME shuffle.
    expect(genSql).toMatch(/WITH ranked AS MATERIALIZED/);
    // ...and only a bounded prefix is stored: min-70 floor, auto-valid cutoff, batch cap.
    expect(genSql).toMatch(/LEAST\(/);
    expect(genSql).toMatch(/GREATEST\(/);
    expect(genSql).toMatch(/position <= \(SELECT cut FROM cutoff\)/);
    const pickSql = calls.find((s: string) => s.includes('ORDER BY dwo.position'));
    expect(pickSql).toBeDefined();
    // The pick itself never re-rolls.
    expect(pickSql).not.toMatch(/ORDER BY random/);
    // The single statement reports both counts from the SAME shuffled snapshot - the
    // audited numbers can never disagree with the stored ranking.
    expect(genSql).toMatch(/RETURNING 1/);
    expect(genSql).toMatch(/COUNT\(\*\)::int FROM ranked/);
    const auditGen = mockClientQuery.mock.calls.find(
      ([sql, params]: [string, unknown[]]) => typeof sql === 'string' && sql.includes('draw_audit_log') && Array.isArray(params) && params.includes('winner_order_generated'),
    );
    expect(auditGen).toBeDefined();
    expect(auditGen![1][3]).toContain('"entry_count":3');
    expect(auditGen![1][3]).toContain('"eligible_count":40');
    // The record itself states the methodology.
    expect(auditGen![1][3]).toContain('"method":"uniform_random_full_shuffle_bounded_prefix"');
  });

  test('exhausted list COMMITS the rejection and returns exhausted - never extends automatically', async () => {
    const withCandidate = { ...CLOSED_DRAW, winner_user_id: 7, winner_ticket_id: 8 };
    setupClientQueries(
      { rows: [] },                // BEGIN
      { rows: [withCandidate] },   // draw FOR UPDATE
      { rows: [] },                // UPDATE draw clear winner
      { rows: [] },                // UPDATE ticket quarantine
      { rows: [] },                // INSERT draw_rejected_winner
      { rows: [] },                // audit: winner_rejected
      { rows: [] },                // SET LOCAL
      { rows: [{ exists: 1 }] },   // order-exists probe: found
      { rows: [] },                // pick SELECT: list exhausted
      { rows: [{ total: 5 }] },    // stored-order COUNT for the exhausted response
      { rows: [] },                // COMMIT
    );

    const result = await pickDrawWinnerService(1, false, 'final candidate is fraudulent', 1);
    expect(result).toEqual({ exhausted: true, queueTotal: 5 });

    // The rejection is durably recorded - the transaction COMMITS, it does not roll back.
    const committed = mockClientQuery.mock.calls.some(([sql]: [string]) => sql === 'COMMIT');
    expect(committed).toBe(true);
    const rejected = mockClientQuery.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_rejected_winner'),
    );
    expect(rejected).toBe(true);
    // And the list is NEVER extended without explicit admin approval.
    const extendedSql = mockClientQuery.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_winner_order'),
    );
    expect(extendedSql).toBe(false);
  });
});

// ─────────────────────────────────────────────
// extendDrawWinnerOrderService — admin-approved list continuation
// ─────────────────────────────────────────────
describe('extendDrawWinnerOrderService — admin-approved continuation', () => {
  const EXHAUSTED_DRAW = { id: 1, status: 'Closed', prize_pool: 1000, winner_ticket_id: null, winner_confirmed: false };
  const NEXT_WINNER = {
    ticket_id: 99, code: 'EXT99999', activated_by_user_id: 12,
    receipt_identifier: 'R-9', transaction_amount: 15, transaction_date: '2026-07-20',
    receipt_image_url: null, entry_source: 'receipt', image_validation_status: 'passed',
    full_name: 'Next Candidate', email: 'next@test.com', risk_score: 2,
    business_name: 'Cafe', location_name: 'Main St',
    queue_position: 6, queue_total: 7,
  };

  test('appends the next batch (audited with pool size) and promotes its top entry', async () => {
    setupClientQueries(
      { rows: [] },                             // BEGIN
      { rows: [EXHAUSTED_DRAW] },               // draw FOR UPDATE
      { rows: [] },                             // SET LOCAL
      { rows: [{ exists: 1 }] },                // order-exists probe: found
      { rows: [] },                             // exhaustion guard pick: empty (truly exhausted)
      { rows: [{ eligible: 50, stored: 2 }] },  // one-statement draw+append+counts
      { rows: [] },                             // audit: winner_order_extended
      { rows: [NEXT_WINNER] },                  // pick SELECT (top of new batch)
      { rows: [] },                             // UPDATE draw winner
      { rows: [] },                             // audit: winner_picked
      { rows: [] },                             // COMMIT
    );

    const result = await extendDrawWinnerOrderService(1, 1);
    expect(result.queuePosition).toBe(6);
    expect(result.queueTotal).toBe(7);

    const calls = mockClientQuery.mock.calls.map(([sql]: [string]) => sql).filter((s: unknown) => typeof s === 'string');
    const extSql = calls.find((s: string) => s.includes('INSERT INTO draw_winner_order'));
    expect(extSql).toBeDefined();
    // Append-only: excludes tickets already in the order and continues after the max position.
    expect(extSql).toMatch(/NOT EXISTS[\s\S]*draw_winner_order/);
    expect(extSql).toMatch(/MAX\(position\)/);
    // Single-evaluation guarantee, same as generation.
    expect(extSql).toMatch(/WITH ranked AS MATERIALIZED/);
    const auditExt = mockClientQuery.mock.calls.find(
      ([sql, params]: [string, unknown[]]) => typeof sql === 'string' && sql.includes('draw_audit_log') && Array.isArray(params) && params.includes('winner_order_extended'),
    );
    expect(auditExt).toBeDefined();
    expect(auditExt![1][3]).toContain('"entry_count":2');
    expect(auditExt![1][3]).toContain('"eligible_count":50');
    expect(auditExt![1][3]).toContain('"method":"uniform_random_continuation_remaining_entries"');
  });

  test('refuses to extend while the current list still has an eligible entry', async () => {
    setupClientQueries(
      { rows: [] },                                              // BEGIN
      { rows: [{ ...EXHAUSTED_DRAW, winner_ticket_id: 8 }] },    // draw FOR UPDATE (candidate present)
      { rows: [] },                                              // SET LOCAL
      { rows: [{ exists: 1 }] },                                 // order-exists probe: found
      { rows: [NEXT_WINNER] },                                   // exhaustion guard pick: still eligible
    );
    await expect(extendDrawWinnerOrderService(1, 1)).rejects.toThrow('still has an eligible entry');
    const extendedSql = mockClientQuery.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_winner_order'),
    );
    expect(extendedSql).toBe(false);
  });

  test('throws when no eligible entries remain to draw', async () => {
    setupClientQueries(
      { rows: [] },                             // BEGIN
      { rows: [EXHAUSTED_DRAW] },               // draw FOR UPDATE
      { rows: [] },                             // SET LOCAL
      { rows: [{ exists: 1 }] },                // order-exists probe: found
      { rows: [] },                             // exhaustion guard pick: empty
      { rows: [{ eligible: 0, stored: 0 }] },   // one-statement draw: nothing left
    );
    await expect(extendDrawWinnerOrderService(1, 1)).rejects.toThrow('No eligible entries remain');
  });

  test('throws when no list has been drawn yet', async () => {
    setupClientQueries(
      { rows: [] },                // BEGIN
      { rows: [EXHAUSTED_DRAW] },  // draw FOR UPDATE
      { rows: [] },                // SET LOCAL
      { rows: [] },                // order-exists probe: no list
    );
    await expect(extendDrawWinnerOrderService(1, 1)).rejects.toThrow('No list has been drawn');
  });
});

// ─────────────────────────────────────────────
// pickDrawWinnerService — walk semantics
// ─────────────────────────────────────────────
describe('pickDrawWinnerService — walk semantics', () => {
  const CLOSED_DRAW = { id: 1, status: 'Closed', prize_pool: 1000, winner_user_id: null, winner_ticket_id: null, winner_confirmed: false };
  const WINNER_ROW = {
    ticket_id: 9, code: 'WIN123', activated_by_user_id: 5,
    receipt_identifier: 'R-1', transaction_amount: 25, transaction_date: '2026-07-10',
    receipt_image_url: null, entry_source: 'receipt', image_validation_status: 'passed',
    full_name: 'Jane Doe', email: 'jane@test.com', risk_score: 3,
    business_name: 'Cafe', location_name: 'Main St',
    queue_position: 1, queue_total: 3,
  };

  test('when the order already exists it is NEVER regenerated', async () => {
    setupClientQueries(
      { rows: [] },                                        // BEGIN
      { rows: [CLOSED_DRAW] },                             // draw FOR UPDATE
      { rows: [] },                                        // SET LOCAL
      { rows: [{ exists: 1 }] },                           // order-exists probe: found
      { rows: [{ ...WINNER_ROW, queue_position: 2 }] },    // pick SELECT (next eligible in order)
      { rows: [] },                                        // UPDATE draw winner
      { rows: [] },                                        // audit: winner_picked
      { rows: [] },                                        // COMMIT
    );

    const result = await pickDrawWinnerService(1, false, undefined, 1) as { queuePosition: number };
    expect(result.queuePosition).toBe(2);

    const regen = mockClientQuery.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_winner_order'),
    );
    expect(regen).toBe(false);
  });

  test('rejecting the current candidate requires a reason and advances within the SAME order', async () => {
    const withCandidate = { ...CLOSED_DRAW, winner_user_id: 7, winner_ticket_id: 8 };
    setupClientQueries(
      { rows: [] },                                        // BEGIN
      { rows: [withCandidate] },                           // draw FOR UPDATE
      { rows: [] },                                        // UPDATE draw clear winner
      { rows: [] },                                        // UPDATE ticket quarantine
      { rows: [] },                                        // INSERT draw_rejected_winner
      { rows: [] },                                        // audit: winner_rejected
      { rows: [] },                                        // SET LOCAL
      { rows: [{ exists: 1 }] },                           // order-exists probe: found
      { rows: [{ ...WINNER_ROW, queue_position: 2 }] },    // pick SELECT (next in order)
      { rows: [] },                                        // UPDATE draw winner
      { rows: [] },                                        // audit: winner_picked
      { rows: [] },                                        // COMMIT
    );

    const result = await pickDrawWinnerService(1, false, 'ineligible receipt', 1) as { queuePosition: number };
    expect(result.queuePosition).toBe(2);

    const rejected = mockClientQuery.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_rejected_winner'),
    );
    expect(rejected).toBe(true);
    const regen = mockClientQuery.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_winner_order'),
    );
    expect(regen).toBe(false);
  });

  test('rejecting without a reason throws before touching the order', async () => {
    const withCandidate = { ...CLOSED_DRAW, winner_user_id: 7, winner_ticket_id: 8 };
    setupClientQueries(
      { rows: [] },              // BEGIN
      { rows: [withCandidate] }, // draw FOR UPDATE
      { rows: [] },
    );
    await expect(pickDrawWinnerService(1, false, undefined, 1)).rejects.toThrow('A reason is required');
  });
});

// ─────────────────────────────────────────────
// getDrawWinnerOrderService — locked rows reveal nothing
// ─────────────────────────────────────────────
describe('getDrawWinnerOrderService — order board masking', () => {
  test('resolved rows carry identity; locked rows expose ONLY their position', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ winner_ticket_id: 22, winner_confirmed: false }] })  // draw
      .mockResolvedValueOnce({ rows: [{ total: 40 }] })                                       // count
      .mockResolvedValueOnce({ rows: [                                                        // bounded order rows
        { position: 1, ticket_id: 11, code: 'AAA11111', entry_source: 'receipt', full_name: 'Rejected Guy', email: 'rej@test.com', risk_score: 5, rejected_reason: 'fake receipt', rejected_at: '2026-08-01T00:00:00Z' },
        { position: 2, ticket_id: 22, code: 'BBB22222', entry_source: 'free', full_name: 'Jane Doe', email: 'jane@test.com', risk_score: 1, rejected_reason: null, rejected_at: null },
        { position: 3, ticket_id: 33, code: 'CCC33333', entry_source: 'receipt', full_name: 'Hidden Person', email: 'hidden@test.com', risk_score: 0, rejected_reason: null, rejected_at: null },
      ] });

    const res = await getDrawWinnerOrderService(1);
    expect(res.total).toBe(40);
    expect(res.winnerConfirmed).toBe(false);
    expect(res.entries[0]).toMatchObject({ position: 1, status: 'rejected', userName: 'Rejected Guy', rejectedReason: 'fake receipt' });
    expect(res.entries[1]).toMatchObject({ position: 2, status: 'current', ticketCode: 'BBB22222' });
    // Locked rows carry code + source but must NEVER leak identity ahead of validation.
    expect(res.entries[2]).toEqual({ position: 3, status: 'locked', ticketCode: 'CCC33333', entrySource: 'receipt' });
    // 40 total, current at position 2 -> 38 locked; 1 included in the window -> 37 remain.
    expect(res.lockedRemaining).toBe(37);
  });

  test('board shows locked rows past an auto-valid entry (min-prefix design, no display cutoff)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ winner_ticket_id: 11, winner_confirmed: false }] })
      .mockResolvedValueOnce({ rows: [{ total: 40 }] })
      .mockResolvedValueOnce({ rows: [
        { position: 1, ticket_id: 11, code: 'AAA11111', entry_source: 'receipt', full_name: 'Jane Doe', email: 'jane@test.com', risk_score: 1, rejected_reason: null, rejected_at: null },
        { position: 2, ticket_id: 22, code: 'BBB22222', entry_source: 'receipt', full_name: 'B', email: 'b@test.com', risk_score: 0, rejected_reason: null, rejected_at: null },
        { position: 3, ticket_id: 33, code: 'CCC33333', entry_source: 'free', full_name: 'C', email: 'c@test.com', risk_score: 0, rejected_reason: null, rejected_at: null },
        { position: 4, ticket_id: 44, code: 'DDD44444', entry_source: 'receipt', full_name: 'D', email: 'd@test.com', risk_score: 0, rejected_reason: null, rejected_at: null },
      ] });

    const res = await getDrawWinnerOrderService(1);
    // The stored prefix carries at least 70 positions regardless of auto-valid entries, so
    // the board lists everything stored - including rows past the weekly entry at position 3.
    expect(res.entries.map(e => e.position)).toEqual([1, 2, 3, 4]);
    // Locked rows still carry code + source only, auto-valid or not.
    expect(res.entries[2]).toEqual({ position: 3, status: 'locked', ticketCode: 'CCC33333', entrySource: 'free' });
    expect(res.entries[3]).toEqual({ position: 4, status: 'locked', ticketCode: 'DDD44444', entrySource: 'receipt' });
    // 39 locked total (current at 1), 3 included -> 36 beyond the window.
    expect(res.lockedRemaining).toBe(36);
  });

  test('confirmed winner reports status confirmed', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ winner_ticket_id: 22, winner_confirmed: true }] })
      .mockResolvedValueOnce({ rows: [{ total: 2 }] })
      .mockResolvedValueOnce({ rows: [
        { position: 1, ticket_id: 11, code: 'AAA11111', entry_source: 'receipt', full_name: 'Rejected Guy', email: 'rej@test.com', risk_score: 5, rejected_reason: 'fake', rejected_at: '2026-08-01T00:00:00Z' },
        { position: 2, ticket_id: 22, code: 'BBB22222', entry_source: 'free', full_name: 'Jane Doe', email: 'jane@test.com', risk_score: 1, rejected_reason: null, rejected_at: null },
      ] });

    const res = await getDrawWinnerOrderService(1);
    expect(res.entries[1]).toMatchObject({ position: 2, status: 'confirmed' });
    expect(res.lockedRemaining).toBe(0);
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
    await openDrawService(3, 1);
    const openUpdate = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("SET status = 'Open'"),
    );
    expect(openUpdate).toBeDefined();
    expect(openUpdate![0]).toMatch(/prize_revealed = TRUE/);
  });
});

// ─────────────────────────────────────────────
// adminImageDecisionService — admin approval outranks competing claims (audit P2-4)
// While a ticket sat rejected its receipt slot was released; approval must first
// silently supersede any competing claim (shadowban style) or the partial unique
// index would reject the un-quarantine. Winner tickets are never displaced.
// ─────────────────────────────────────────────
describe('adminImageDecisionService — approval supersedes competing claims (P2-4)', () => {
  const TICKET_ROW = { id: 9, activated_by_user_id: 7, draw_id: 42, image_validation_status: 'failed' };

  test('approve quarantines the competing group BEFORE un-quarantining the approved ticket', async () => {
    // pool.query serves only the immutable coord read; the whole decision runs on the txn client.
    mockQuery.mockResolvedValueOnce({ rows: [{ business_id: 3, receipt_identifier: 'RCP1' }] });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [TICKET_ROW] });        // locked lookup
      if (sql.includes('JOIN draw d ON d.winner_ticket_id')) return Promise.resolve({ rows: [] }); // no winner conflict
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await adminImageDecisionService(9, 'approve');

    const calls = mockClientQuery.mock.calls.map(([sql]) => sql as string);
    const supersedeIdx = calls.findIndex(s => s.includes('superseded_by_admin_decision'));
    const approveIdx = calls.findIndex(s => s.includes("image_validation_status = 'passed'"));
    expect(supersedeIdx).toBeGreaterThan(-1);
    expect(approveIdx).toBeGreaterThan(-1);
    // Kick first — otherwise the partial unique index rejects the approval.
    expect(supersedeIdx).toBeLessThan(approveIdx);
    // The kick displaces the whole competing group (anchor + siblings) but never winners.
    expect(calls[supersedeIdx]).toContain('COALESCE(t.anchor_ticket_id, t.id)');
    expect(calls[supersedeIdx]).toContain('winner_ticket_id');
    // The decision is wrapped in a transaction that commits.
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
  });

  test('approve fails cleanly when the competing claim already won a draw', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ business_id: 3, receipt_identifier: 'RCP1' }] });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [TICKET_ROW] });          // locked lookup
      if (sql.includes('JOIN draw d ON d.winner_ticket_id')) return Promise.resolve({ rows: [{ found: 1 }] }); // winner conflict HIT
      return Promise.resolve({ rows: [] });
    });

    await expect(adminImageDecisionService(9, 'approve')).rejects.toThrow(/already won a draw/);

    // No mutation happened and the transaction rolled back.
    const calls = mockClientQuery.mock.calls.map(([sql]) => sql as string);
    const updates = calls.filter(s => s.includes('UPDATE ticket'));
    expect(updates).toHaveLength(0);
    expect(calls).toContain('ROLLBACK');
  });
});
