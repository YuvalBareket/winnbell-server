/**
 * Tests — risk.service.ts (PostgreSQL)
 *
 * Covers: sequential guessing, rapid submission, cross-user duplicate multiplier,
 * accidental double-tap (same-user dup), trash-picker (velocity + rapid),
 * weekly decay, amount outlier, and sustained velocity signals.
 *
 * DB is mocked via jest.mock so no real connection is needed.
 *
 * Query order for evaluateUserRisk (with full context):
 *   1. user SELECT (risk_score, risk_last_flagged_at)
 *   2. [optional] decay UPDATE (only when score > 0 and lastFlagged >= 7 days ago)
 *   3. velocity 24h SELECT (submissions — receipt_identifier IS NOT NULL)
 *   4. weekly 7d SELECT (sustained weekly velocity)
 *   5. monthly 30d SELECT (sustained monthly volume)
 *   6. rapid SELECT (tickets in 30 s at same business)
 *   7. sequential SELECT (recent identifiers)
 *   8. threshold probe SELECT (same identifier, different amount)
 *   9. amount avg SELECT
 */

const mockQuery = jest.fn();

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockQuery }),
}));

import { evaluateUserRisk } from '../risk.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sets up mockQuery to return values in sequence.
 * The last entry repeats if the list is exhausted.
 */
