import { getPool, PoolClient } from '../../shared/db/db.js';
import {
  RiskEvaluation,
  RiskLevel,
  DuplicateCheckResult,
  RISK_THRESHOLDS,
} from './risk.types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const scoreToLevel = (score: number): RiskLevel => {
  if (score <= RISK_THRESHOLDS.LOW_MAX) return 'low';
  if (score <= RISK_THRESHOLDS.MEDIUM_MAX) return 'medium';
  return 'high';
};

// ─── Context ──────────────────────────────────────────────────────────────────

export interface RiskContext {
  businessId: number;
  receiptIdentifier: string;
  transactionAmount: number;
  /** Pre-computed cross-user duplicate result to avoid a redundant query. */
  isDuplicateCrossUser?: boolean;
  typingDurationMs?: number;
  receiptInputMethod?: 'typed' | 'pasted';
}

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Evaluate the risk delta for a user's current submission.
 *
 * Returns the points to ADD (delta) and the projected total score after update.
 * Also applies weekly decay lazily if no flagged event in the last 7 days.
 *
 * Signals:
 *   - Cross-user duplicate identifier      +2–4 (scaled by risk level)
 *   - Submission velocity ≥4 in 24 h       +4   (near-cap daily rate)
 *   - Submission velocity ≥3 in 24 h       +2
 *   - Sustained weekly volume  ≥20 in 7d   +2   (avg 3+/day for a week)
 *   - Sustained monthly volume ≥60 in 30d  +3   (avg 2+/day for a month)
 *   - Rapid submission <30 s at same biz   +3
 *   - Sequential identifier guessing       +4
 *   - Threshold probing (amount swap)      +4
 *   - Amount >3× business 30-day average   +2
 *   - Typed >4 chars in <800 ms            +3
 */
