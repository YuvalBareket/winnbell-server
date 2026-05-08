/**
 * Multi-entry receipt submission tests
 *
 * Covers: entryCount calculation, batchSize cap logic, draw cap narrowing,
 * business cap narrowing, shared receipt_identifier, daily DISTINCT cap,
 * and the shape of the return value.
 *
 * Mock pattern matches tickets.service.test.ts exactly.
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

jest.mock('../../risk/risk.service.js', () => ({
  evaluateUserRisk: jest.fn().mockResolvedValue({ delta: 0, totalScore: 0, level: 'low', flags: [] }),
  updateUserRiskScore: jest.fn().mockResolvedValue(undefined),
  checkDuplicateReceiptIdentifier: jest.fn().mockResolvedValue({ isDuplicate: false }),
  countsAgainstCap: jest.fn().mockReturnValue(true),
  syncUserQuarantineState: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../ocr/ocr.service.js', () => ({
  validateReceiptAsync: jest.fn(),
}));

import { submitReceiptEntryService } from '../tickets.service';
import { countsAgainstCap } from '../../risk/risk.service';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const BASE_INPUT = {
  locationId: 10,
  receiptIdentifier: 'RCP-001',
  transactionAmount: 150,
  transactionDate: new Date().toISOString().split('T')[0],
  submitterIp: '127.0.0.1',
};

/**
 * Build the standard sequence of client.query responses for a successful
 * submitReceiptEntryService call. The caller provides per-test overrides for
 * the draws/cap rows, and the mock also handles the code conflict check and
 * the INSERT loop.
 *
 * Query order inside submitReceiptEntryService (transaction path):
 *  0  BEGIN
 *  1  Single preflight CTE query — returns one row with all pre-flight fields:
 *       is_email_verified, risk_score, risk_last_flagged_at,
 *       business_id, business_name, min_transaction_amount,
 *       draw_id, draw_opened_at, settings_exists, global_entry_cap,
 *       has_conflict, daily_count, draw_count
 *  2  advisory lock SELECT
 *  3  checkDuplicateReceiptIdentifier (mocked at service level)
 *  4  evaluateUserRisk (mocked)
 *  5  updateUserRiskScore (mocked)
 *  6  syncUserQuarantineState (mocked)
 *  7  existingEntry SELECT
 *  8  bizCapCheck SELECT (when countsAgainstCap returns true AND entry_cap != null)
 *  9  code conflict check SELECT (ANY array) — 1 query for whole batch
 * 10+ INSERT ticket RETURNING id × batchSize
 * last COMMIT
 */
const buildClientResponses = (opts: {
  minTransactionAmount?: number | null;
  entryCap?: number | null;
  drawCurrentCount?: number;
  bizCurrentCount?: number;
  batchSize?: number; // how many INSERT cycles to set up
}) => {
  const {
    minTransactionAmount = null,
    entryCap = null,
    drawCurrentCount = 0,
    bizCurrentCount = 0,
    batchSize = 1,
  } = opts;

  const drawOpenedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  const responses: Array<{ rows: unknown[]; rowCount?: number | null }> = [
    { rows: [] }, // BEGIN
    {
      rows: [{
        is_email_verified: true,
        risk_score: 0,
        risk_last_flagged_at: null,
        business_id: 5,
        business_name: 'Acme',
        min_transaction_amount: minTransactionAmount,
        draw_id: 42,
        draw_opened_at: drawOpenedAt,
        // settings_exists=true + global_entry_cap=null → entry_cap=null (unlimited)
        // settings_exists=true + global_entry_cap=N   → entry_cap=N (capped)
        settings_exists: true,
        global_entry_cap: entryCap,
        has_conflict: false,
        daily_count: 0,
        draw_count: drawCurrentCount,
      }],
    }, // preflight CTE
    { rows: [] }, // advisory lock
    { rows: [] }, // existingEntry
  ];

  // bizCapCheck is only issued when entry_cap !== null (outer guard in service)
  if (entryCap !== null) {
    responses.push({ rows: [{ count: String(bizCurrentCount) }] }); // bizCapCheck
  }

  // One code conflict check query for the whole batch (ANY array)
  responses.push({ rows: [] }); // conflict check — no collisions

  // INSERT RETURNING id × batchSize
  for (let i = 0; i < batchSize; i++) {
    responses.push({ rows: [{ id: 100 + i }] }); // INSERT RETURNING id
  }

  responses.push({ rows: [] }); // COMMIT

  return responses;
};

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
  // countsAgainstCap returns true by default (already set in mock factory above)
  (countsAgainstCap as jest.Mock).mockReturnValue(true);
});

