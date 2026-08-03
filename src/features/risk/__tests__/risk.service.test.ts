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
 *   3. single merged CTE — returns ONE row with columns:
 *        v24h_count, v24h_distinct, v7d_count, v30d_count,
 *        rapid_count, seq_ids, probe_count, avg_amount
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
 * Build a single merged CTE row for clean signal data.
 * All counts zero, no seq IDs, specified avg amount.
 */
const cleanCteRow = (
  velocityCount: number,
  rapidCount: number,
  seqIds: (string | null)[],
  avgAmount: number | null,
  overrides: Partial<{
    v24h_distinct: number;
    v7d_count: number;
    v30d_count: number;
    probe_count: number;
  }> = {},
) => ({
  v24h_count: velocityCount,
  v24h_distinct: overrides.v24h_distinct ?? 1,
  v7d_count: overrides.v7d_count ?? 0,
  v30d_count: overrides.v30d_count ?? 0,
  rapid_count: rapidCount,
  seq_ids: seqIds,
  probe_count: overrides.probe_count ?? 0,
  avg_amount: avgAmount,
});

/**
 * Convenience: build the standard 2-query sequence for a clean submission
 * with no flags, given a starting stored score and last-flagged date.
 *
 * Query order (no decay):
 *   0: user SELECT
 *   1: merged CTE row
 */
