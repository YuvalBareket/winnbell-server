/**
 * Tests — admin threshold override (updateBusinessThresholdService)
 *
 * Covers:
 *   - live threshold: UPDATE business.min_transaction_amount, 404 on unknown business
 *   - campaign snapshot: UPDATE draw_entry.min_transaction_at_entry scoped to the OPEN
 *     draw, 400 when the business has no open-draw enrollment
 *   - both knobs in one call issue both UPDATEs
 *   - owner's pending_min_transaction_amount is NEVER touched (admin override must not
 *     silently clear a queued owner change)
 *   - numeric strings from pg are parsed to numbers in the returned state
 *
 * Mock pattern: pool.query(sql, params) -> { rows, rowCount } (same as draw-entry-pause)
 */

// ── mock the DB module before any imports ────────────────────────────────────
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

// transitive stubs required by admin.service
jest.mock('../../tickets/tickets.service.js', () => ({
  generateGlobalUniqueCode: jest.fn().mockResolvedValue('TESTCODE'),
}));
jest.mock('../../risk/risk.service.js', () => ({
  decayAllUserRiskScores: jest.fn().mockResolvedValue({ unquarantinedUserIds: [] }),
  updateUserRiskScore: jest.fn().mockResolvedValue(undefined),
  syncUserQuarantineState: jest.fn().mockResolvedValue(undefined),
  evaluateUserRisk: jest.fn().mockResolvedValue({ delta: 0, totalScore: 0, level: 'low', flags: [] }),
  checkDuplicateReceiptIdentifier: jest.fn().mockResolvedValue({ isDuplicate: false }),
  countsAgainstCap: jest.fn().mockReturnValue(true),
}));
jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
  sendFoundingFinalCampaignEmail: jest.fn(),
}));
jest.mock('../../ocr/ocr.service.js', () => ({
  validateReceiptAsync: jest.fn(),
}));

import { updateBusinessThresholdService } from '../admin.service';
import { publicCache } from '../../../shared/cache/cache.js';

const stateRow = {
  min_transaction_amount: '25.00',
  pending_min_transaction_amount: null as string | null,
  open_draw_min_transaction: null as string | null,
};

const setupPoolQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  publicCache.flushAll();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('updateBusinessThresholdService — live threshold', () => {
  test('updates business.min_transaction_amount and returns parsed state', async () => {
    setupPoolQueries(
      { rows: [], rowCount: 1 },       // UPDATE business
      { rows: [stateRow], rowCount: 1 }, // state SELECT
    );
    const result = await updateBusinessThresholdService(7, { minTransactionAmount: 25 });

    const updateCall = mockQuery.mock.calls[0];
    expect(updateCall[0]).toContain('UPDATE business');
    expect(updateCall[0]).toContain('min_transaction_amount');
    expect(updateCall[1]).toEqual([25, 7]);
    expect(result).toEqual({
      min_transaction_amount: 25,
      pending_min_transaction_amount: null,
      open_draw_min_transaction: null,
    });
  });

  test('throws 404 when the business does not exist', async () => {
    setupPoolQueries({ rows: [], rowCount: 0 }); // UPDATE business matches nothing
    await expect(updateBusinessThresholdService(999, { minTransactionAmount: 25 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  test('never touches the owner pending_min_transaction_amount', async () => {
    setupPoolQueries(
      { rows: [], rowCount: 1 },
      { rows: [{ ...stateRow, pending_min_transaction_amount: '30.00' }], rowCount: 1 },
    );
    const result = await updateBusinessThresholdService(7, { minTransactionAmount: 25 });
    // No issued query may write the pending column (SELECTing it back is fine).
    for (const [sql] of mockQuery.mock.calls) {
      expect(String(sql)).not.toMatch(/SET[\s\S]*pending_min_transaction_amount/);
    }
    // And the queued owner change is surfaced, not cleared.
    expect(result.pending_min_transaction_amount).toBe(30);
  });
});

describe('updateBusinessThresholdService — campaign snapshot', () => {
  test('updates draw_entry.min_transaction_at_entry scoped to the Open draw', async () => {
    setupPoolQueries(
      { rows: [], rowCount: 1 }, // UPDATE draw_entry
      { rows: [{ ...stateRow, open_draw_min_transaction: '40.00' }], rowCount: 1 },
    );
    const result = await updateBusinessThresholdService(7, { drawEntryMinTransaction: 40 });

    const updateCall = mockQuery.mock.calls[0];
    expect(updateCall[0]).toContain('UPDATE draw_entry');
    expect(updateCall[0]).toContain('min_transaction_at_entry');
    expect(updateCall[0]).toContain(`d.status = 'Open'`);
    expect(updateCall[1]).toEqual([40, 7]);
    expect(result.open_draw_min_transaction).toBe(40);
  });

  test('throws 400 when the business is not enrolled in an open draw', async () => {
    setupPoolQueries({ rows: [], rowCount: 0 }); // UPDATE draw_entry matches nothing
    await expect(updateBusinessThresholdService(7, { drawEntryMinTransaction: 40 }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('updateBusinessThresholdService — both knobs', () => {
  test('issues both UPDATEs in one call', async () => {
    setupPoolQueries(
      { rows: [], rowCount: 1 }, // UPDATE business
      { rows: [], rowCount: 1 }, // UPDATE draw_entry
      { rows: [{ min_transaction_amount: '25.00', pending_min_transaction_amount: null, open_draw_min_transaction: '25.00' }], rowCount: 1 },
    );
    const result = await updateBusinessThresholdService(7, { minTransactionAmount: 25, drawEntryMinTransaction: 25 });

    expect(mockQuery.mock.calls[0][0]).toContain('UPDATE business');
    expect(mockQuery.mock.calls[1][0]).toContain('UPDATE draw_entry');
    expect(result.min_transaction_amount).toBe(25);
    expect(result.open_draw_min_transaction).toBe(25);
  });
});