// ─────────────────────────────────────────────
// 1. entryCount = 1 when no min_transaction_amount
// ─────────────────────────────────────────────
describe('entryCount calculation', () => {
  test('earns 1 entry when min_transaction_amount is null', async () => {
    const responses = buildClientResponses({ minTransactionAmount: null, entryCap: null, batchSize: 1 });
    setupClientQueries(...responses);

    const result = await submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 150 });

    expect(result.entryCount).toBe(1);
    expect(result.tickets).toHaveLength(1);
  });

  test('earns 1 entry when min_transaction_amount is 0', async () => {
    const responses = buildClientResponses({ minTransactionAmount: 0, entryCap: null, batchSize: 1 });
    setupClientQueries(...responses);

    const result = await submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 150 });

    expect(result.entryCount).toBe(1);
    expect(result.tickets).toHaveLength(1);
  });

  test('earns 3 entries when amount=$150 and min=$50', async () => {
    const responses = buildClientResponses({ minTransactionAmount: 50, entryCap: null, batchSize: 3 });
    setupClientQueries(...responses);

    const result = await submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 150 });

    expect(result.entryCount).toBe(3);
    expect(result.tickets).toHaveLength(3);
  });

  test('earns 2 entries when amount=$100 and min=$50 (exact multiple)', async () => {
    const responses = buildClientResponses({ minTransactionAmount: 50, entryCap: null, batchSize: 2 });
    setupClientQueries(...responses);

    const result = await submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 100 });

    expect(result.entryCount).toBe(2);
    expect(result.tickets).toHaveLength(2);
  });

  test('entryCount is capped at 10 when amount is very large', async () => {
    // $5000 / $50 = 100 → capped at 10
    const responses = buildClientResponses({ minTransactionAmount: 50, entryCap: null, batchSize: 10 });
    setupClientQueries(...responses);

    const result = await submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 5000 });

    expect(result.entryCount).toBe(10);
    expect(result.tickets).toHaveLength(10);
  });
});

// ─────────────────────────────────────────────
// 2. Amount below minimum is blocked before entryCount is used
// ─────────────────────────────────────────────
describe('amount below minimum threshold', () => {
  test('throws before inserting any tickets when amount < min_transaction_amount', async () => {
    // min = $100, amount = $30 → blocked by existing check
    setupClientQueries(
      { rows: [] }, // BEGIN
      {
        rows: [{
          is_email_verified: true,
          risk_score: 0,
          risk_last_flagged_at: null,
          business_id: 5,
          business_name: 'Acme',
          min_transaction_amount: 100,
          draw_id: 42,
          draw_opened_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          settings_exists: true,
          global_entry_cap: null, // unlimited cap
          has_conflict: false,
          daily_count: 0,
          draw_count: 0,
        }],
      }, // preflight CTE
    );
    // pool.query used by updateUserRiskScore penalty inside the min check
    mockQuery.mockResolvedValue({ rows: [{ count: '0' }] });

    await expect(
      submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 30 }),
    ).rejects.toThrow('Transaction amount is not sufficient to earn an entry.');

    // Ensure no INSERT was attempted
    const insertCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO ticket'),
    );
    expect(insertCall).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// 3. batchSize is reduced to remaining draw cap
// ─────────────────────────────────────────────
describe('batchSize narrowed by draw cap', () => {
  test('user with 28 existing draw entries earning 3 gets only 2', async () => {
    // drawCurrentCount = 28, so remainingDrawEntries = 2; entryCount = 3 → batchSize = 2
    const responses = buildClientResponses({
      minTransactionAmount: 50,
      entryCap: null,
      drawCurrentCount: 28,
      batchSize: 2,
    });
    setupClientQueries(...responses);

    const result = await submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 150 });

    expect(result.entryCount).toBe(2);
    expect(result.tickets).toHaveLength(2);
  });

  test('throws when draw count is already 30 (no remaining slots)', async () => {
    setupClientQueries(
      { rows: [] }, // BEGIN
      {
        rows: [{
          is_email_verified: true,
          risk_score: 0,
          risk_last_flagged_at: null,
          business_id: 5,
          business_name: 'Acme',
          min_transaction_amount: 50,
          draw_id: 42,
          draw_opened_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          settings_exists: true,
          global_entry_cap: null, // unlimited cap
          has_conflict: false,
          daily_count: 0,
          draw_count: 30, // at draw cap
        }],
      }, // preflight CTE
    );

    await expect(
      submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 150 }),
    ).rejects.toThrow('maximum of 30 entries');
  });
});

