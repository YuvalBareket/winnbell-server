/**
 * Behavioral tests for the async OCR resolution path (ocr.service.ts), pinning the
 * 2026-08-20 receipt-core review fixes:
 *   B  - a cross-day claim whose scan printed NO legible date is HELD for review
 *        ('date_unreadable_review'), not silently quarantined as a duplicate.
 *   D1 - the negative OCR reputation reward is DEFERRED: it only applies once the account
 *        holds a clean-entry streak (laundering guard); penalties always apply.
 *   D2 - several image-verified receipts from one business inside 24h raises an
 *        admin-visible flag on the ticket and the user - never a score change.
 *
 * Mock pattern: SQL-routing mocks - client.query(sql) is answered by substring match, so
 * the tests assert on the WRITES the resolution makes rather than on call ordering.
 */

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockClient = { query: mockClientQuery, release: mockRelease };

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue(mockClient),
  }),
}));

const mockUpdateUserRiskScore = jest.fn();
const mockSyncUserQuarantineState = jest.fn();
jest.mock('../../risk/risk.service.js', () => ({
  updateUserRiskScore: (...a: unknown[]) => mockUpdateUserRiskScore(...a),
  syncUserQuarantineState: (...a: unknown[]) => mockSyncUserQuarantineState(...a),
}));

const mockValidate = jest.fn();
jest.mock('../providers/google-vision.provider.js', () => ({
  GoogleVisionProvider: jest.fn().mockImplementation(() => ({ validate: mockValidate })),
}));
jest.mock('../providers/gemini-vision.provider.js', () => ({
  GeminiVisionProvider: jest.fn().mockImplementation(() => ({ validate: mockValidate })),
}));

const mockRecordFunnelEvent = jest.fn();
jest.mock('../../analytics/analytics.service.js', () => ({
  recordFunnelEvent: (...a: unknown[]) => mockRecordFunnelEvent(...a),
}));

import { validateReceiptAsync } from '../ocr.service';
import type { OcrValidationResult } from '../ocr.types';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const TICKET_ID = 501;
const USER_ID = 7;
const DRAW_ID = 42;
const BUSINESS_ID = 3;

const ocrResult = (overrides: Partial<OcrValidationResult> = {}): OcrValidationResult => ({
  isReceipt: true,
  identifierFound: true,
  amountMatches: true,
  dateMatches: true,
  businessNameFound: true,
  confidence: 'high',
  // No rawText: the LLM judgment layer (own test suite) is skipped entirely.
  ...overrides,
});

interface RouteFixture {
  /** Rows for the date-ladder claims query (other standing claims on this number). */
  claims?: Array<Record<string, unknown>>;
  /** The user's risk_clean_entries streak (D1 gate). */
  cleanStreak?: number;
  /** COUNT of image-verified receipts at this business in 24h (D2 signal). */
  verified24h?: number;
}

