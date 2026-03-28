/**
 * QA/Security Tests — tickets.service.ts
 *
 * Strategy: mock getPool and sql so no DB connection is needed.
 * We test:
 *   1. activateTicket — code format guard (controller-level regex)
 *   2. activateTicket — atomic update pattern (WHERE status='Issued')
 *   3. activateFreeTicket — weekly limit enforcement inside transaction
 *   4. generateGlobalUniqueCode — loop cap (max 10 attempts, throws on exhaustion)
 */

// ---- mock the DB module ----
const mockQuery = jest.fn();
const mockInput = jest.fn();
const mockRequest = jest.fn();
const mockBegin = jest.fn();
const mockCommit = jest.fn();
const mockRollback = jest.fn();

// Build a chainable request mock
const buildRequest = () => {
  const req: Record<string, unknown> = {};
  req.input = jest.fn().mockReturnValue(req);
  req.query = mockQuery;
  return req;
};

const mockTransactionRequest = jest.fn().mockImplementation(() => buildRequest());

const mockTransaction = {
  begin: mockBegin,
  commit: mockCommit,
  rollback: mockRollback,
  request: mockTransactionRequest,
};

const mockPool = {
  request: jest.fn().mockImplementation(() => buildRequest()),
};

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue(mockPool),
  sql: {
    Transaction: jest.fn().mockImplementation(() => mockTransaction),
    VarChar: jest.fn((n: number) => `VarChar(${n})`),
    Int: 'Int',
    NVarChar: jest.fn((n?: number) => `NVarChar${n ? `(${n})` : ''}`),
  },
}));

import { activateTicket, activateFreeTicket, generateGlobalUniqueCode } from '../tickets.service';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Build a pool mock that returns specific query results in sequence. */
const setupPoolQueries = (...responses: Array<{ recordset: unknown[]; rowsAffected?: number[] }>) => {
  let callIndex = 0;
  mockQuery.mockImplementation(() => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return Promise.resolve(resp);
  });
  mockTransactionRequest.mockImplementation(() => {
    const req = buildRequest();
    (req as any).query = mockQuery;
    return req;
  });
  mockPool.request.mockImplementation(() => {
    const req = buildRequest();
    (req as any).query = mockQuery;
    return req;
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockBegin.mockResolvedValue(undefined);
  mockCommit.mockResolvedValue(undefined);
  mockRollback.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────
// 1. Input validation — controller regex (mirrors what controller enforces)
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

  test('rejects SQL injection attempt', () => {
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
      { recordset: [] }, // checkResult — ticket not found
    );
    await expect(activateTicket('ABC123', 1)).rejects.toThrow('Invalid ticket code.');
  });

  test('throws when draw is not Open', async () => {
    setupPoolQueries(
      { recordset: [{ id: 1, status: 'Issued', draw_status: 'Closed' }] },
    );
    await expect(activateTicket('ABC123', 1)).rejects.toThrow('already closed');
  });

  test('throws "already been used" when atomic UPDATE affects 0 rows (race condition guard)', async () => {
    setupPoolQueries(
      { recordset: [{ id: 1, status: 'Issued', draw_status: 'Open' }] }, // checkResult
      { recordset: [], rowsAffected: [0] },                              // updateResult — 0 rows
    );
    await expect(activateTicket('ABC123', 1)).rejects.toThrow('already been used');
  });

  test('succeeds when atomic UPDATE affects 1 row', async () => {
    setupPoolQueries(
      { recordset: [{ id: 1, status: 'Issued', draw_status: 'Open' }] }, // checkResult
      { recordset: [], rowsAffected: [1] },                              // updateResult — 1 row
    );
    const result = await activateTicket('ABC123', 1);
    expect(result.message).toBe('Ticket activated successfully!');
  });

  test('UPDATE query uses WHERE status=Issued to enforce atomicity', async () => {
    // Capture the SQL query string
    const queries: string[] = [];
    mockPool.request.mockImplementation(() => {
      const req: Record<string, unknown> = {};
      req.input = jest.fn().mockReturnValue(req);
      req.query = jest.fn().mockImplementation((sql: string) => {
        queries.push(sql);
        if (queries.length === 1) {
          return Promise.resolve({ recordset: [{ id: 1, status: 'Issued', draw_status: 'Open' }] });
        }
        return Promise.resolve({ recordset: [], rowsAffected: [1] });
      });
      return req;
    });

    await activateTicket('VALID01', 42);
    const updateQuery = queries.find(q => q.includes('UPDATE'));
    expect(updateQuery).toBeDefined();
    expect(updateQuery).toMatch(/WHERE code = @code AND status = 'Issued'/);
  });
});