// ─────────────────────────────────────────────
// 4. batchSize narrowed by business entry cap
// ─────────────────────────────────────────────
describe('batchSize narrowed by business entry cap', () => {
  test('batch of 3 reduced to 1 when only 1 business slot remains', async () => {
    // entry_cap = 10, bizCurrentCount = 9 → remainingBizEntries = 1
    const responses = buildClientResponses({
      minTransactionAmount: 50,
      entryCap: 10,
      drawCurrentCount: 0,
      bizCurrentCount: 9,
      batchSize: 1,
    });
    setupClientQueries(...responses);

    const result = await submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 150 });

    expect(result.entryCount).toBe(1);
    expect(result.tickets).toHaveLength(1);
  });

  test('throws when business cap is already exhausted', async () => {
    setupClientQueries(
      { rows: [] }, // BEGIN
      {
        rows: [{
          is_email_verified: true,
          risk_score: 0,
          risk_last_flagged_at: null,
          business_id: 5,
          business_name: 'Acme',
          min_transaction_amount: 50,
          draw_id: 42,
          draw_opened_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          settings_exists: true,
          global_entry_cap: 5,
          has_conflict: false,
          daily_count: 0,
          draw_count: 0,
        }],
      }, // preflight CTE
      { rows: [] },              // advisory lock
      { rows: [] },              // existingEntry
      { rows: [{ count: '5' }] }, // bizCapCheck — at cap
    );

    await expect(
      submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 150 }),
    ).rejects.toThrow('entry cap');
  });
});

// ─────────────────────────────────────────────
// 5. All tickets in a batch share the same receipt_identifier
// ─────────────────────────────────────────────
describe('receipt_identifier shared across batch', () => {
  test('all INSERT calls use the same receipt_identifier parameter', async () => {
    const responses = buildClientResponses({ minTransactionAmount: 50, entryCap: null, batchSize: 3 });
    setupClientQueries(...responses);

    await submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 150 });

    // Collect all INSERT calls
    const insertCalls = mockClientQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO ticket'),
    );

    expect(insertCalls).toHaveLength(3);

    // Only the first (anchor) ticket gets receipt_identifier; extras get null
    // to avoid the UNIQUE INDEX on (business_id, receipt_identifier)
    const identifiers = insertCalls.map(([, params]: [string, unknown[]]) => params[5]);
    expect(identifiers[0]).toBe(BASE_INPUT.receiptIdentifier);
    expect(identifiers.slice(1).every((id) => id === null)).toBe(true);
  });
});

// ─────────────────────────────────────────────
// 6. Daily cap uses COUNT(DISTINCT receipt_identifier)
// ─────────────────────────────────────────────
describe('daily cap uses DISTINCT receipt_identifier', () => {
  test('daily cap query uses COUNT(DISTINCT receipt_identifier)', async () => {
    const responses = buildClientResponses({ minTransactionAmount: null, entryCap: null, batchSize: 1 });
    setupClientQueries(...responses);

    await submitReceiptEntryService(1, BASE_INPUT);

    // The daily count is embedded in the preflight CTE query — find it there
    const preflightCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === 'string' &&
        sql.includes('receipt_identifier IS NOT NULL') &&
        sql.includes('24 hours'),
    );
    expect(preflightCall).toBeDefined();

    const [preflightSql] = preflightCall as [string];
    expect(preflightSql).toMatch(/COUNT\(DISTINCT receipt_identifier\)/i);
  });

  test('daily cap blocks at 5 distinct receipts (not 5 tickets)', async () => {
    setupClientQueries(
      { rows: [] }, // BEGIN
      {
        rows: [{
          is_email_verified: true,
          risk_score: 0,
          risk_last_flagged_at: null,
          business_id: 5,
          business_name: 'Acme',
          min_transaction_amount: null,
          draw_id: 42,
          draw_opened_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          settings_exists: true,
          global_entry_cap: null,
          has_conflict: false,
          daily_count: 5, // at daily cap
          draw_count: 0,
        }],
      }, // preflight CTE — daily_count at limit
    );

    await expect(
      submitReceiptEntryService(1, BASE_INPUT),
    ).rejects.toThrow('daily receipt submission limit');
  });
});