const cleanSequence = (
  storedScore: number,
  lastFlagged: Date | null,
  velocityCount: number,
  rapidCount: number,
  seqIds: (string | null)[],
  avgAmount: number,
): Array<{ rows: unknown[] }> => [
  { rows: [{ risk_score: storedScore, risk_last_flagged_at: lastFlagged }] },
  { rows: [cleanCteRow(velocityCount, rapidCount, seqIds, avgAmount)] },
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
      {
        rows: [
          cleanCteRow(
            2,
            0,
            // 3 neighbors close to RCPT105 (100, 101, 102 — all within 5)
            ['RCPT102', 'RCPT101', 'RCPT100'],
            50,
          ),
        ],
      },
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
      {
        rows: [
          cleanCteRow(
            1,
            0,
            // Only 2 neighbors close to RCPT103
            ['RCPT102', 'RCPT101'],
            50,
          ),
        ],
      },
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
      {
        rows: [
          cleanCteRow(
            1,
            1, // rapid — 1 in last 30 s
            ['RCPT200'], // only 1 seq id — too few for seq check
            40,
          ),
        ],
      },
    ]);

    const result = await evaluateUserRisk(2, {
      businessId: 10,
      receiptIdentifier: 'RCPT201',
      transactionAmount: 40,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('rapid_submission');
    expect(result.delta).toBeGreaterThanOrEqual(2);
  });

  test('does NOT fire rapid_submission when no ticket within 30 seconds', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          cleanCteRow(0, 0, [], 40, { v24h_distinct: 0 }),
        ],
      },
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
// storedScore ≥ 20: multiplier 2    → round(2 × 2)   = 4
// ─────────────────────────────────────────────────────────────────────────────
describe('Cross-user duplicate — scaled multiplier', () => {
  const runWithScore = async (storedScore: number) => {
    setupQueries([
      { rows: [{ risk_score: storedScore, risk_last_flagged_at: new Date() }] },
      { rows: [cleanCteRow(0, 0, [], 50, { v24h_distinct: 0 })] },
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

  test('very high risk user (score 20) gets delta +4 from cross-user dup (2 × 2)', async () => {
    const result = await runWithScore(20);
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
      {
        rows: [
          {
            v24h_count: 8,    // 24h velocity ≥ 7 at 1 biz → full penalty
            v24h_distinct: 1,
            v7d_count: 0,     // not ≥20, no flag
            v30d_count: 0,    // not ≥60, no flag
            rapid_count: 1,   // rapid
            seq_ids: ['RCPT600'], // only 1 seq id
            probe_count: 0,
            avg_amount: 20,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(5, {
      businessId: 10,
      receiptIdentifier: 'RCPT601',
      transactionAmount: 20,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('high_submission_velocity');
    expect(result.flags).toContain('rapid_submission');
    expect(result.delta).toBeGreaterThanOrEqual(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. decayAllUserRiskScores — campaign-close bulk decay
// Tiered: HIGH (≥20) → −4, MEDIUM (10–19) → −2, LOW (1–9) → −1
// Decays every user with a score above 0 (WHERE risk_score > 0 guard)
// ─────────────────────────────────────────────────────────────────────────────
import { decayAllUserRiskScores } from '../risk.service';

describe('decayAllUserRiskScores — campaign-close bulk decay', () => {
  test('returns { updated: N } matching the rowCount from the UPDATE', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 42, rows: [] });

    const result = await decayAllUserRiskScores();

    expect(result).toEqual({ updated: 42, unquarantinedUserIds: [] });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // Verify the UPDATE targets users with risk_score > 0
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/WHERE risk_score > 0/);
  });

  test('returns { updated: 0 } when no users have a score above 0', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await decayAllUserRiskScores();

    expect(result).toEqual({ updated: 0, unquarantinedUserIds: [] });
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
      {
        rows: [
          cleanCteRow(0, 0, [], 20, { v24h_distinct: 0 }), // avg = 20, amount = 100 → 100 > 60
        ],
      },
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
      {
        rows: [
          cleanCteRow(0, 0, [], 50, { v24h_distinct: 0 }), // avg = 50, amount = 55 → well within 3×
        ],
      },
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
    mockQuery.mockResolvedValueOnce({ rows: [{ risk_score: 3, risk_last_flagged_at: new Date() }] });
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
  test('fires when identifier > 5 chars, method is typed, and typingDurationMs < 700', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [cleanCteRow(0, 0, [], 30, { v24h_distinct: 0 })] },
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
      { rows: [cleanCteRow(0, 0, [], 30, { v24h_distinct: 0 })] },
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
      {
        rows: [
          {
            v24h_count: 2,   // not enough for daily flag
            v24h_distinct: 1,
            v7d_count: 20,   // exactly threshold
            v30d_count: 0,
            rapid_count: 0,
            seq_ids: [],
            probe_count: 0,
            avg_amount: 30,
          },
        ],
      },
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
      {
        rows: [
          {
            v24h_count: 2,
            v24h_distinct: 1,
            v7d_count: 0,
            v30d_count: 60,  // exactly threshold
            rapid_count: 0,
            seq_ids: [],
            probe_count: 0,
            avg_amount: 30,
          },
        ],
      },
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
      {
        rows: [
          {
            v24h_count: 2,
            v24h_distinct: 1,
            v7d_count: 19,   // just under threshold
            v30d_count: 59,  // just under threshold
            rapid_count: 0,
            seq_ids: [],
            probe_count: 0,
            avg_amount: 30,
          },
        ],
      },
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

// ─────────────────────────────────────────────────────────────────────────────
// 11. Innocent user — normal low-volume multi-business shopper
//
// Scenario: 1–3 receipts from different businesses, varied amounts, no rapid
// submissions, no duplicates. The system must score LOW with zero flags.
// This is the most important false-positive guard: innocent users must never
// be friction-gated.
// ─────────────────────────────────────────────────────────────────────────────
describe('Innocent user — normal low-volume multi-business shopper', () => {
  // Helper: build a clean 2-query sequence for a first-ever submission
  const firstSubmissionSequence = (avgAmount: number) => [
    { rows: [{ risk_score: 0, risk_last_flagged_at: null }] }, // user (no history)
    {
      rows: [
        {
          v24h_count: 0,
          v24h_distinct: 0,
          v7d_count: 0,
          v30d_count: 0,
          rapid_count: 0,
          seq_ids: [],
          probe_count: 0,
          avg_amount: avgAmount,
        },
      ],
    },
  ];

  test('first-ever receipt submission scores LOW with zero delta and zero flags', async () => {
    setupQueries(firstSubmissionSequence(40));

    const result = await evaluateUserRisk(100, {
      businessId: 1,
      receiptIdentifier: 'INV-2024-001',
      transactionAmount: 45,
      isDuplicateCrossUser: false,
      receiptInputMethod: 'typed',
      typingDurationMs: 4200, // slow human typing
    });

    expect(result.level).toBe('low');
    expect(result.delta).toBe(0);
    expect(result.flags).toHaveLength(0);
    expect(result.totalScore).toBe(0);
  });

  test('second receipt at a different business (2 total today) scores LOW with zero flags', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 1,   // 1 prior
            v24h_distinct: 2, // 2 businesses
            v7d_count: 1,
            v30d_count: 1,
            rapid_count: 0,  // different business
            seq_ids: [],
            probe_count: 0,
            avg_amount: 35,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(100, {
      businessId: 2,
      receiptIdentifier: 'REC-5678',
      transactionAmount: 38,
      isDuplicateCrossUser: false,
      receiptInputMethod: 'typed',
      typingDurationMs: 6000,
    });

    expect(result.level).toBe('low');
    expect(result.delta).toBe(0);
    expect(result.flags).toHaveLength(0);
  });

  test('third receipt (3 total, 3 different businesses) is not velocity-penalised', async () => {
    // 3 submissions at 3 distinct businesses → adjustedCount = floor(3/2) = 1 → no penalty
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 2,   // 2 prior
            v24h_distinct: 3, // 3 businesses
            v7d_count: 2,
            v30d_count: 2,
            rapid_count: 0,
            seq_ids: [],
            probe_count: 0,
            avg_amount: 30,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(100, {
      businessId: 3,
      receiptIdentifier: 'TX-9999',
      transactionAmount: 55,
      isDuplicateCrossUser: false,
    });

    expect(result.level).toBe('low');
    expect(result.delta).toBe(0);
    expect(result.flags).not.toContain('high_submission_velocity');
    expect(result.flags).not.toContain('elevated_submission_velocity');
  });

  test('pasting a long receipt identifier does NOT fire suspiciously_fast_input', async () => {
    setupQueries(firstSubmissionSequence(50));

    const result = await evaluateUserRisk(100, {
      businessId: 1,
      receiptIdentifier: 'LONGID-2024-XYZ-0042',
      transactionAmount: 50,
      isDuplicateCrossUser: false,
      receiptInputMethod: 'pasted', // pasted — must be exempt regardless of speed
      typingDurationMs: 50,
    });

    expect(result.flags).not.toContain('suspiciously_fast_input');
    expect(result.level).toBe('low');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Power user — 10–15 legitimate receipts across many businesses
//
// Scenario: a genuine frequent shopper who visits many stores and submits a
// receipt daily over two weeks. The multi-business discount and sub-threshold
// weekly/monthly counts should keep them out of HIGH.
// ─────────────────────────────────────────────────────────────────────────────
describe('Power user — frequent legitimate shopper across many businesses', () => {
  test('10 receipts spread across 5+ businesses in the last 7 days does NOT reach HIGH risk', async () => {
    // 4 receipts today across 4 businesses → adjustedCount = floor(4/2) = 2 → no velocity flag
    // 10 in 7 days → below 20 threshold → no weekly flag
    // Stored score already at 0 (clean user)
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 3,   // 3 prior today
            v24h_distinct: 4, // 4 businesses
            v7d_count: 9,    // under 20
            v30d_count: 9,   // under 60
            rapid_count: 0,  // different biz
            seq_ids: [],
            probe_count: 0,
            avg_amount: 45,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(200, {
      businessId: 5,
      receiptIdentifier: 'REC-A100',
      transactionAmount: 48,
      isDuplicateCrossUser: false,
    });

    expect(result.level).not.toBe('high');
    expect(result.flags).not.toContain('high_submission_velocity');
    expect(result.flags).not.toContain('sustained_weekly_velocity');
  });

  test('15 receipts across 5 businesses over 30 days does NOT trigger monthly flag', async () => {
    // 15 in 30 days is well under the 60 threshold for sustained_monthly_volume
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 1,
            v24h_distinct: 2,
            v7d_count: 5,    // under 20
            v30d_count: 14,  // under 60
            rapid_count: 0,
            seq_ids: [],
            probe_count: 0,
            avg_amount: 40,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(200, {
      businessId: 6,
      receiptIdentifier: 'REC-B200',
      transactionAmount: 42,
      isDuplicateCrossUser: false,
    });

    expect(result.level).toBe('low');
    expect(result.flags).not.toContain('sustained_monthly_volume');
    expect(result.flags).not.toContain('sustained_weekly_velocity');
  });

  test('4 receipts at 4 distinct businesses today — no multi-business discount, elevated_submission_velocity fires', async () => {
    // adjustedCount = recentCount = 3 → elevated_submission_velocity fires (≥3 threshold)
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 3,   // 3 prior today at 4 businesses
            v24h_distinct: 4,
            v7d_count: 3,
            v30d_count: 3,
            rapid_count: 0,
            seq_ids: [],
            probe_count: 0,
            avg_amount: 30,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(200, {
      businessId: 4,
      receiptIdentifier: 'REC-C300',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('elevated_submission_velocity');
    expect(result.flags).not.toContain('high_submission_velocity');
    expect(result.level).toBe('low');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Scammer pattern 1 — same receipt ID submitted multiple times (cross-user dup)
//
// A scammer shares a receipt number with friends. Each friend submits the same
// receipt identifier. The system must escalate the penalty for repeat offenders
// and hard-block on the duplicate check.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scammer pattern 1 — cross-user duplicate receipt identifier', () => {
  test('first-offence cross-user dup (score 0→3) adds scaled penalty (+1 at low risk)', async () => {
    // Score is 0 (≤4) → multiplier 0.5 → round(2 × 0.5) = 1
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [cleanCteRow(0, 0, [], 50, { v24h_distinct: 0 })] },
    ]);

    const result = await evaluateUserRisk(300, {
      businessId: 20,
      receiptIdentifier: 'SHARED-001',
      transactionAmount: 50,
      isDuplicateCrossUser: true,
    });

    expect(result.flags).toContain('duplicate_identifier_cross_user');
    expect(result.delta).toBe(1);
    expect(result.totalScore).toBe(1); // was 0, now 1
  });

  test('medium-risk user submitting cross-user dup gets heavier penalty (+3)', async () => {
    // Score is 12 (≥10) → multiplier 1.5 → round(2 × 1.5) = 3
    setupQueries([
      { rows: [{ risk_score: 12, risk_last_flagged_at: new Date() }] },
      { rows: [cleanCteRow(0, 0, [], 50, { v24h_distinct: 0 })] },
    ]);

    const result = await evaluateUserRisk(300, {
      businessId: 20,
      receiptIdentifier: 'SHARED-002',
      transactionAmount: 50,
      isDuplicateCrossUser: true,
    });

    expect(result.flags).toContain('duplicate_identifier_cross_user');
    expect(result.delta).toBe(3);
    expect(result.totalScore).toBe(15); // crosses into medium (15 < 20)
    expect(result.level).toBe('medium');
  });

  test('high-risk user submitting cross-user dup gets maximum penalty (+4)', async () => {
    // Score is 20 (≥20) → multiplier 2 → round(2 × 2) = 4
    setupQueries([
      { rows: [{ risk_score: 20, risk_last_flagged_at: new Date() }] },
      { rows: [cleanCteRow(0, 0, [], 50, { v24h_distinct: 0 })] },
    ]);

    const result = await evaluateUserRisk(300, {
      businessId: 20,
      receiptIdentifier: 'SHARED-003',
      transactionAmount: 50,
      isDuplicateCrossUser: true,
    });

    expect(result.flags).toContain('duplicate_identifier_cross_user');
    expect(result.delta).toBe(4);
    expect(result.level).toBe('high');
  });

  test('score boundary: stored score of 5 (not ≤4 and not ≥10) uses multiplier 1.0 → +2', async () => {
    // Score is 5 (5–9 band) → multiplier 1.0 → round(2 × 1) = 2
    setupQueries([
      { rows: [{ risk_score: 5, risk_last_flagged_at: new Date() }] },
      { rows: [cleanCteRow(0, 0, [], 50, { v24h_distinct: 0 })] },
    ]);

    const result = await evaluateUserRisk(300, {
      businessId: 20,
      receiptIdentifier: 'SHARED-004',
      transactionAmount: 50,
      isDuplicateCrossUser: true,
    });

    expect(result.flags).toContain('duplicate_identifier_cross_user');
    expect(result.delta).toBe(2);
    expect(result.totalScore).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Scammer pattern 2 — same amount submitted over and over
//
// A scammer submits the exact same amount repeatedly. By itself, a repeated
// amount is not a direct signal, but when combined with a single-business
// concentration and high velocity the score climbs quickly.
//
// The key concern here is the amount_outlier signal: if the repeated amount
// is unusually high compared to the business average, it fires. If the amount
// is normal, we verify the system is NOT over-penalising (false-positive guard).
// ─────────────────────────────────────────────────────────────────────────────
describe('Scammer pattern 2 — repeated identical amounts', () => {
  test('repeated amount that is 4× the business average triggers amount_outlier (+2)', async () => {
    // Average is 25, scammer always submits 100 → 100 > 25×3 = 75 → fires
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 2,
            v24h_distinct: 1, // 1 business
            v7d_count: 2,
            v30d_count: 2,
            rapid_count: 0,
            seq_ids: [],
            probe_count: 0,
            avg_amount: 25,   // avg = 25, amount = 100 → outlier
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(400, {
      businessId: 30,
      receiptIdentifier: 'AMT-001',
      transactionAmount: 100,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('amount_outlier');
    expect(result.delta).toBeGreaterThanOrEqual(2);
  });

  test('repeated normal amount (within 3× average) does NOT trigger amount_outlier', async () => {
    // Average is 40, scammer submits 80 every time → 80 < 40×3 = 120 → no outlier
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 3,
            v24h_distinct: 1,
            v7d_count: 3,
            v30d_count: 3,
            rapid_count: 0,
            seq_ids: [],
            probe_count: 0,
            avg_amount: 40,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(400, {
      businessId: 30,
      receiptIdentifier: 'AMT-002',
      transactionAmount: 80,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('amount_outlier');
  });

  test('amount_outlier is skipped when business has no prior transactions (avg = NaN)', async () => {
    // New business: no prior tickets → avg_amount is NULL → avg is null → check skipped
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [cleanCteRow(0, 0, [], null, { v24h_distinct: 0 })] },
    ]);

    const result = await evaluateUserRisk(400, {
      businessId: 99,
      receiptIdentifier: 'AMT-NEW',
      transactionAmount: 9999,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('amount_outlier');
    expect(result.level).toBe('low');
  });

  test('amount_outlier is skipped when transactionAmount is 0', async () => {
    // The signal guard: transactionAmount > 0 — a 0-amount submission skips the check entirely
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [cleanCteRow(0, 0, [], 10, { v24h_distinct: 0 })] },
    ]);

    const result = await evaluateUserRisk(400, {
      businessId: 30,
      receiptIdentifier: 'AMT-ZERO',
      transactionAmount: 0,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('amount_outlier');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Scammer pattern 3 — rapid-fire submissions at same business
//
// Submitting multiple receipts in under 30 seconds at the same business.
// Each submission after the first should fire rapid_submission (+3).
// ─────────────────────────────────────────────────────────────────────────────
describe('Scammer pattern 3 — rapid-fire submissions in short window', () => {
  test('rapid submission at same business scores at least +2 delta', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 1,
            v24h_distinct: 1,
            v7d_count: 1,
            v30d_count: 1,
            rapid_count: 1,  // 1 in last 30 s
            seq_ids: [],     // not enough rows for seq check
            probe_count: 0,
            avg_amount: 30,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(500, {
      businessId: 40,
      receiptIdentifier: 'RAPID-002',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('rapid_submission');
    expect(result.delta).toBeGreaterThanOrEqual(2);
  });

  test('rapid submission combined with velocity (4 in 24h, 1 business) reaches HIGH risk quickly', async () => {
    // Starting score: 0. Rapid (+2) + high velocity (+4) = delta 6 → totalScore 6 (still low).
    // Demonstrates that a fresh account needs ~two rapid-burst sessions to reach HIGH.
    // This tests the combined path fires both flags.
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 4,   // 4 in 24h, 1 business → adjustedCount=4 → +4
            v24h_distinct: 1,
            v7d_count: 4,
            v30d_count: 4,
            rapid_count: 1,  // +2
            seq_ids: [],
            probe_count: 0,
            avg_amount: 30,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(500, {
      businessId: 40,
      receiptIdentifier: 'RAPID-005',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('high_submission_velocity');
    expect(result.flags).toContain('rapid_submission');
    expect(result.delta).toBe(6); // +4 velocity + +2 rapid
  });

  test('rapid submission at a DIFFERENT business does NOT fire rapid_submission', async () => {
    // rapid check is scoped to the same business_id — a different store resets the 30-second clock
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 1,
            v24h_distinct: 2, // 2 different businesses today
            v7d_count: 1,
            v30d_count: 1,
            rapid_count: 0,  // rapid count at THIS business = 0
            seq_ids: [],
            probe_count: 0,
            avg_amount: 30,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(500, {
      businessId: 41, // different business
      receiptIdentifier: 'RAPID-DIFF',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('rapid_submission');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 16. Scammer pattern 4 — single-business concentration
//
// All submissions concentrated at one business. The multi-business discount
// does NOT apply when distinct_businesses < 3, so velocity penalties fire at
// full weight. This is the trash-picker/organised-fraud pattern.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scammer pattern 4 — all submissions from a single business', () => {
  test('4 submissions at 1 business in 24h fires high_submission_velocity (+4)', async () => {
    // distinct_businesses = 1 → no discount → adjustedCount = 4 → +4
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 4,   // concentrated at 1 biz
            v24h_distinct: 1,
            v7d_count: 4,
            v30d_count: 4,
            rapid_count: 0,
            seq_ids: [],
            probe_count: 0,
            avg_amount: 30,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(600, {
      businessId: 50,
      receiptIdentifier: 'CONC-005',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('high_submission_velocity');
    expect(result.delta).toBeGreaterThanOrEqual(4);
  });

  test('3 submissions at 1 business fires elevated_submission_velocity (+2) not high_submission_velocity', async () => {
    // adjustedCount = 3 (1 business, no discount) → +2, not +4
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 3,
            v24h_distinct: 1,
            v7d_count: 3,
            v30d_count: 3,
            rapid_count: 0,
            seq_ids: [],
            probe_count: 0,
            avg_amount: 30,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(600, {
      businessId: 50,
      receiptIdentifier: 'CONC-004',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('elevated_submission_velocity');
    expect(result.flags).not.toContain('high_submission_velocity');
    expect(result.delta).toBe(2);
  });

  test('6 submissions at 2 businesses (adjustedCount = 3) fires elevated_submission_velocity', async () => {
    // 6 submissions, 2 businesses → below 3 threshold → no discount → adjustedCount=6 → +4
    // (This verifies the discount only activates at 3+ distinct businesses)
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 6,
            v24h_distinct: 2, // 2 businesses — no discount
            v7d_count: 6,
            v30d_count: 6,
            rapid_count: 0,
            seq_ids: [],
            probe_count: 0,
            avg_amount: 30,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(600, {
      businessId: 51,
      receiptIdentifier: 'CONC-007',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    // 2 businesses < 3 → no discount → adjustedCount = 6 → high_submission_velocity (+4)
    expect(result.flags).toContain('high_submission_velocity');
    expect(result.delta).toBeGreaterThanOrEqual(4);
  });

  test('4 submissions at exactly 3 distinct businesses — no multi-business discount, elevated_submission_velocity fires', async () => {
    // adjustedCount = recentCount = 3 → no discount → elevated_submission_velocity fires (≥3 threshold)
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 3,   // exactly 3 businesses
            v24h_distinct: 3,
            v7d_count: 3,
            v30d_count: 3,
            rapid_count: 0,
            seq_ids: [],
            probe_count: 0,
            avg_amount: 30,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(600, {
      businessId: 52,
      receiptIdentifier: 'CONC-DISC',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });

    // adjustedCount = 3 → elevated_submission_velocity fires; not enough for high (needs ≥4)
    expect(result.flags).toContain('elevated_submission_velocity');
    expect(result.flags).not.toContain('high_submission_velocity');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 17. Scammer pattern 5 — sequential / patterned receipt identifiers
//
// A scammer guesses receipt IDs by incrementing a counter. The system detects
// when 3+ prior identifiers are numerically close (within ±5) to the current one.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scammer pattern 5 — sequential/patterned receipt identifiers', () => {
  test('submitting REC-0005 after REC-0001, REC-0002, REC-0003 fires sequential_guessing (+4)', async () => {
    // 3 prior IDs all within 5 of current (0005) → closeCount = 3 → fires
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 3,
            v24h_distinct: 1,
            v7d_count: 3,
            v30d_count: 3,
            rapid_count: 0,
            seq_ids: ['REC-0003', 'REC-0002', 'REC-0001'],
            probe_count: 0,
            avg_amount: 50,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(700, {
      businessId: 60,
      receiptIdentifier: 'REC-0005',
      transactionAmount: 50,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).toContain('sequential_guessing');
    expect(result.delta).toBeGreaterThanOrEqual(4);
  });

  test('submitting REC-0010 after REC-0004, REC-0005, REC-0006 fires because all are within 5', async () => {
    // 0010 - 0004 = 6 → outside range of 5 → should NOT match 0004
    // 0010 - 0005 = 5 → within range (Math.abs(5-10) = 5, <= 5) → matches
    // 0010 - 0006 = 4 → within range → matches
    // closeCount = 2 (only REC-0005 and REC-0006 are within 5) → does NOT fire (need ≥3)
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 3,
            v24h_distinct: 1,
            v7d_count: 3,
            v30d_count: 3,
            rapid_count: 0,
            seq_ids: ['REC-0006', 'REC-0005', 'REC-0004'],
            probe_count: 0,
            avg_amount: 50,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(700, {
      businessId: 60,
      receiptIdentifier: 'REC-0010',
      transactionAmount: 50,
      isDuplicateCrossUser: false,
    });

    // REC-0004: |4-10| = 6 > 5 → excluded. REC-0005: |5-10| = 5 ≤ 5 → included. REC-0006: |6-10| = 4 ≤ 5 → included.
    // closeCount = 2 → does NOT reach the ≥3 threshold
    expect(result.flags).not.toContain('sequential_guessing');
  });

  test('identifiers with NO trailing number are exempt from sequential check', async () => {
    // IDs like 'ABCDEF', 'XYZWVU' have no trailing digits → trailingNum returns null → check skipped
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 2,
            v24h_distinct: 1,
            v7d_count: 2,
            v30d_count: 2,
            rapid_count: 0,
            seq_ids: ['ABCDEF', 'UVWXYZ', 'PQRSTU'],
            probe_count: 0,
            avg_amount: 50,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(700, {
      businessId: 60,
      receiptIdentifier: 'GHIJKL', // no trailing number
      transactionAmount: 50,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('sequential_guessing');
  });

  test('sequential check is skipped when fewer than 2 recent identifiers exist at this business', async () => {
    // Only 1 recent receipt at same business → the seqIds.length < 2 guard prevents the check
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 1,
            v24h_distinct: 1,
            v7d_count: 1,
            v30d_count: 1,
            rapid_count: 0,
            seq_ids: ['SEQ-0001'], // only 1 id
            probe_count: 0,
            avg_amount: 50,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(700, {
      businessId: 60,
      receiptIdentifier: 'SEQ-0002',
      transactionAmount: 50,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('sequential_guessing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18. Threshold probing — same identifier re-submitted with a different amount
// ─────────────────────────────────────────────────────────────────────────────
describe('Threshold probing — amount swap on same receipt identifier', () => {
  test('fires threshold_probing when same identifier was previously submitted with a different amount (+4)', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      {
        rows: [
          {
            v24h_count: 1,
            v24h_distinct: 1,
            v7d_count: 1,
            v30d_count: 1,
            rapid_count: 0,
            seq_ids: [],
            probe_count: 1, // previous submission with different amount found
            avg_amount: 30,
          },
        ],
      },
    ]);

    const result = await evaluateUserRisk(800, {
      businessId: 70,
      receiptIdentifier: 'PROBE-001',
      transactionAmount: 50,       // current amount
      isDuplicateCrossUser: false, // same user re-submitting, not cross-user
    });

    expect(result.flags).toContain('threshold_probing');
    expect(result.delta).toBeGreaterThanOrEqual(4);
  });

  test('does NOT fire threshold_probing when no prior entry exists for the identifier', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [cleanCteRow(0, 0, [], 30, { v24h_distinct: 0, probe_count: 0 })] },
    ]);

    const result = await evaluateUserRisk(800, {
      businessId: 70,
      receiptIdentifier: 'PROBE-NEW',
      transactionAmount: 50,
      isDuplicateCrossUser: false,
    });

    expect(result.flags).not.toContain('threshold_probing');
  });

  // D-2 regression: receipt numbers are unique per (business, draw) since 2026-07-25, so the
  // probe signal's accepted-ticket count must be scoped to the current draw. Otherwise an honest
  // customer whose merchant recycled a receipt number across campaigns (different amount) is
  // wrongly flagged +4. The mock returns a fixed probe_count regardless of SQL, so we pin the
  // query SHAPE: draw is passed as $5 and the ticket subquery filters on it.
  test('scopes the probe ticket count to the current draw when drawId is provided (D-2)', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [cleanCteRow(0, 0, [], 30, { probe_count: 0 })] },
    ]);

    await evaluateUserRisk(801, {
      businessId: 70,
      drawId: 4242,
      receiptIdentifier: 'PROBE-001',
      transactionAmount: 50,
      isDuplicateCrossUser: false,
    });

    // Merged signal query is the 2nd DB call (no decay at score 0).
    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toMatch(/draw_id = \$5/);       // ticket subquery is draw-scoped
    expect(params[4]).toBe(4242);                // current draw passed as $5
  });

  test('probe scope param is null when no drawId is supplied (isolated signal callers unaffected)', async () => {
    setupQueries([
      { rows: [{ risk_score: 0, risk_last_flagged_at: null }] },
      { rows: [cleanCteRow(0, 0, [], 30, { probe_count: 0 })] },
    ]);

    await evaluateUserRisk(802, {
      businessId: 70,
      receiptIdentifier: 'PROBE-001',
      transactionAmount: 50,
    });

    // $5 = null → the ($5 IS NULL OR draw_id = $5) guard disables the filter (old behavior).
    const [, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(params[4]).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 19. Score level boundaries — exact threshold crossings
//
// LOW_MAX = 9, MEDIUM_MAX = 19
// These tests verify the exact ≤ / > boundary semantics used in scoreToLevel.
// ─────────────────────────────────────────────────────────────────────────────
describe('Score level boundaries — exact threshold crossing', () => {
  const scoreAtBoundary = async (storedScore: number) => {
    setupQueries([
      { rows: [{ risk_score: storedScore, risk_last_flagged_at: new Date() }] },
      { rows: [cleanCteRow(0, 0, [], 30, { v24h_distinct: 0 })] },
    ]);

    return evaluateUserRisk(900, {
      businessId: 80,
      receiptIdentifier: 'BOUND-TEST',
      transactionAmount: 30,
      isDuplicateCrossUser: false,
    });
  };

  test('score 9 (LOW_MAX) maps to level low', async () => {
    const result = await scoreAtBoundary(9);
    expect(result.level).toBe('low');
    expect(result.totalScore).toBe(9);
  });

  test('score 10 (LOW_MAX + 1) maps to level medium', async () => {
    const result = await scoreAtBoundary(10);
    expect(result.level).toBe('medium');
    expect(result.totalScore).toBe(10);
  });

  test('score 19 (MEDIUM_MAX) maps to level medium', async () => {
    const result = await scoreAtBoundary(19);
    expect(result.level).toBe('medium');
    expect(result.totalScore).toBe(19);
  });

  test('score 20 (MEDIUM_MAX + 1) maps to level high', async () => {
    const result = await scoreAtBoundary(20);
    expect(result.level).toBe('high');
    expect(result.totalScore).toBe(20);
  });

  test('score 0 maps to level low', async () => {
    const result = await scoreAtBoundary(0);
    expect(result.level).toBe('low');
  });

  test('delta pushes score from exactly 9 to 10 → crosses into medium', async () => {
    // Score is 9. A cross-user dup at the mid-band (score 5–9, multiplier 1.0) adds +2.
    // Total = 11 → medium.
    setupQueries([
      { rows: [{ risk_score: 9, risk_last_flagged_at: new Date() }] },
      { rows: [cleanCteRow(0, 0, [], 30, { v24h_distinct: 0 })] },
    ]);

    const result = await evaluateUserRisk(900, {
      businessId: 80,
      receiptIdentifier: 'CROSS-9TO11',
      transactionAmount: 30,
      isDuplicateCrossUser: true,
    });

    expect(result.delta).toBe(2); // multiplier 1.0 at score 9 (5–9 band)
    expect(result.totalScore).toBe(11);
    expect(result.level).toBe('medium');
  });

  test('delta pushes score from exactly 19 to medium-high → stays medium', async () => {
    // Score is 19 (MEDIUM_MAX). A cross-user dup at score ≥10 (multiplier 1.5) adds +3.
    // Total = 22 → high.
    setupQueries([
      { rows: [{ risk_score: 19, risk_last_flagged_at: new Date() }] },
      { rows: [cleanCteRow(0, 0, [], 30, { v24h_distinct: 0 })] },
    ]);

    const result = await evaluateUserRisk(900, {
      businessId: 80,
      receiptIdentifier: 'CROSS-19TO22',
      transactionAmount: 30,
      isDuplicateCrossUser: true,
    });

    expect(result.delta).toBe(3); // multiplier 1.5 at score 19 (10–19 band)
    expect(result.totalScore).toBe(22);
    expect(result.level).toBe('high');
  });
});
