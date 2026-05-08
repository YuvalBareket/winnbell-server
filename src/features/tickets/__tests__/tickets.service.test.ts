/**
 * QA/Security Tests — tickets.service.ts (PostgreSQL)
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

// risk / ocr dependencies touch the DB too — stub them out entirely
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

import { activateTicket, activateFreeTicket, generateGlobalUniqueCode } from '../tickets.service';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Sequence of responses for pool.query (non-transaction path). */
const setupPoolQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
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
});

// ─────────────────────────────────────────────
// 1. Input validation — controller regex
// ─────────────────────────────────────────────
describe('Ticket code format validation (controller regex)', () => {
  const CODE_REGEX = /^[A-Z0-9]{6,8}$/;

  test('accepts 6-char alphanumeric code', () => {
    expect(CODE_REGEX.test('ABC123')).toBe(true);
  });

  test('accepts 8-char alphanumeric code', () => {
    expect(CODE_REGEX.test('ABCD1234')).toBe(true);
  });

  test('rejects code with special characters', () => {
    expect(CODE_REGEX.test('INVALID!!!')).toBe(false);
  });

  test('rejects SQL injection attempt in code field', () => {
    expect(CODE_REGEX.test('ABC"; DROP TABLE ticket; --')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(CODE_REGEX.test('')).toBe(false);
  });

  test('rejects lowercase letters', () => {
    expect(CODE_REGEX.test('abc123')).toBe(false);
  });

  test('rejects code shorter than 6 chars', () => {
    expect(CODE_REGEX.test('AB12')).toBe(false);
  });

  test('rejects code longer than 8 chars', () => {
    expect(CODE_REGEX.test('ABCD12345')).toBe(false);
  });
});

// ─────────────────────────────────────────────
// 2. activateTicket — atomic update pattern
// ─────────────────────────────────────────────
describe('activateTicket — atomic update pattern', () => {
  test('throws "Invalid ticket code" when ticket not found', async () => {
    setupPoolQueries(
      { rows: [] }, // ticket SELECT — not found
    );
    await expect(activateTicket('ABC123', 1)).rejects.toThrow('Invalid ticket code.');
  });

  test('throws when draw is not Open', async () => {
    setupPoolQueries(
      { rows: [{ id: 1, status: 'Issued', business_id: 5, location_id: 2, draw_status: 'Closed' }] },
    );
    await expect(activateTicket('ABC123', 1)).rejects.toThrow('already closed');
  });

  test('throws "Business owners and managers cannot activate" when owner check hits a row', async () => {
    setupPoolQueries(
      { rows: [{ id: 1, status: 'Issued', business_id: 5, location_id: 2, draw_status: 'Open' }] },
      { rows: [{ '?column?': 1 }] }, // ownerCheck returns a row → owner
    );
    await expect(activateTicket('ABC123', 1)).rejects.toThrow('Business owners and managers cannot activate');
  });

  test('throws "already been used" when atomic UPDATE affects 0 rows (race condition guard)', async () => {
    setupPoolQueries(
      { rows: [{ id: 1, status: 'Issued', business_id: 5, location_id: 2, draw_status: 'Open' }] },
      { rows: [] },                // ownerCheck — not an owner
      { rows: [{ count: '0' }] }, // draw cap check — under limit
      { rows: [], rowCount: 0 },  // UPDATE — 0 rows affected
    );
    await expect(activateTicket('ABC123', 1)).rejects.toThrow('already been used');
  });

  test('succeeds when atomic UPDATE affects 1 row', async () => {
    setupPoolQueries(
      { rows: [{ id: 1, status: 'Issued', business_id: 5, location_id: 2, draw_status: 'Open' }] },
      { rows: [] },                // ownerCheck — not an owner
      { rows: [{ count: '0' }] }, // draw cap check — under limit
      { rows: [], rowCount: 1 },  // UPDATE — 1 row affected
    );
    const result = await activateTicket('ABC123', 1);
    expect(result.message).toBe('Ticket activated successfully!');
  });

  test('UPDATE query uses WHERE status = Issued to enforce atomicity', async () => {
    const capturedSqls: string[] = [];
    mockQuery.mockImplementation((sql: string) => {
      capturedSqls.push(sql);
      const n = capturedSqls.length;
      if (n === 1) return Promise.resolve({ rows: [{ id: 1, status: 'Issued', business_id: 5, location_id: 2, draw_status: 'Open' }] });
      if (n === 2) return Promise.resolve({ rows: [] }); // ownerCheck
      if (n === 3) return Promise.resolve({ rows: [{ count: '0' }] }); // draw cap check
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await activateTicket('VALID001', 42);
    const updateSql = capturedSqls.find(q => q.includes('UPDATE'));
    expect(updateSql).toBeDefined();
    expect(updateSql).toMatch(/status = 'Issued'/);
  });
});

// ─────────────────────────────────────────────
// 3. activateFreeTicket — weekly limit enforcement
// ─────────────────────────────────────────────
describe('activateFreeTicket — weekly limit enforcement', () => {
  /**
   * The service calls client.query in this order:
   *   0: BEGIN
   *   1: eligibility SELECT (FOR UPDATE)
   *   2: draw SELECT
   *   3: draw cap SELECT (COUNT tickets for user in draw)
   *   4: INSERT free_ticket_usage
   *   5: generateGlobalUniqueCode — SELECT COUNT(*) FROM ticket WHERE code = $1
   *   6: INSERT ticket RETURNING id
   *   7: COMMIT
   */

  test('throws "Weekly limit reached" when last usage is within the current calendar week', async () => {
    // A date that is within the current week (today)
    const recentDate = new Date().toISOString();
    const oldAccountDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    setupClientQueries(
      { rows: [] },                                   // BEGIN
      { rows: [{ activated_at: recentDate, is_email_verified: true, account_created_at: oldAccountDate }] }, // eligibility — used this week
    );
    await expect(activateFreeTicket(1)).rejects.toThrow('Weekly limit reached');
    // ROLLBACK must be issued on any thrown error
    const rollbackCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql === 'ROLLBACK',
    );
    expect(rollbackCall).toBeDefined();
  });

  test('throws "No active draw found" when no open draw exists', async () => {
    setupClientQueries(
      { rows: [] },  // BEGIN
      { rows: [] },  // eligibility — no prior usage
      { rows: [] },  // draw SELECT — no open draw
    );
    await expect(activateFreeTicket(1)).rejects.toThrow('No active campaign found');
  });

  test('succeeds when user has never activated a free ticket', async () => {
    setupClientQueries(
      { rows: [] },                 // BEGIN
      { rows: [] },                 // eligibility — no prior usage
      { rows: [{ id: 5 }] },       // draw SELECT
      { rows: [{ count: '0' }] },  // draw cap check — under limit
      { rows: [] },                 // INSERT free_ticket_usage
      { rows: [{ count: '0' }] },  // generateGlobalUniqueCode uniqueness check
      { rows: [{ id: 77 }] },      // INSERT ticket RETURNING id
      { rows: [] },                 // COMMIT
    );
    const result = await activateFreeTicket(1);
    expect(result.success).toBe(true);
    expect(result.ticketId).toBe(77);
  });

  test('proceeds when last free ticket was used more than 7 days ago (different calendar week)', async () => {
    // Use a date guaranteed to be in a prior week: 14 days ago
    const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const oldAccountDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    setupClientQueries(
      { rows: [] },                               // BEGIN
      { rows: [{ activated_at: oldDate, is_email_verified: true, account_created_at: oldAccountDate }] }, // eligibility — old, not this week
      { rows: [{ id: 3 }] },                      // draw SELECT
      { rows: [{ count: '0' }] },                 // draw cap check — under limit
      { rows: [] },                               // INSERT free_ticket_usage
      { rows: [{ count: '0' }] },                 // uniqueness check
      { rows: [{ id: 99 }] },                     // INSERT ticket RETURNING id
      { rows: [] },                               // COMMIT
    );
    const result = await activateFreeTicket(1);
    expect(result.success).toBe(true);
    expect(result.ticketId).toBe(99);
  });

  test('ROLLBACK is called when an unexpected error occurs mid-transaction', async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
      return Promise.reject(new Error('DB failure'));
    });
    await expect(activateFreeTicket(1)).rejects.toThrow('DB failure');
    const rollbackCalls = mockClientQuery.mock.calls.filter(
      ([sql]: [string]) => sql === 'ROLLBACK',
    );
    expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('client.release() is always called (finally block)', async () => {
    setupClientQueries(
      { rows: [] }, // BEGIN
      { rows: [] }, // eligibility
      { rows: [] }, // draw — no open draw → throws
    );
    await expect(activateFreeTicket(1)).rejects.toThrow();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// 3b. Per-draw 30-entry cap
// ─────────────────────────────────────────────
describe('Per-draw 30-entry cap enforcement', () => {
  test('activateTicket throws "maximum of 30 entries" when user is at cap', async () => {
    setupPoolQueries(
      { rows: [{ id: 1, status: 'Issued', business_id: 5, location_id: 2, draw_status: 'Open' }] },
      { rows: [] },                 // ownerCheck — not an owner
      { rows: [{ count: '30' }] }, // draw cap check — at limit
    );
    await expect(activateTicket('ABC123', 1)).rejects.toThrow('maximum of 30 entries');
  });

  test('activateFreeTicket throws "maximum of 30 entries" when user is at cap', async () => {
    setupClientQueries(
      { rows: [] },                          // BEGIN
      { rows: [] },                          // eligibility — no prior usage
      { rows: [{ id: 5 }] },                // draw SELECT
      { rows: [{ total_count: '30' }] },    // draw cap check — at limit
    );
    await expect(activateFreeTicket(1)).rejects.toThrow('maximum of 30 entries');
  });
});

// ─────────────────────────────────────────────
// 4. generateGlobalUniqueCode — loop cap
// ─────────────────────────────────────────────
describe('generateGlobalUniqueCode — loop cap and uniqueness', () => {
  test('throws after 10 failed attempts (collision exhaustion)', async () => {
    // Every uniqueness check returns count > 0 → collision every time
    mockQuery.mockResolvedValue({ rows: [{ count: '1' }] });
    await expect(generateGlobalUniqueCode()).rejects.toThrow(
      'Failed to generate a unique ticket code',
    );
    expect(mockQuery).toHaveBeenCalledTimes(10);
  });

  test('returns an 8-char alphanumeric code on first unique attempt', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    const code = await generateGlobalUniqueCode();
    expect(code).toHaveLength(8);
    expect(/^[A-Z0-9]{8}$/.test(code)).toBe(true);
  });

  test('retries and succeeds on second attempt after one collision', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // collision
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // unique
    const code = await generateGlobalUniqueCode();
    expect(code).toHaveLength(8);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test('uses provided client instead of pool when a client is passed', async () => {
    const dedicatedClient = { query: jest.fn().mockResolvedValue({ rows: [{ count: '0' }] }) };
    const code = await generateGlobalUniqueCode(dedicatedClient as any);
    expect(code).toHaveLength(8);
    // client.query should have been called, NOT the pool mockQuery
    expect(dedicatedClient.query).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