// ─────────────────────────────────────────────
// 7. Return value shape
// ─────────────────────────────────────────────
describe('return value shape', () => {
  test('returns { tickets: Array, entryCount } with correct length for single entry', async () => {
    const responses = buildClientResponses({ minTransactionAmount: null, entryCap: null, batchSize: 1 });
    setupClientQueries(...responses);

    const result = await submitReceiptEntryService(1, BASE_INPUT);

    expect(result).toHaveProperty('tickets');
    expect(result).toHaveProperty('entryCount');
    expect(Array.isArray(result.tickets)).toBe(true);
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]).toHaveProperty('ticketId');
    expect(result.tickets[0]).toHaveProperty('code');
    expect(result.entryCount).toBe(1);
  });

  test('returns { tickets: Array, entryCount } with correct length for multi entry', async () => {
    const responses = buildClientResponses({ minTransactionAmount: 50, entryCap: null, batchSize: 3 });
    setupClientQueries(...responses);

    const result = await submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 150 });

    expect(result.tickets).toHaveLength(3);
    expect(result.entryCount).toBe(3);
    // Each ticket must have a unique-looking id and code field
    result.tickets.forEach((t) => {
      expect(typeof t.ticketId).toBe('number');
      expect(typeof t.code).toBe('string');
    });
  });

  test('each ticket in the batch gets a distinct ticketId from RETURNING id', async () => {
    const responses = buildClientResponses({ minTransactionAmount: 50, entryCap: null, batchSize: 3 });
    setupClientQueries(...responses);

    const result = await submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 150 });

    const ids = result.tickets.map((t) => t.ticketId);
    const unique = new Set(ids);
    expect(unique.size).toBe(3);
  });
});

// ─────────────────────────────────────────────
// 8. ROLLBACK is still called on error
// ─────────────────────────────────────────────
describe('transaction safety', () => {
  test('ROLLBACK is issued when an error occurs mid-batch', async () => {
    // Succeed through to the INSERT loop (batchSize=3 for $150/$50) then fail on the 2nd INSERT
    // Query order (with entry_cap=null, so no bizCapCheck):
    //  1=BEGIN, 2=preflight CTE, 3=advisory lock, 4=existingEntry,
    //  5=code conflict check (ANY array), 6=INSERT 1st ticket,
    //  7=INSERT 2nd ticket (fails)
    let callCount = 0;
    const drawOpenedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    mockClientQuery.mockImplementation((sql: string) => {
      callCount++;
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      if (callCount === 2) return Promise.resolve({ rows: [{
        is_email_verified: true,
        risk_score: 0,
        risk_last_flagged_at: null,
        business_id: 5,
        business_name: 'Acme',
        min_transaction_amount: 50,
        draw_id: 42,
        draw_opened_at: drawOpenedAt,
        settings_exists: true,
        global_entry_cap: null, // null → entry_cap=null → no bizCapCheck
        has_conflict: false,
        daily_count: 0,
        draw_count: 0,
      }] }); // preflight CTE
      if (callCount === 3) return Promise.resolve({ rows: [] }); // advisory lock
      if (callCount === 4) return Promise.resolve({ rows: [] }); // existingEntry
      if (callCount === 5) return Promise.resolve({ rows: [] }); // code conflict check (no collisions)
      if (callCount === 6) return Promise.resolve({ rows: [{ id: 100 }] }); // INSERT 1st ticket
      if (sql.includes('INSERT INTO ticket')) return Promise.reject(new Error('DB failure on 2nd insert'));
      return Promise.resolve({ rows: [] });
    });

    await expect(
      submitReceiptEntryService(1, { ...BASE_INPUT, transactionAmount: 150 }),
    ).rejects.toThrow('DB failure on 2nd insert');

    const rollbackCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql === 'ROLLBACK',
    );
    expect(rollbackCall).toBeDefined();
  });
});