// ─────────────────────────────────────────────
// 3. activateFreeTicket — weekly limit enforcement
// ─────────────────────────────────────────────
describe('activateFreeTicket — weekly limit enforcement', () => {
  test('throws "Weekly limit reached" when last usage is within 7 days', async () => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago

    mockTransactionRequest.mockImplementation(() => {
      const req: Record<string, unknown> = {};
      req.input = jest.fn().mockReturnValue(req);
      req.query = jest.fn().mockResolvedValue({
        recordset: [{ activated_at: recentDate.toISOString() }],
      });
      return req;
    });

    await expect(activateFreeTicket(1)).rejects.toThrow('Weekly limit reached');
  });

  test('proceeds past eligibility check when last usage is more than 7 days ago', async () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
    let callCount = 0;

    mockTransactionRequest.mockImplementation(() => {
      const req: Record<string, unknown> = {};
      req.input = jest.fn().mockReturnValue(req);
      req.query = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // eligibility check — old usage
          return Promise.resolve({ recordset: [{ activated_at: oldDate.toISOString() }] });
        }
        if (callCount === 2) {
          // draw lookup
          return Promise.resolve({ recordset: [{ id: 5 }] });
        }
        if (callCount === 3) {
          // insert free_ticket_usage
          return Promise.resolve({ recordset: [] });
        }
        if (callCount === 4) {
          // generateGlobalUniqueCode — uniqueness check
          return Promise.resolve({ recordset: [{ count: 0 }] });
        }
        // ticket INSERT
        return Promise.resolve({ recordset: [{ id: 99 }] });
      });
      return req;
    });

    const result = await activateFreeTicket(1);
    expect(result.success).toBe(true);
    expect(result.ticketId).toBe(99);
  });

  test('allows activation when no previous usage exists', async () => {
    let callCount = 0;

    mockTransactionRequest.mockImplementation(() => {
      const req: Record<string, unknown> = {};
      req.input = jest.fn().mockReturnValue(req);
      req.query = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ recordset: [] }); // no prior usage
        if (callCount === 2) return Promise.resolve({ recordset: [{ id: 3 }] }); // draw
        if (callCount === 3) return Promise.resolve({ recordset: [] }); // usage insert
        if (callCount === 4) return Promise.resolve({ recordset: [{ count: 0 }] }); // code unique
        return Promise.resolve({ recordset: [{ id: 77 }] }); // ticket insert
      });
      return req;
    });

    const result = await activateFreeTicket(1);
    expect(result.success).toBe(true);
  });

  test('throws when no active draw exists', async () => {
    let callCount = 0;

    mockTransactionRequest.mockImplementation(() => {
      const req: Record<string, unknown> = {};
      req.input = jest.fn().mockReturnValue(req);
      req.query = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ recordset: [] }); // no prior usage
        return Promise.resolve({ recordset: [] }); // no draw
      });
      return req;
    });

    await expect(activateFreeTicket(1)).rejects.toThrow('No active draw found');
  });

  test('rollback is called on error', async () => {
    mockTransactionRequest.mockImplementation(() => {
      const req: Record<string, unknown> = {};
      req.input = jest.fn().mockReturnValue(req);
      req.query = jest.fn().mockRejectedValue(new Error('DB failure'));
      return req;
    });

    await expect(activateFreeTicket(1)).rejects.toThrow('DB failure');
    expect(mockRollback).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// 4. generateGlobalUniqueCode — loop cap
// ─────────────────────────────────────────────
describe('generateGlobalUniqueCode — loop cap', () => {
  test('throws after 10 failed attempts (collision exhaustion)', async () => {
    // Always return count > 0 so every generated code "collides"
    mockPool.request.mockImplementation(() => {
      const req: Record<string, unknown> = {};
      req.input = jest.fn().mockReturnValue(req);
      req.query = jest.fn().mockResolvedValue({ recordset: [{ count: 1 }] });
      return req;
    });

    await expect(generateGlobalUniqueCode()).rejects.toThrow(
      'Failed to generate a unique ticket code',
    );
  });

  test('returns a code on first unique attempt', async () => {
    mockPool.request.mockImplementation(() => {
      const req: Record<string, unknown> = {};
      req.input = jest.fn().mockReturnValue(req);
      req.query = jest.fn().mockResolvedValue({ recordset: [{ count: 0 }] });
      return req;
    });

    const code = await generateGlobalUniqueCode();
    expect(code).toHaveLength(8);
    expect(/^[A-Z0-9]{8}$/.test(code)).toBe(true);
  });

  test('retries and succeeds on second attempt', async () => {
    let attempt = 0;
    mockPool.request.mockImplementation(() => {
      const req: Record<string, unknown> = {};
      req.input = jest.fn().mockReturnValue(req);
      req.query = jest.fn().mockImplementation(() => {
        attempt++;
        // First call collides, second is free
        return Promise.resolve({ recordset: [{ count: attempt === 1 ? 1 : 0 }] });
      });
      return req;
    });

    const code = await generateGlobalUniqueCode();
    expect(code).toHaveLength(8);
  });
});
