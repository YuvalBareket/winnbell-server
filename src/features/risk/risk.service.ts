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

/** Pass pre-fetched user risk data to skip the initial SELECT in evaluateUserRisk. */
export interface PreFetchedUserRisk {
  storedScore: number;
  lastFlaggedAt: Date | null;
}

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Evaluate the risk delta for a user's current submission.
 *
 * Signals:
 *   - Cross-user duplicate identifier      +2–4 (scaled by risk level)
 *   - Submission velocity ≥4 in 24 h       +4
 *   - Submission velocity ≥3 in 24 h       +2
 *   - Sustained weekly volume  ≥20 in 7d   +2
 *   - Sustained monthly volume ≥60 in 30d  +3
 *   - Rapid submission <30 s at same biz   +3
 *   - Sequential identifier guessing       +4
 *   - Threshold probing (amount swap)      +4
 *   - Amount >3× business 30-day average   +2
 *   - Typed >4 chars in <800 ms            +3
 */
export const evaluateUserRisk = async (
  userId: number,
  context?: RiskContext,
  preFetched?: PreFetchedUserRisk,
): Promise<RiskEvaluation> => {
  const pool = getPool();
  const flags: string[] = [];

  // Load stored score — skip if caller already fetched it
  let storedScore: number;
  let lastFlaggedAt: Date | null;

  if (preFetched) {
    storedScore = preFetched.storedScore;
    lastFlaggedAt = preFetched.lastFlaggedAt;
  } else {
    const userResult = await pool.query(
      `SELECT risk_score, risk_last_flagged_at FROM "user" WHERE id = $1`,
      [userId],
    );
    storedScore = Number(userResult.rows[0]?.risk_score ?? 0);
    lastFlaggedAt = userResult.rows[0]?.risk_last_flagged_at ?? null;
  }

  let delta = 0;

  if (context) {
    const { businessId, receiptIdentifier, transactionAmount, isDuplicateCrossUser } = context;

    // Signal 1: cross-user duplicate — penalty scaled by submitter's current risk level
    if (isDuplicateCrossUser) {
      const base = 2;
      let multiplier: number;
      if (storedScore >= 20) multiplier = 2;
      else if (storedScore >= 10) multiplier = 1.5;
      else if (storedScore <= 4) multiplier = 0.5;
      else multiplier = 1;
      delta += Math.round(base * multiplier);
      flags.push('duplicate_identifier_cross_user');
    }

    // Merged signal query: 6 independent ticket reads → 1 round trip
    const signalRes = await pool.query(
      `WITH
        v24h AS (
          SELECT COUNT(*)::int AS cnt, COUNT(DISTINCT business_id)::int AS distinct_biz
          FROM ticket
          WHERE activated_by_user_id = $1 AND entry_source = 'receipt'
            AND receipt_identifier IS NOT NULL
            AND activated_at >= NOW() - INTERVAL '24 hours'
        ),
        v7d AS (
          SELECT COUNT(*)::int AS cnt FROM ticket
          WHERE activated_by_user_id = $1 AND entry_source = 'receipt'
            AND receipt_identifier IS NOT NULL
            AND activated_at >= NOW() - INTERVAL '7 days'
        ),
        v30d AS (
          SELECT COUNT(*)::int AS cnt FROM ticket
          WHERE activated_by_user_id = $1 AND entry_source = 'receipt'
            AND receipt_identifier IS NOT NULL
            AND activated_at >= NOW() - INTERVAL '30 days'
        ),
        rapid AS (
          SELECT COUNT(*)::int AS cnt FROM ticket
          WHERE activated_by_user_id = $1 AND entry_source = 'receipt'
            AND business_id = $2
            AND activated_at >= NOW() - INTERVAL '30 seconds'
        ),
        seq AS (
          SELECT COALESCE(json_agg(ri ORDER BY activated_at DESC), '[]'::json) AS ids
          FROM (
            SELECT receipt_identifier AS ri, activated_at FROM ticket
            WHERE activated_by_user_id = $1 AND business_id = $2
              AND activated_at >= NOW() - INTERVAL '10 minutes'
            ORDER BY activated_at DESC LIMIT 5
          ) sub
        ),
        probe AS (
          SELECT COUNT(*)::int AS cnt FROM ticket
          WHERE activated_by_user_id = $1 AND business_id = $2
            AND receipt_identifier = $3 AND transaction_amount != $4
        ),
        outlier AS (
          SELECT AVG(transaction_amount::float) AS avg_amount FROM ticket
          WHERE business_id = $2 AND transaction_amount IS NOT NULL
            AND activated_at >= NOW() - INTERVAL '30 days'
        )
      SELECT
        (SELECT cnt          FROM v24h)    AS v24h_count,
        (SELECT distinct_biz FROM v24h)    AS v24h_distinct,
        (SELECT cnt          FROM v7d)     AS v7d_count,
        (SELECT cnt          FROM v30d)    AS v30d_count,
        (SELECT cnt          FROM rapid)   AS rapid_count,
        (SELECT ids          FROM seq)     AS seq_ids,
        (SELECT cnt          FROM probe)   AS probe_count,
        (SELECT avg_amount   FROM outlier) AS avg_amount`,
      [userId, businessId, receiptIdentifier, transactionAmount],
    );

    const sr = signalRes.rows[0];
    const recentCount  = Number(sr.v24h_count);
    const distinctBiz  = Number(sr.v24h_distinct);
    const weeklyCount  = Number(sr.v7d_count);
    const monthlyCount = Number(sr.v30d_count);
    const rapidCount   = Number(sr.rapid_count);
    const seqIds: (string | null)[] = Array.isArray(sr.seq_ids) ? sr.seq_ids : [];
    const probeCount   = Number(sr.probe_count);
    const avgAmount    = sr.avg_amount != null ? parseFloat(sr.avg_amount) : null;

    // Signal 2: submission velocity (last 24 hours)
    const adjustedCount = distinctBiz >= 3 ? Math.floor(recentCount / 2) : recentCount;
    if (adjustedCount >= 4) {
      delta += 4;
      flags.push('high_submission_velocity');
    } else if (adjustedCount >= 3) {
      delta += 2;
      flags.push('elevated_submission_velocity');
    }

    // Signal 2b: sustained weekly velocity
    if (weeklyCount >= 20) {
      delta += 2;
      flags.push('sustained_weekly_velocity');
    }

    // Signal 2c: sustained monthly volume
    if (monthlyCount >= 60) {
      delta += 3;
      flags.push('sustained_monthly_volume');
    }

    // Signal: rapid submission — last ticket < 30 seconds ago at same business
    if (rapidCount >= 1) {
      delta += 3;
      flags.push('rapid_submission');
    }

    // Signal: sequential identifier guessing
    if (seqIds.length >= 2) {
      const trailingNum = (s: string | null | undefined): number | null => {
        if (!s) return null;
        const m = s.match(/(\d+)$/);
        return m ? parseInt(m[1], 10) : null;
      };
      const currentNum = trailingNum(receiptIdentifier);
      if (currentNum !== null) {
        const closeCount = seqIds.filter((ri) => {
          const n = trailingNum(ri);
          return n !== null && Math.abs(n - currentNum) <= 5 && n !== currentNum;
        }).length;
        if (closeCount >= 3) {
          delta += 4;
          flags.push('sequential_guessing');
        }
      }
    }

    // Signal: threshold probing — same receipt re-submitted with different amount
    if (probeCount > 0) {
      delta += 4;
      flags.push('threshold_probing');
    }

    // Signal 3: amount outlier vs business 30-day average
    if (
      transactionAmount > 0 &&
      avgAmount != null &&
      !isNaN(avgAmount) &&
      avgAmount > 0 &&
      transactionAmount > avgAmount * 3
    ) {
      delta += 2;
      flags.push('amount_outlier');
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
 * Optionally merge new flag names into the user's accumulated risk_flags array.
 */
export const updateUserRiskScore = async (
  userId: number,
  delta: number,
  client?: PoolClient,
  flags?: string[],
): Promise<void> => {
  if (delta <= 0) return;
  const db = client ?? getPool();
  if (flags && flags.length > 0) {
    await db.query(
      `UPDATE "user" SET
         risk_score           = risk_score + $1,
         risk_last_flagged_at = NOW(),
         risk_flags           = ARRAY(SELECT DISTINCT unnest(COALESCE(risk_flags, '{}') || $3::text[]))
       WHERE id = $2`,
      [delta, userId, flags],
    );
  } else {
    await db.query(
      `UPDATE "user" SET
         risk_score           = risk_score + $1,
         risk_last_flagged_at = NOW()
       WHERE id = $2`,
      [delta, userId],
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
 * Merges the SELECT + UPDATE into a single round trip.
 */
export const syncUserQuarantineState = async (userId: number, drawId: number, client?: PoolClient): Promise<void> => {
  const db = client ?? getPool();

  await db.query(
    `WITH r AS (SELECT risk_score > $3 AS is_high FROM "user" WHERE id = $1)
     UPDATE ticket SET
       is_quarantined    = (SELECT is_high FROM r),
       quarantine_reason = CASE WHEN (SELECT is_high FROM r) THEN 'high_risk_user' ELSE NULL END,
       quarantined_at    = CASE WHEN (SELECT is_high FROM r) THEN NOW() ELSE NULL END
     WHERE activated_by_user_id = $1 AND draw_id = $2
       AND (
         ((SELECT is_high FROM r) IS TRUE  AND is_quarantined = FALSE)
         OR ((SELECT is_high FROM r) IS FALSE AND is_quarantined = TRUE AND quarantine_reason = 'high_risk_user')
       )
       AND id NOT IN (
         SELECT winner_ticket_id FROM draw WHERE winner_ticket_id IS NOT NULL
       )`,
    [userId, drawId, RISK_THRESHOLDS.MEDIUM_MAX],
  );
};

/**
 * Returns true when the user's score requires an image upload (medium or high risk).
 */
export const requiresStrongerProof = (riskScore: number): boolean => {
  return riskScore > RISK_THRESHOLDS.LOW_MAX;
};

/**
 * Determine whether an entry counts against the business entry cap.
 */
export const countsAgainstCap = (riskEvaluation: RiskEvaluation, isDuplicate: boolean): boolean => {
  return riskEvaluation.level !== 'high' && !isDuplicate;
};

/**
 * Decay all user risk scores at campaign close.
 * Tiered reduction: HIGH (≥20) → −4, MEDIUM (10–19) → −2, LOW (1–9) → −1.
 * Returns the number of users whose score was updated.
 */
export const decayAllUserRiskScores = async (): Promise<{ updated: number }> => {
  const pool = getPool();
  const result = await pool.query(`
    UPDATE "user"
    SET risk_score = GREATEST(0, risk_score -
      CASE
        WHEN risk_score >= 20 THEN 4
        WHEN risk_score >= 10 THEN 2
        ELSE 1
      END
    )
    WHERE risk_score > 0 AND role = 'User'
  `);
  return { updated: result.rowCount ?? 0 };
};
