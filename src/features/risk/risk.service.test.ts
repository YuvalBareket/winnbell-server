/**
 * Tests — risk.service.ts
 *
 * Covers: sequential guessing, rapid submission, cross-user duplicate multiplier,
 * accidental double-tap (same-user dup), and trash-picker (velocity + rapid).
 *
 * DB is mocked via jest.mock so no real connection is needed.
 */

const mockQuery = jest.fn();

jest.mock('../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockQuery }),
}));

import { evaluateUserRisk, syncUserQuarantineState } from './risk.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sets up mockQuery to return values in sequence.
 * Each call pops the next response off the array.
 * The last entry is repeated if the list is exhausted.
 */
const setupQueries = (responses: Array<{ rows: unknown[] }>) => {
  let i = 0;
  mockQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Sequential Scammer
// User submits identifiers 101, 102, 103 in quick succession.
// The 3rd submission should trigger sequential_guessing.
// ─────────────────────────────────────────────────────────────────────────────
describe('Sequential Scammer — sequential_guessing flag', () => {
  test('fires sequential_guessing when 2+ recent identifiers are within 5 of current', async () => {
    setupQueries([
      // user row: risk_score=0, last_flagged=null
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      // velocity (24h): 2 prior submissions — below high threshold
      { rows: [{ count: '2' }] },
      // rapid submission (30s): 0
      { rows: [{ count: '0' }] },
      // sequential guessing — 2 recent identifiers: "RCPT101" and "RCPT102"
      { rows: [{ receipt_identifier: 'RCPT102' }, { receipt_identifier: 'RCPT101' }] },
      // amount outlier avg
      { rows: [{ avg_amount: '50' }] },
    ]);

    const result = await evaluateUserRisk(1, {
      businessId: 10,
      receiptIdentifier: 'RCPT103',
      transactionAmount: 55,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('sequential_guessing');
    expect(result.delta).toBeGreaterThanOrEqual(4);
  });

  test('does NOT fire sequential_guessing when only 1 close neighbor exists', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '1' }] },
      { rows: [{ count: '0' }] },
      // only one neighbor close to 103
      { rows: [{ receipt_identifier: 'RCPT102' }, { receipt_identifier: 'RCPT050' }] },
      { rows: [{ avg_amount: '50' }] },
    ]);

    const result = await evaluateUserRisk(1, {
      businessId: 10,
      receiptIdentifier: 'RCPT103',
      transactionAmount: 55,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('sequential_guessing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Rapid Submission
// Two submissions within 30 seconds → rapid_submission flag.
// ─────────────────────────────────────────────────────────────────────────────
describe('Rapid Submission — rapid_submission flag', () => {
  test('fires rapid_submission when a ticket exists within the last 30 seconds', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      // velocity: 1 (below elevated threshold)
      { rows: [{ count: '1' }] },
      // rapid: 1 — one ticket in last 30s
      { rows: [{ count: '1' }] },
      // sequential: fewer than 2 rows
      { rows: [{ receipt_identifier: 'RCPT200' }] },
      { rows: [{ avg_amount: '40' }] },
    ]);

    const result = await evaluateUserRisk(2, {
      businessId: 10,
      receiptIdentifier: 'RCPT201',
      transactionAmount: 40,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('rapid_submission');
    expect(result.delta).toBeGreaterThanOrEqual(3);
  });

  test('does NOT fire rapid_submission when no ticket in last 30 seconds', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '0' }] },
      // rapid: 0
      { rows: [{ count: '0' }] },
      { rows: [] },
      { rows: [{ avg_amount: '40' }] },
    ]);

    const result = await evaluateUserRisk(2, {
      businessId: 10,
      receiptIdentifier: 'RCPT300',
      transactionAmount: 40,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('rapid_submission');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cross-user duplicate multiplier
// Low risk (score 3) → +1 (2 × 0.5, rounded)
// Medium risk (score 12) → +3 (2 × 1.5, rounded)
// Very high risk (score 16) → +4 (2 × 2, rounded)
// ─────────────────────────────────────────────────────────────────────────────
describe('Cross-user duplicate — scaled multiplier', () => {
  const runWithScore = async (storedScore: number) => {
    setupQueries([
      { rows: [{ risk_score: storedScore, risk_last_flagged_at: new Date() }] },
      // velocity: 0
      { rows: [{ count: '0' }] },
      // rapid: 0
      { rows: [{ count: '0' }] },
      // sequential: 0 rows
      { rows: [] },
      // avg amount
      { rows: [{ avg_amount: '50' }] },
    ]);

    return evaluateUserRisk(3, {
      businessId: 10,
      receiptIdentifier: 'RCPT400',
      transactionAmount: 50,
      isDuplicateCrossUser: true,
    });
  };

  test('low risk user (score 3) gets +1 from cross-user dup (2 × 0.5)', async () => {
    const result = await runWithScore(3);
    expect(result.flags).toContain('duplicate_identifier_cross_user');
    // Only the cross-user dup fires; delta should be 1
    expect(result.delta).toBe(1);
  });

  test('medium-high risk user (score 12) gets +3 from cross-user dup (2 × 1.5)', async () => {
    const result = await runWithScore(12);
    expect(result.flags).toContain('duplicate_identifier_cross_user');
    expect(result.delta).toBe(3);
  });

  test('very high risk user (score 16) gets +4 from cross-user dup (2 × 2)', async () => {
    const result = await runWithScore(16);
    expect(result.flags).toContain('duplicate_identifier_cross_user');
    expect(result.delta).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Accidental Double-Tap (same-user dup)
// A low-risk user makes a genuine duplicate — only a small risk delta fires.
// The cross-user dup check returns false (same user), so the multiplier penalty
// does not apply. evaluateUserRisk delta should be 0 (clean submission shape).
// ─────────────────────────────────────────────────────────────────────────────
describe('Accidental Double-Tap — low delta for same-user dup', () => {
  test('no cross-user dup flag fires when isDuplicateCrossUser is false', async () => {
    setupQueries([
      { rows: [{ risk_score: 2, risk_last_flagged_at: null }] },
      // velocity: 1
      { rows: [{ count: '1' }] },
      // rapid: 0
      { rows: [{ count: '0' }] },
      // sequential: 0 rows
      { rows: [] },
      { rows: [{ avg_amount: '30' }] },
    ]);

    const result = await evaluateUserRisk(4, {
      businessId: 10,
      receiptIdentifier: 'RCPT500',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('duplicate_identifier_cross_user');
    // Low-risk clean submission — delta should be 0
    expect(result.delta).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Trash Picker
// ≥7 submissions in 24h AND a ticket within 30s → both high_submission_velocity
// (+4) and rapid_submission (+3) fire together.
// ─────────────────────────────────────────────────────────────────────────────
describe('Trash Picker — velocity + rapid both fire', () => {
  test('fires high_submission_velocity and rapid_submission together', async () => {
    setupQueries([
      { rows: [{ risk_score: 5, risk_last_flagged_at: new Date() }] },
      // velocity: 8 — triggers high_submission_velocity (+4)
      { rows: [{ count: '8' }] },
      // rapid: 1 — triggers rapid_submission (+3)
      { rows: [{ count: '1' }] },
      // sequential: fewer than 2 rows
      { rows: [{ receipt_identifier: 'RCPT600' }] },
      { rows: [{ avg_amount: '20' }] },
    ]);

    const result = await evaluateUserRisk(5, {
      businessId: 10,
      receiptIdentifier: 'RCPT601',
      transactionAmount: 20,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('high_submission_velocity');
    expect(result.flags).toContain('rapid_submission');
    // 4 (velocity) + 3 (rapid) = 7 minimum delta
    expect(result.delta).toBeGreaterThanOrEqual(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Receipt slot release (audit P2-4): while a ticket sat shadowbanned its receipt
// number was released; if someone else claimed it, rehabilitation must NOT lift
// that ticket (the active claim wins). The guard lives in the lift branch's SQL.
// ─────────────────────────────────────────────────────────────────────────────
describe('syncUserQuarantineState — rehabilitation slot guard (P2-4)', () => {
  test('lift branch carries the claimed-receipt guard, keyed on the group anchor', async () => {
    setupQueries([{ rows: [] }]);

    await syncUserQuarantineState(7, 42);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Guard: skip lifting when another STANDING claim (active or OCR-pending) holds the receipt.
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain("quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review')");
    // Keyed on the receipt group's anchor so anchor + siblings lift (or stay) together.
    expect(sql).toContain('COALESCE(ticket.anchor_ticket_id, ticket.id)');
    // Winner tickets remain protected from any state change.
    expect(sql).toContain('winner_ticket_id');
    expect(params).toEqual([7, 42, 19]);
  });
});