/** Route every query by SQL substring; anything unrouted gets an empty result. */
const setupRoutes = ({ claims = [], cleanStreak = 0, verified24h = 1 }: RouteFixture = {}) => {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('quarantine_reason, business_id')) {
      return Promise.resolve({
        rows: [{ quarantine_reason: null, business_id: BUSINESS_ID, receipt_identifier: 'RCP1' }],
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  mockClientQuery.mockImplementation((sql: string) => {
    if (sql.includes('FOR UPDATE')) {
      return Promise.resolve({ rows: [{ image_validation_status: 'pending' }] });
    }
    if (sql.includes('AS tx_date')) {
      return Promise.resolve({ rows: [{ tx_date: '2026-08-19', transaction_amount: '20.00' }] });
    }
    if (sql.includes('AS same_day')) {
      return Promise.resolve({ rows: claims });
    }
    if (sql.includes('risk_clean_entries')) {
      return Promise.resolve({ rows: [{ risk_clean_entries: cleanStreak }] });
    }
    if (sql.includes("INTERVAL '24 hours'")) {
      return Promise.resolve({ rows: [{ cnt: verified24h }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
};

const runValidation = async (result: OcrValidationResult) => {
  mockValidate.mockResolvedValue(result);
  validateReceiptAsync(TICKET_ID, USER_ID, DRAW_ID, 'https://img.example/receipt.jpg', {
    identifier: 'RCP1', amount: 20, date: '2026-08-19', businessName: 'Joes Diner',
  });
  // validateReceiptAsync runs on setImmediate; drain the macrotask queue until it finishes.
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

const clientSqls = () => mockClientQuery.mock.calls.map(([sql]) => sql as string);
const poolSqls = () => mockQuery.mock.calls.map(([sql]) => sql as string);

/** The whole run must resolve cleanly - never fall into the ocr_error catch path. */
const expectNoOcrError = () => {
  expect(poolSqls().some((s) => s.includes("'ocr_error'"))).toBe(false);
  expect(clientSqls()).toContain('COMMIT');
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OCR_PROVIDER;
});

// An image-backed verified claim on ANOTHER day of the same receipt number (the Toast
// daily-reset scenario: Monday's "Check #12" is live, this entry claims Tuesday).
const OTHER_DAY_CLAIM = {
  id: 77, same_day: false, verified: true, typed_only: false, amount: '20.00', receipt_doc_seq: 0,
};

// ─────────────────────────────────────────────
// B - unreadable date on a cross-day claim → HELD, not duplicate
// ─────────────────────────────────────────────
describe('date ladder - unreadable printed date on a cross-day claim (review issue B)', () => {
  it('holds the entry as date_unreadable_review: passed status, no penalty, no reward', async () => {
    setupRoutes({ claims: [OTHER_DAY_CLAIM] });
    await runValidation(ocrResult({ dateMatches: null }));

    const sqls = clientSqls();
    // Held under the distinct countable reason, anchor + siblings together.
    const holdIdx = sqls.findIndex((s) => s.includes("'date_unreadable_review'"));
    expect(holdIdx).toBeGreaterThan(-1);
    expect(sqls[holdIdx]).toContain('anchor_ticket_id');
    // Truthful content status: everything legible matched the claim.
    expect(sqls.some((s) => s.includes("SET image_validation_status = 'passed'"))).toBe(true);
    // NOT the duplicate-document path, and no fraud flag.
    expect(sqls.some((s) => s.includes('duplicate_document'))).toBe(false);
    // No penalty and no reward - the user's score is untouched.
    expect(mockUpdateUserRiskScore).not.toHaveBeenCalled();
    // Held, not cleared: the funnel records the outcome with the held marker.
    expect(mockRecordFunnelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'submission_ocr_rejected',
        meta: expect.objectContaining({ held: 'date_unreadable' }),
      }),
    );
    expectNoOcrError();
  });

  it('a VERIFIED printed date still passes and owns its per-day slot (no hold)', async () => {
    setupRoutes({ claims: [OTHER_DAY_CLAIM], cleanStreak: 10 });
    await runValidation(ocrResult({ dateMatches: true }));

    const sqls = clientSqls();
    expect(sqls.some((s) => s.includes("'date_unreadable_review'"))).toBe(false);
    expect(sqls.some((s) => s.includes('duplicate_document'))).toBe(false);
    // Normal pass write (status + delta together) ran.
    expect(sqls.some((s) => s.includes('risk_score_delta = risk_score_delta + $2'))).toBe(true);
    expectNoOcrError();
  });
});

// ─────────────────────────────────────────────
// D1 - deferred OCR reputation reward (laundering guard)
// ─────────────────────────────────────────────
describe('deferred OCR reward (review issue D1)', () => {
  const passUpdateCall = () =>
    mockClientQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("image_validation_status = 'passed', risk_score_delta"));

  it('a low-clean-streak account earns 0, on both the ticket and the user score', async () => {
    setupRoutes({ cleanStreak: 2 });
    await runValidation(ocrResult()); // full pass -> raw riskDelta -3

    const call = passUpdateCall();
    expect(call).toBeDefined();
    expect((call as unknown[])[1]).toEqual([TICKET_ID, 0, null]); // applied delta 0, no doc_seq
    // No user-score call at all: a delta-0 call would double count a "clean entry".
    expect(mockUpdateUserRiskScore).not.toHaveBeenCalled();
    expectNoOcrError();
  });

  it('an account at the clean streak threshold earns the full -3', async () => {
    setupRoutes({ cleanStreak: 6 });
    await runValidation(ocrResult());

    const call = passUpdateCall();
    expect((call as unknown[])[1]).toEqual([TICKET_ID, -3, null]);
    expect(mockUpdateUserRiskScore).toHaveBeenCalledWith(USER_ID, -3, mockClient);
    expectNoOcrError();
  });

  it('a FAILED validation still applies the +2 penalty regardless of streak', async () => {
    setupRoutes({ cleanStreak: 0 });
    await runValidation(ocrResult({ amountMatches: false })); // contradicted -> fail

    expect(mockUpdateUserRiskScore).toHaveBeenCalledWith(USER_ID, 2, mockClient);
    expect(clientSqls().some((s) => s.includes("'ocr_validation_failed'"))).toBe(true);
    expectNoOcrError();
  });

  it('a PARTIAL pass (-1) is deferred the same way as a full pass', async () => {
    setupRoutes({ cleanStreak: 2 });
    await runValidation(ocrResult({ businessNameFound: null })); // partial -> raw -1

    expect((passUpdateCall() as unknown[])[1]).toEqual([TICKET_ID, 0, null]);
    expect(mockUpdateUserRiskScore).not.toHaveBeenCalled();
    expectNoOcrError();
  });

  it('the CONTEST-won path defers the reward identically', async () => {
    // The contest resolver is a separate transaction (resolveReceiptContest); pin that its
    // won-branch promote also writes the gated delta, not the raw one.
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('quarantine_reason, business_id')) {
        return Promise.resolve({
          rows: [{ quarantine_reason: 'contest_pending', business_id: BUSINESS_ID, receipt_identifier: 'RCP1' }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve({
          rows: [{ quarantine_reason: 'contest_pending', tx_date: '2026-08-19', transaction_amount: '20.00' }],
        });
      }
      if (sql.includes('JOIN draw d ON d.winner_ticket_id')) return Promise.resolve({ rows: [] });
      if (sql.includes("image_validation_status = 'passed' AS verified")) return Promise.resolve({ rows: [] });
      if (sql.includes('risk_clean_entries')) return Promise.resolve({ rows: [{ risk_clean_entries: 1 }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    // Full pass + businessName/amount confirmed -> contestProven -> won (no other standing claims).
    await runValidation(ocrResult());

    const promote = mockClientQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("image_validation_status = 'passed', risk_score_delta"));
    expect(promote).toBeDefined();
    expect((promote as unknown[])[1]).toEqual([TICKET_ID, 0, null]); // deferred, streak 1 < 6
    expect(mockUpdateUserRiskScore).not.toHaveBeenCalled();
    expectNoOcrError();
  });
});

// ─────────────────────────────────────────────
// D2 - same-business velocity flag (receipt-farming signature)
// ─────────────────────────────────────────────
describe('same-business velocity flag (review issue D2)', () => {
  const flagSqls = () => clientSqls().filter((s) => s.includes('array_append'));

  it('3 verified receipts at one business in 24h flags the ticket AND the user', async () => {
    setupRoutes({ cleanStreak: 10, verified24h: 3 });
    await runValidation(ocrResult());

    const flags = flagSqls();
    expect(flags.some((s) => s.startsWith('UPDATE ticket') || s.includes('UPDATE ticket'))).toBe(true);
    expect(flags.some((s) => s.includes('UPDATE "user"'))).toBe(true);
    // Every flag write is the velocity flag, passed as a parameter, dup-guarded.
    for (const [sql, params] of mockClientQuery.mock.calls.filter(([s]) => (s as string).includes('array_append'))) {
      expect(sql).toContain('@> ARRAY[$2::text]'); // idempotent append guard
      expect((params as unknown[])[1]).toBe('same_business_receipt_velocity');
    }
    // FLAG ONLY: no score change beyond the normal pass reward.
    expect(mockUpdateUserRiskScore).toHaveBeenCalledTimes(1);
    expect(mockUpdateUserRiskScore).toHaveBeenCalledWith(USER_ID, -3, mockClient);
    expectNoOcrError();
  });

  it('below the threshold no flag is written', async () => {
    setupRoutes({ cleanStreak: 10, verified24h: 2 });
    await runValidation(ocrResult());

    expect(flagSqls()).toHaveLength(0);
    expectNoOcrError();
  });
});