const setupQueries = (responses: Array<{ rows: unknown[] }>) => {
  let i = 0;
  mockQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

/**
 * Convenience: build the standard 8-query sequence for a clean submission
 * with no flags, given a starting stored score and last-flagged date.
 *
 * Query order (no decay):
 *   0: user SELECT
 *   1: velocity 24h SELECT
 *   2: weekly 7d SELECT
 *   3: monthly 30d SELECT
 *   4: rapid SELECT
 *   5: sequential SELECT
 *   6: threshold probe SELECT
 *   7: avg amount SELECT
 */
const cleanSequence = (
  storedScore: number,
  lastFlagged: Date | null,
  velocityCount: number,
  rapidCount: number,
  seqRows: { receipt_identifier: string }[],
  avgAmount: number,
): Array<{ rows: unknown[] }> => [
  { rows: [{ risk_score: storedScore, risk_last_flagged_at: lastFlagged }] },
  { rows: [{ count: String(velocityCount), distinct_businesses: '1' }] }, // 24h
  { rows: [{ count: '0' }] },                                              // 7d
  { rows: [{ count: '0' }] },                                              // 30d
  { rows: [{ count: String(rapidCount) }] },                               // rapid
  { rows: seqRows },                                                        // sequential
  { rows: [{ count: '0' }] },                                              // threshold probe
  { rows: [{ avg_amount: String(avgAmount) }] },                           // avg
];

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Sequential Scammer — sequential_guessing flag
// The service fires the flag when closeCount >= 3 (three neighbors within 5)
// ─────────────────────────────────────────────────────────────────────────────
describe('Sequential Scammer — sequential_guessing flag', () => {
  test('fires sequential_guessing when 3+ recent identifiers are within 5 of current', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '2', distinct_businesses: '1' }] }, // 24h velocity
      { rows: [{ count: '0' }] },                            // 7d
      { rows: [{ count: '0' }] },                            // 30d
      { rows: [{ count: '0' }] },                            // rapid
      // 3 neighbors close to RCPT105 (100, 101, 102 — all within 5)
      {
        rows: [
          { receipt_identifier: 'RCPT102' },
          { receipt_identifier: 'RCPT101' },
          { receipt_identifier: 'RCPT100' },
        ],
      },
      { rows: [{ count: '0' }] }, // threshold probe
      { rows: [{ avg_amount: '50' }] },
    ]);

    const result = await evaluateUserRisk(1, {
      businessId: 10,
      receiptIdentifier: 'RCPT105',
      transactionAmount: 55,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('sequential_guessing');
    expect(result.delta).toBeGreaterThanOrEqual(4);
  });

  test('does NOT fire sequential_guessing when only 2 close neighbors exist (threshold is 3)', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '1', distinct_businesses: '1' }] }, // 24h
      { rows: [{ count: '0' }] },                            // 7d
      { rows: [{ count: '0' }] },                            // 30d
      { rows: [{ count: '0' }] },                            // rapid
      // Only 2 neighbors close to RCPT103
      { rows: [{ receipt_identifier: 'RCPT102' }, { receipt_identifier: 'RCPT101' }] },
      { rows: [{ count: '0' }] }, // threshold probe
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
// 2. Rapid Submission — rapid_submission flag
// ─────────────────────────────────────────────────────────────────────────────
describe('Rapid Submission — rapid_submission flag', () => {
  test('fires rapid_submission when a ticket at same business exists within 30 seconds', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '1', distinct_businesses: '1' }] }, // 24h
      { rows: [{ count: '0' }] },                            // 7d
      { rows: [{ count: '0' }] },                            // 30d
      { rows: [{ count: '1' }] },                            // rapid — 1 in last 30 s
      { rows: [{ receipt_identifier: 'RCPT200' }] },         // only 1 row — too few for seq check
      { rows: [{ count: '0' }] },                            // threshold probe
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

  test('does NOT fire rapid_submission when no ticket within 30 seconds', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '0', distinct_businesses: '0' }] }, // 24h
      { rows: [{ count: '0' }] },                            // 7d
      { rows: [{ count: '0' }] },                            // 30d
      { rows: [{ count: '0' }] },                            // rapid — 0
      { rows: [] },                                           // sequential
      { rows: [{ count: '0' }] },                            // threshold probe
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
// 3. Cross-user duplicate — scaled multiplier
// base = 2
// storedScore ≤ 4:  multiplier 0.5  → round(2 × 0.5) = 1
// storedScore ≥ 10: multiplier 1.5  → round(2 × 1.5) = 3
// storedScore ≥ 15: multiplier 2    → round(2 × 2)   = 4
// ─────────────────────────────────────────────────────────────────────────────
describe('Cross-user duplicate — scaled multiplier', () => {
  const runWithScore = async (storedScore: number) => {
    setupQueries([
      { rows: [{ risk_score: storedScore, risk_last_flagged_at: new Date() }] },
      { rows: [{ count: '0', distinct_businesses: '0' }] }, // 24h
      { rows: [{ count: '0' }] },                            // 7d
      { rows: [{ count: '0' }] },                            // 30d
      { rows: [{ count: '0' }] },                            // rapid
      { rows: [] },                                           // sequential
      { rows: [{ count: '0' }] },                            // threshold probe
      { rows: [{ avg_amount: '50' }] },
    ]);

    return evaluateUserRisk(3, {
      businessId: 10,
      receiptIdentifier: 'RCPT400',
      transactionAmount: 50,
      isDuplicateCrossUser: true,
    });
  };

  test('low risk user (score 3) gets delta +1 from cross-user dup (2 × 0.5)', async () => {
    const result = await runWithScore(3);
    expect(result.flags).toContain('duplicate_identifier_cross_user');
    expect(result.delta).toBe(1);
  });

  test('medium-high risk user (score 12) gets delta +3 from cross-user dup (2 × 1.5)', async () => {
    const result = await runWithScore(12);
    expect(result.flags).toContain('duplicate_identifier_cross_user');
    expect(result.delta).toBe(3);
  });

  test('very high risk user (score 16) gets delta +4 from cross-user dup (2 × 2)', async () => {
    const result = await runWithScore(16);
    expect(result.flags).toContain('duplicate_identifier_cross_user');
    expect(result.delta).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Accidental Double-Tap — no cross-user dup flag
// ─────────────────────────────────────────────────────────────────────────────
describe('Accidental Double-Tap — no cross-user dup flag when isDuplicateCrossUser is false', () => {
  test('no cross-user dup flag fires and delta is 0 for clean low-risk submission', async () => {
    setupQueries(cleanSequence(2, null, 1, 0, [], 30));

    const result = await evaluateUserRisk(4, {
      businessId: 10,
      receiptIdentifier: 'RCPT500',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('duplicate_identifier_cross_user');
    expect(result.delta).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Trash Picker — high_submission_velocity + rapid_submission together
// velocity count ≥ 7 at 1 business → adjustedCount = 8 → high_submission_velocity (+4)
// rapid count ≥ 1 → rapid_submission (+3)
// total delta = 7
// ─────────────────────────────────────────────────────────────────────────────
describe('Trash Picker — velocity + rapid both fire', () => {
  test('fires high_submission_velocity and rapid_submission together for delta ≥ 7', async () => {
    setupQueries([
      { rows: [{ risk_score: 5, risk_last_flagged_at: new Date() }] },
      { rows: [{ count: '8', distinct_businesses: '1' }] }, // 24h velocity ≥ 7 at 1 biz → full penalty
      { rows: [{ count: '0' }] },                            // 7d (not ≥20, no flag)
      { rows: [{ count: '0' }] },                            // 30d (not ≥60, no flag)
      { rows: [{ count: '1' }] },                            // rapid
      { rows: [{ receipt_identifier: 'RCPT600' }] },         // only 1 seq row
      { rows: [{ count: '0' }] },                            // threshold probe
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
    expect(result.delta).toBeGreaterThanOrEqual(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Weekly decay
// Score > 0 and lastFlaggedAt > 7 days ago → score decremented by 1 before delta
// ─────────────────────────────────────────────────────────────────────────────
describe('Weekly decay — score decremented when no flag in 7+ days', () => {
  test('applies decay so totalScore = (storedScore - 1) + delta on clean submission', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ risk_score: 5, risk_last_flagged_at: eightDaysAgo }] }) // user SELECT
      .mockResolvedValueOnce({ rows: [] })                                                        // decay UPDATE
      .mockResolvedValueOnce({ rows: [{ count: '0', distinct_businesses: '0' }] })               // 24h velocity
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })                                         // 7d
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })                                         // 30d
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })                                         // rapid
      .mockResolvedValueOnce({ rows: [] })                                                        // sequential
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })                                         // threshold probe
      .mockResolvedValueOnce({ rows: [{ avg_amount: '10' }] });                                  // avg

    const result = await evaluateUserRisk(6, {
      businessId: 10,
      receiptIdentifier: 'RCPT700',
      transactionAmount: 10,
      isDuplicateCrossUser: false,
    });

    // After decay, storedScore = 4 (5 - 1). Clean submission adds 0 delta.
    expect(result.totalScore).toBe(4);
    expect(result.delta).toBe(0);
  });

  test('does NOT apply decay when lastFlaggedAt is less than 7 days ago', async () => {
    const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    setupQueries([
      { rows: [{ risk_score: 5, risk_last_flagged_at: yesterday }] },
      { rows: [{ count: '0', distinct_businesses: '0' }] }, // 24h
      { rows: [{ count: '0' }] },                            // 7d
      { rows: [{ count: '0' }] },                            // 30d
      { rows: [{ count: '0' }] },                            // rapid
      { rows: [] },                                           // sequential
      { rows: [{ count: '0' }] },                            // threshold probe
      { rows: [{ avg_amount: '10' }] },
    ]);

    const result = await evaluateUserRisk(6, {
      businessId: 10,
      receiptIdentifier: 'RCPT800',
      transactionAmount: 10,
      isDuplicateCrossUser: false,
    });

    // No decay — stored score stays 5
    expect(result.totalScore).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Amount outlier
// transactionAmount > 3 × 30-day average → amount_outlier flag (+2)
// ─────────────────────────────────────────────────────────────────────────────
describe('Amount outlier flag', () => {
  test('fires amount_outlier when transaction is more than 3× the 30-day business average', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '0', distinct_businesses: '0' }] }, // 24h
      { rows: [{ count: '0' }] },                            // 7d
      { rows: [{ count: '0' }] },                            // 30d
      { rows: [{ count: '0' }] },                            // rapid
      { rows: [] },                                           // sequential
      { rows: [{ count: '0' }] },                            // threshold probe
      { rows: [{ avg_amount: '20' }] },                      // avg = 20, amount = 100 → 100 > 60
    ]);

    const result = await evaluateUserRisk(7, {
      businessId: 10,
      receiptIdentifier: 'RCPT900',
      transactionAmount: 100,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('amount_outlier');
    expect(result.delta).toBeGreaterThanOrEqual(2);
  });

  test('does NOT fire amount_outlier when transaction is within 3× the average', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '0', distinct_businesses: '0' }] }, // 24h
      { rows: [{ count: '0' }] },                            // 7d
      { rows: [{ count: '0' }] },                            // 30d
      { rows: [{ count: '0' }] },                            // rapid
      { rows: [] },                                           // sequential
      { rows: [{ count: '0' }] },                            // threshold probe
      { rows: [{ avg_amount: '50' }] },                      // avg = 50, amount = 55 → well within 3×
    ]);

    const result = await evaluateUserRisk(7, {
      businessId: 10,
      receiptIdentifier: 'RCPT901',
      transactionAmount: 55,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('amount_outlier');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. evaluateUserRisk with no context — returns clean zero-delta result
// ─────────────────────────────────────────────────────────────────────────────
describe('evaluateUserRisk — no context provided', () => {
  test('returns delta 0 and empty flags when called without a context argument', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ risk_score: 3, risk_last_flagged_at: null }] });
    const result = await evaluateUserRisk(8);
    expect(result.delta).toBe(0);
    expect(result.flags).toHaveLength(0);
    expect(result.totalScore).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Suspicious fast typing — suspiciously_fast_input flag
// ─────────────────────────────────────────────────────────────────────────────
describe('Suspiciously fast typing — suspiciously_fast_input flag', () => {
  test('fires when identifier > 4 chars, method is typed, and typingDurationMs < 800', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '0', distinct_businesses: '0' }] }, // 24h
      { rows: [{ count: '0' }] },                            // 7d
      { rows: [{ count: '0' }] },                            // 30d
      { rows: [{ count: '0' }] },                            // rapid
      { rows: [] },                                           // sequential
      { rows: [{ count: '0' }] },                            // threshold probe
      { rows: [{ avg_amount: '30' }] },
    ]);

    const result = await evaluateUserRisk(9, {
      businessId: 10,
      receiptIdentifier: 'RCPT12345',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
      receiptInputMethod: 'typed',
      typingDurationMs: 400,
    });

    expect(result.flags).toContain('suspiciously_fast_input');
    expect(result.delta).toBeGreaterThanOrEqual(3);
  });

  test('does NOT fire when identifier was pasted (method is pasted)', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '0', distinct_businesses: '0' }] }, // 24h
      { rows: [{ count: '0' }] },                            // 7d
      { rows: [{ count: '0' }] },                            // 30d
      { rows: [{ count: '0' }] },                            // rapid
      { rows: [] },                                           // sequential
      { rows: [{ count: '0' }] },                            // threshold probe
      { rows: [{ avg_amount: '30' }] },
    ]);

    const result = await evaluateUserRisk(9, {
      businessId: 10,
      receiptIdentifier: 'RCPT12345',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
      receiptInputMethod: 'pasted',
      typingDurationMs: 100,
    });

    expect(result.flags).not.toContain('suspiciously_fast_input');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Sustained velocity signals — weekly and monthly