export const evaluateUserRisk = async (
  userId: number,
  context?: RiskContext,
): Promise<RiskEvaluation> => {
  const pool = getPool();
  const flags: string[] = [];

  // Load stored score and decay metadata
  const userResult = await pool.query(
    `SELECT risk_score, risk_last_flagged_at FROM "user" WHERE id = $1`,
    [userId],
  );
  let storedScore: number = userResult.rows[0]?.risk_score ?? 0;
  const lastFlaggedAt: Date | null = userResult.rows[0]?.risk_last_flagged_at ?? null;

  // Weekly decay: if no risky event in 7+ days, decrement stored score by 1
  if (storedScore > 0 && lastFlaggedAt) {
    const daysSince = (Date.now() - new Date(lastFlaggedAt).getTime()) / 86_400_000;
    if (daysSince >= 7) {
      storedScore = Math.max(0, storedScore - 1);
      await pool.query(`UPDATE "user" SET risk_score = $1 WHERE id = $2`, [storedScore, userId]);
    }
  }

  // Calculate delta from current submission signals
  let delta = 0;

  if (context) {
    const { businessId, receiptIdentifier, transactionAmount, isDuplicateCrossUser } = context;

    // Signal 1: cross-user duplicate — penalty scaled by submitter's current risk level
    if (isDuplicateCrossUser) {
      const base = 2;
      let multiplier: number;
      if (storedScore >= 15) multiplier = 2;
      else if (storedScore >= 10) multiplier = 1.5;
      else if (storedScore <= 4) multiplier = 0.5;
      else multiplier = 1;
      delta += Math.round(base * multiplier);
      flags.push('duplicate_identifier_cross_user');
    }

    // Signal 2: submission velocity (last 24 hours)
    // Daily hard cap is 5, so the max prior count seen here is 4.
    // Distribute penalty reduction across 3+ businesses to avoid penalising multi-shop users.
    const velocityResult = await pool.query(
      `SELECT COUNT(*) AS count, COUNT(DISTINCT business_id) AS distinct_businesses FROM ticket
       WHERE activated_by_user_id = $1 AND entry_source = 'receipt' AND activated_at >= NOW() - INTERVAL '24 hours'`,
      [userId],
    );
    const recentCount = parseInt(velocityResult.rows[0].count, 10);
    const distinctBusinesses = parseInt(velocityResult.rows[0].distinct_businesses, 10);
    // Only apply full velocity penalty if concentrated at few businesses
    const adjustedCount = distinctBusinesses >= 3 ? Math.floor(recentCount / 2) : recentCount;
    if (adjustedCount >= 4) {
      delta += 4;
      flags.push('high_submission_velocity');
    } else if (adjustedCount >= 3) {
      delta += 2;
      flags.push('elevated_submission_velocity');
    }

    // Signal 2b: sustained weekly velocity — flags users who max the cap daily for a week
    const weeklyResult = await pool.query(
      `SELECT COUNT(*) AS count FROM ticket
       WHERE activated_by_user_id = $1 AND entry_source = 'receipt' AND activated_at >= NOW() - INTERVAL '7 days'`,
      [userId],
    );
    const weeklyCount = parseInt(weeklyResult.rows[0].count, 10);
    if (weeklyCount >= 20) {
      // Averaging 3+ receipts/day for a week — consistent max-cap behaviour
      delta += 2;
      flags.push('sustained_weekly_velocity');
    }

    // Signal 2c: sustained monthly volume — flags heavy systemic exploitation over 30 days
    const monthlyResult = await pool.query(
      `SELECT COUNT(*) AS count FROM ticket
       WHERE activated_by_user_id = $1 AND entry_source = 'receipt' AND activated_at >= NOW() - INTERVAL '30 days'`,
      [userId],
    );
    const monthlyCount = parseInt(monthlyResult.rows[0].count, 10);
    if (monthlyCount >= 60) {
      // Averaging 2+ receipts/day for a full month — well beyond natural shopping behaviour
      delta += 3;
      flags.push('sustained_monthly_volume');
    }

    // Signal: rapid submission — last ticket submitted < 30 seconds ago at same business
    const rapidResult = await pool.query(
      `SELECT COUNT(*) AS count FROM ticket
       WHERE activated_by_user_id = $1
         AND entry_source = 'receipt'
         AND business_id = $2
         AND activated_at >= NOW() - INTERVAL '30 seconds'`,
      [userId, businessId],
    );
    if (parseInt(rapidResult.rows[0].count, 10) >= 1) {
      delta += 3;
      flags.push('rapid_submission');
    }

    // Signal: sequential identifier guessing
    // Detect if the current identifier's trailing number is within 5 of 2+ recent identifiers
    // submitted by the same user at the same business within the last 10 minutes
    const seqResult = await pool.query(
      `SELECT receipt_identifier FROM ticket
       WHERE activated_by_user_id = $1 AND business_id = $2
         AND activated_at >= NOW() - INTERVAL '10 minutes'
       ORDER BY activated_at DESC
       LIMIT 5`,
      [userId, businessId],
    );
    if (seqResult.rows.length >= 2) {
      const trailingNum = (s: string | null | undefined): number | null => {
        if (!s) return null;
        const m = s.match(/(\d+)$/);
        return m ? parseInt(m[1], 10) : null;
      };
      const currentNum = trailingNum(receiptIdentifier);
      if (currentNum !== null) {
        const closeCount = seqResult.rows.filter((r: { receipt_identifier: string }) => {
          const n = trailingNum(r.receipt_identifier);
          return n !== null && Math.abs(n - currentNum) <= 5 && n !== currentNum;
        }).length;
        if (closeCount >= 3) {
          delta += 4;
          flags.push('sequential_guessing');
        }
      }
    }

    // Signal: threshold probing — same receipt identifier re-submitted with a different amount
    const probeResult = await pool.query(
      `SELECT COUNT(*) AS count FROM ticket
       WHERE activated_by_user_id = $1 AND business_id = $2
         AND receipt_identifier = $3 AND transaction_amount != $4`,
      [userId, businessId, receiptIdentifier, transactionAmount],
    );
    if (parseInt(probeResult.rows[0].count, 10) > 0) {
      delta += 4;
      flags.push('threshold_probing');
    }

    // Signal 3: amount outlier vs business 30-day average
    if (transactionAmount > 0) {
      const avgResult = await pool.query(
        `SELECT AVG(transaction_amount::float) AS avg_amount FROM ticket
         WHERE business_id = $1 AND transaction_amount IS NOT NULL
           AND activated_at >= NOW() - INTERVAL '30 days'`,
        [businessId],
      );
      const avgAmount = parseFloat(avgResult.rows[0].avg_amount);
      if (!isNaN(avgAmount) && avgAmount > 0 && transactionAmount > avgAmount * 3) {
        delta += 2;
        flags.push('amount_outlier');
      }
    }

    // Signal 4: suspiciously fast typing
    if (
      context.receiptInputMethod === 'typed' &&
      receiptIdentifier.length > 4 &&
      context.typingDurationMs !== undefined &&
      context.typingDurationMs < 800
    ) {
      delta += 3;
      flags.push('suspiciously_fast_input');
    }
  }

  const totalScore = storedScore + delta;
  return { delta, totalScore, level: scoreToLevel(totalScore), flags };
};