// ─────────────────────────────────────────────────────────────────────────────
describe('Sustained velocity signals', () => {
  test('fires sustained_weekly_velocity when ≥20 submissions in 7 days', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '2', distinct_businesses: '1' }] }, // 24h — not enough for daily flag
      { rows: [{ count: '20' }] },                           // 7d — exactly threshold
      { rows: [{ count: '0' }] },                            // 30d
      { rows: [{ count: '0' }] },                            // rapid
      { rows: [] },                                           // sequential
      { rows: [{ count: '0' }] },                            // threshold probe
      { rows: [{ avg_amount: '30' }] },
    ]);

    const result = await evaluateUserRisk(10, {
      businessId: 10,
      receiptIdentifier: 'RCPT-W1',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('sustained_weekly_velocity');
    expect(result.delta).toBeGreaterThanOrEqual(2);
  });

  test('fires sustained_monthly_volume when ≥60 submissions in 30 days', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '2', distinct_businesses: '1' }] }, // 24h
      { rows: [{ count: '0' }] },                            // 7d
      { rows: [{ count: '60' }] },                           // 30d — exactly threshold
      { rows: [{ count: '0' }] },                            // rapid
      { rows: [] },                                           // sequential
      { rows: [{ count: '0' }] },                            // threshold probe
      { rows: [{ avg_amount: '30' }] },
    ]);

    const result = await evaluateUserRisk(10, {
      businessId: 10,
      receiptIdentifier: 'RCPT-M1',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('sustained_monthly_volume');
    expect(result.delta).toBeGreaterThanOrEqual(3);
  });

  test('does NOT fire sustained signals when counts are below thresholds', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [{ count: '2', distinct_businesses: '1' }] }, // 24h
      { rows: [{ count: '19' }] },                           // 7d — just under threshold
      { rows: [{ count: '59' }] },                           // 30d — just under threshold
      { rows: [{ count: '0' }] },                            // rapid
      { rows: [] },                                           // sequential
      { rows: [{ count: '0' }] },                            // threshold probe
      { rows: [{ avg_amount: '30' }] },
    ]);

    const result = await evaluateUserRisk(10, {
      businessId: 10,
      receiptIdentifier: 'RCPT-CLEAN',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('sustained_weekly_velocity');
    expect(result.flags).not.toContain('sustained_monthly_volume');
  });
});