/**
 * Persist the risk delta for a user after an evaluation.
 *
 * - delta > 0: adds points, resets clean-entry counter, stamps last_flagged_at.
 * - delta === 0: increments clean-entry counter; every 10 clean entries, decays score by 1.
 */
export const updateUserRiskScore = async (userId: number, delta: number, client?: PoolClient): Promise<void> => {
  const db = client ?? getPool();

  if (delta > 0) {
    await db.query(
      `UPDATE "user" SET
         risk_score            = risk_score + $1,
         risk_clean_entries    = 0,
         risk_last_flagged_at  = NOW()
       WHERE id = $2`,
      [delta, userId],
    );
  } else {
    // Clean submission: increment counter and apply decay every 10 entries
    await db.query(
      `UPDATE "user" SET
         risk_score         = GREATEST(0, risk_score - CASE WHEN (risk_clean_entries + 1) % 10 = 0 THEN 1 ELSE 0 END),
         risk_clean_entries = risk_clean_entries + 1
       WHERE id = $1`,
      [userId],
    );
  }
};

/**
 * Check if a receipt identifier has already been used by another user for the same business.
 */
export const checkDuplicateReceiptIdentifier = async (
  businessId: number,
  receiptIdentifier: string,
  submittingUserId: number,
  client?: PoolClient,
): Promise<DuplicateCheckResult> => {
  const db = client ?? getPool();
  const result = await db.query(
    `SELECT activated_by_user_id FROM ticket
     WHERE business_id = $1 AND receipt_identifier = $2 AND activated_by_user_id != $3
     LIMIT 1`,
    [businessId, receiptIdentifier, submittingUserId],
  );
  if (result.rows.length > 0) {
    return { isDuplicate: true, matchedUserId: result.rows[0].activated_by_user_id };
  }
  return { isDuplicate: false };
};

/**
 * Sync a user's quarantine state across all their tickets in a given draw.
 *
 * Called after every risk score update so the draw pool always reflects the
 * user's current risk level:
 *   - score >= 15 (HIGH): quarantine all tickets → excluded from draw + cap
 *   - score <= 14:        restore tickets quarantined by this mechanism
 *
 * Tickets manually quarantined by admins (quarantine_reason != 'high_risk_user')
 * are intentionally left untouched.
 */
export const syncUserQuarantineState = async (userId: number, drawId: number, client?: PoolClient): Promise<void> => {
  const db = client ?? getPool();

  const userResult = await db.query(
    `SELECT risk_score FROM "user" WHERE id = $1`,
    [userId],
  );
  const riskScore: number = userResult.rows[0]?.risk_score ?? 0;

  if (riskScore > RISK_THRESHOLDS.MEDIUM_MAX) {
    // Quarantine all unquarantined tickets for this user in this draw, excluding draw winners
    await db.query(
      `UPDATE ticket
       SET is_quarantined = TRUE, quarantine_reason = 'high_risk_user', quarantined_at = NOW()
       WHERE activated_by_user_id = $1 AND draw_id = $2 AND is_quarantined = FALSE
         AND ticket.id NOT IN (
           SELECT winner_ticket_id FROM draw
           WHERE winner_ticket_id IS NOT NULL
         )`,
      [userId, drawId],
    );
  } else {
    // Restore only tickets that were quarantined by the automated risk system, excluding draw winners
    await db.query(
      `UPDATE ticket
       SET is_quarantined = FALSE, quarantine_reason = NULL, quarantined_at = NULL
       WHERE activated_by_user_id = $1 AND draw_id = $2
         AND is_quarantined = TRUE AND quarantine_reason = 'high_risk_user'
         AND ticket.id NOT IN (
           SELECT winner_ticket_id FROM draw
           WHERE winner_ticket_id IS NOT NULL
         )`,
      [userId, drawId],
    );
  }
};

/**
 * Returns true when the user's score requires an image upload (medium or high risk).
 */
export const requiresStrongerProof = (riskScore: number): boolean => {
  return riskScore > RISK_THRESHOLDS.LOW_MAX; // score >= 10
};

/**
 * Determine whether an entry counts against the business entry cap.
 * High-risk or duplicate entries do NOT consume the cap.
 */
export const countsAgainstCap = (riskEvaluation: RiskEvaluation, isDuplicate: boolean): boolean => {
  return riskEvaluation.level !== 'high' && !isDuplicate;
};
