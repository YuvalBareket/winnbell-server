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
  /** Current draw. When provided, the threshold-probing signal is scoped to this draw so a
   *  cross-draw resubmission of a recycled receipt number (allowed since per-draw uniqueness,
   *  2026-07-25) does not falsely flag an honest customer. */
  drawId?: number;
  receiptIdentifier: string;
  transactionAmount: number;
  /** Active (non-quarantined) cross-user duplicate — triggers scaled penalty. */
  isDuplicateCrossUser?: boolean;
  /** Quarantined cross-user duplicate — triggers scaled penalty but allows submission through. */
  isDuplicateQuarantinedCrossUser?: boolean;
  typingDurationMs?: number;
  receiptInputMethod?: 'typed' | 'pasted';
  /** Submitter's IP resolved to a US state outside allowed_states (requireEntryRegion).
   *  Soft signal only — carrier IPs misresolve states, so it scores but never blocks. */
  isOutOfRegion?: boolean;
}

/** Pass pre-fetched user risk data to skip the initial SELECT in evaluateUserRisk. */
export interface PreFetchedUserRisk {
  storedScore: number;
  lastFlaggedAt: Date | null;
  lastDecayedAt: Date | null;
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
 *   - Typed >5 chars in <700 ms            +3
 *   - IP state outside allowed_states      +2
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

  let lastDecayedAt: Date | null;

  if (preFetched) {
    storedScore = preFetched.storedScore;
    lastFlaggedAt = preFetched.lastFlaggedAt;
    lastDecayedAt = preFetched.lastDecayedAt;
  } else {
    const userResult = await pool.query(
      `SELECT risk_score, risk_last_flagged_at, risk_last_decayed_at FROM "user" WHERE id = $1`,
      [userId],
    );
    storedScore = Number(userResult.rows[0]?.risk_score ?? 0);
    lastFlaggedAt = userResult.rows[0]?.risk_last_flagged_at ?? null;
    lastDecayedAt = userResult.rows[0]?.risk_last_decayed_at ?? null;
  }

  // Weekly passive decay: if 7+ days since last flag OR last decay, drop score by 1.
  // Fires at most once per 7-day window regardless of how many submissions occur.
  if (storedScore > 0) {
    const lastActivityMs = Math.max(
      lastFlaggedAt?.getTime() ?? 0,
      lastDecayedAt?.getTime() ?? 0,
    );
    const daysSince = lastActivityMs === 0 ? Infinity : (Date.now() - lastActivityMs) / 86_400_000;
    if (daysSince >= 7) {
      await pool.query(
        `UPDATE "user" SET risk_score = GREATEST(0, risk_score - 1), risk_last_decayed_at = NOW() WHERE id = $1`,
        [userId],
      );
      storedScore = Math.max(0, storedScore - 1);
    }
  }

  let delta = 0;

  if (context) {
    const { businessId, drawId, receiptIdentifier, transactionAmount, isDuplicateCrossUser } = context;

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

    // Signal 1b: quarantined cross-user duplicate — same scaling, submission still allowed.
    // Catches the two-account laundering pattern: Account A gets quarantined, Account B
    // submits the same receipt. The entry goes through but the suspicion is recorded.
    if (context.isDuplicateQuarantinedCrossUser) {
      const base = 2;
      let multiplier: number;
      if (storedScore >= 20) multiplier = 2;
      else if (storedScore >= 10) multiplier = 1.5;
      else if (storedScore <= 4) multiplier = 0.5;
      else multiplier = 1;
      delta += Math.round(base * multiplier);
      flags.push('quarantined_receipt_reuse');
    }

    // Merged signal query: 6 independent ticket reads → 1 round trip
    const signalRes = await pool.query(
      `WITH
        v24h AS (
          SELECT COUNT(*)::int AS cnt
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
        seq24h AS (
          SELECT COALESCE(json_agg(ri ORDER BY ts DESC), '[]'::json) AS ids
          FROM (
            SELECT receipt_identifier AS ri, activated_at AS ts FROM ticket
            WHERE activated_by_user_id = $1 AND business_id = $2
              AND activated_at >= NOW() - INTERVAL '24 hours'
            ORDER BY activated_at DESC LIMIT 20
          ) sub
        ),
        probe AS (
          -- Same receipt submitted with a different amount: counts both accepted tickets
          -- AND below-threshold attempts that were rejected (and left no ticket).
          -- The accepted-ticket count is scoped to the current draw ($5) when provided: receipt
          -- numbers are unique per (business, draw) since 2026-07-25, so a legitimate cross-draw
          -- resubmission of a recycled number with a different amount must NOT read as probing.
          -- (receipt_threshold_attempt has no draw_id but self-purges after 7 days, so it is
          -- naturally bounded to the current campaign window.)
          SELECT (
            (SELECT COUNT(*) FROM ticket
              WHERE activated_by_user_id = $1 AND business_id = $2
                AND receipt_identifier = $3 AND transaction_amount != $4
                AND ($5::int IS NULL OR draw_id = $5))
            + (SELECT COUNT(*) FROM receipt_threshold_attempt
              WHERE user_id = $1 AND business_id = $2
                AND receipt_identifier = $3 AND attempted_amount != $4)
          )::int AS cnt
        ),
        outlier AS (
          SELECT AVG(transaction_amount::float) AS avg_amount FROM ticket
          WHERE business_id = $2 AND transaction_amount IS NOT NULL
            AND activated_at >= NOW() - INTERVAL '30 days'
        )
      SELECT
        (SELECT cnt          FROM v24h)    AS v24h_count,
        (SELECT cnt          FROM v7d)     AS v7d_count,
        (SELECT cnt          FROM v30d)    AS v30d_count,
        (SELECT cnt          FROM rapid)   AS rapid_count,
        (SELECT ids          FROM seq)     AS seq_ids,
        (SELECT ids          FROM seq24h)  AS seq24h_ids,
        (SELECT cnt          FROM probe)   AS probe_count,
        (SELECT avg_amount   FROM outlier) AS avg_amount`,
      [userId, businessId, receiptIdentifier, transactionAmount, drawId ?? null],
    );

    const sr = signalRes.rows[0];
    const recentCount  = Number(sr.v24h_count);
    const weeklyCount  = Number(sr.v7d_count);
    const monthlyCount = Number(sr.v30d_count);
    const rapidCount   = Number(sr.rapid_count);
    const seqIds: (string | null)[]    = Array.isArray(sr.seq_ids)    ? sr.seq_ids    : [];
    const seq24hIds: (string | null)[] = Array.isArray(sr.seq24h_ids) ? sr.seq24h_ids : [];
    const probeCount   = Number(sr.probe_count);
    const avgAmount    = sr.avg_amount != null ? parseFloat(sr.avg_amount) : null;

    // Signal 2: submission velocity (last 24 hours) — raw count, no business buffer.
    // Daily hard cap is 5, so dampening by distinct businesses would neutralise the signal entirely.
    const adjustedCount = recentCount;
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
      delta += 2;
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

    // Signal: slow sequential guessing — same business, 24-hour window.
    // Catches patient attackers probing one identifier per hour (invisible to the 10-min check).
    // Higher threshold (4) and wider range (±10) vs the rapid check to reduce false positives.
    if (seq24hIds.length >= 3 && !flags.includes('sequential_guessing')) {
      const trailingNum = (s: string | null | undefined): number | null => {
        if (!s) return null;
        const m = s.match(/(\d+)$/);
        return m ? parseInt(m[1], 10) : null;
      };
      const currentNum = trailingNum(receiptIdentifier);
      if (currentNum !== null) {
        const closeCount = seq24hIds.filter((ri) => {
          const n = trailingNum(ri);
          return n !== null && Math.abs(n - currentNum) <= 10 && n !== currentNum;
        }).length;
        if (closeCount >= 4) {
          delta += 2;
          flags.push('slow_sequential_guessing');
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

    // Signal: entry submitted from an IP outside the allowed states. Kept small (+2):
    // carrier IPs misresolve states often enough that this alone must never quarantine —
    // it only compounds with genuine fraud signals.
    if (context.isOutOfRegion) {
      delta += 2;
      flags.push('out_of_region_entry');
    }

    // Signal 4: suspiciously fast typing
    if (
      context.receiptInputMethod === 'typed' &&
      receiptIdentifier.length > 5 &&
      context.typingDurationMs !== undefined &&
      context.typingDurationMs < 700
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
  const db = client ?? getPool();

  if (delta === 0) {
    // Clean entry: increment streak counter, subtract 1 point every 6 clean submissions.
    await db.query(
      `UPDATE "user" SET
         risk_clean_entries = risk_clean_entries + 1,
         risk_score = GREATEST(0, risk_score -
           CASE WHEN (risk_clean_entries + 1) % 6 = 0 THEN 1 ELSE 0 END
         )
       WHERE id = $1`,
      [userId],
    );
    return;
  }

  if (delta > 0 && flags && flags.length > 0) {
    await db.query(
      `UPDATE "user" SET
         risk_score           = GREATEST(0, risk_score + $1),
         risk_last_flagged_at = NOW(),
         risk_clean_entries   = 0,
         risk_flags           = ARRAY(SELECT DISTINCT unnest(COALESCE(risk_flags, '{}') || $3::text[]))
       WHERE id = $2`,
      [delta, userId, flags],
    );
  } else if (delta > 0) {
    // Positive delta without flags: update score, reset streak
    await db.query(
      `UPDATE "user" SET
         risk_score           = GREATEST(0, risk_score + $1),
         risk_clean_entries   = 0
       WHERE id = $2`,
      [delta, userId],
    );
  } else {
    // Negative delta (reward): update score, preserve clean entry streak
    await db.query(
      `UPDATE "user" SET
         risk_score = GREATEST(0, risk_score + $1)
       WHERE id = $2`,
      [delta, userId],
    );
  }
};

/**
 * Check if a receipt identifier has already been used by another user for the same business
 * IN THE SAME DRAW. Receipt numbers are unique per campaign, not across all time, so a merchant
 * that recycles receipt numbers between draws does not false-flag honest customers.
 */
export const checkDuplicateReceiptIdentifier = async (
  businessId: number,
  receiptIdentifier: string,
  submittingUserId: number,
  drawId: number,
  client?: PoolClient,
): Promise<DuplicateCheckResult> => {
  const db = client ?? getPool();
  const result = await db.query(
    `SELECT
       MAX(CASE WHEN is_quarantined = FALSE THEN activated_by_user_id END) AS active_user_id,
       BOOL_OR(is_quarantined = FALSE)                                      AS has_active,
       BOOL_OR(is_quarantined = TRUE)                                       AS has_quarantined
     FROM ticket
     WHERE business_id = $1 AND receipt_identifier = $2 AND activated_by_user_id != $3 AND draw_id = $4`,
    [businessId, receiptIdentifier, submittingUserId, drawId],
  );
  const row = result.rows[0];
  return {
    isDuplicate:            row.has_active      ?? false,
    isDuplicateQuarantined: !row.has_active && (row.has_quarantined ?? false),
    matchedUserId:          row.active_user_id ?? undefined,
  };
};

/**
 * Sync a user's quarantine state across all their tickets in a given draw.
 * Merges the SELECT + UPDATE into a single round trip.
 */
export const syncUserQuarantineState = async (userId: number, drawId: number, client?: PoolClient): Promise<void> => {
  const db = client ?? getPool();

  // The un-quarantine branch carries a slot guard: while a ticket sat shadowbanned, its
  // receipt number was released (partial unique index idx_ticket_receipt_unique) and someone
  // else may have legitimately claimed it. Lifting such a ticket would collide with the new
  // claim (and violate the index), so it stays quarantined - the active claim wins. The
  // guard is keyed on the receipt group's ANCHOR identifier so anchor + siblings lift (or
  // stay) together; tickets without a receipt identifier (free/promo/referral) lift freely.
  await db.query(
    `WITH r AS (SELECT risk_score > $3 AS is_high FROM "user" WHERE id = $1)
     UPDATE ticket SET
       is_quarantined    = (SELECT is_high FROM r),
       quarantine_reason = CASE WHEN (SELECT is_high FROM r) THEN 'high_risk_user' ELSE NULL END,
       quarantined_at    = CASE WHEN (SELECT is_high FROM r) THEN NOW() ELSE NULL END
     WHERE activated_by_user_id = $1 AND draw_id = $2
       AND (
         ((SELECT is_high FROM r) IS TRUE  AND is_quarantined = FALSE AND (image_validation_status IS NULL OR image_validation_status != 'passed'))
         OR (
           (SELECT is_high FROM r) IS FALSE AND is_quarantined = TRUE AND quarantine_reason = 'high_risk_user'
           AND NOT EXISTS (
             SELECT 1
             FROM ticket a
             JOIN ticket o
               ON o.business_id = a.business_id
              AND o.draw_id = a.draw_id
              AND o.receipt_identifier = a.receipt_identifier
              AND o.id <> a.id
              AND (o.is_quarantined = FALSE OR o.quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review'))
             WHERE a.id = COALESCE(ticket.anchor_ticket_id, ticket.id)
               AND a.receipt_identifier IS NOT NULL
           )
         )
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
 * Returns the number of users whose score was updated and the IDs of users
 * who crossed from above the HIGH threshold (>20) to at or below it (<=20)
 * after decay, so the caller can sync their quarantine state.
 */
export const decayAllUserRiskScores = async (): Promise<{ updated: number; unquarantinedUserIds: number[] }> => {
  const pool = getPool();
  const result = await pool.query(`
    WITH before AS (
      SELECT id, risk_score AS old_score
      FROM "user"
      WHERE risk_score > 0 AND role = 'User'
    )
    UPDATE "user" u
    SET risk_score = GREATEST(0, u.risk_score -
      CASE
        WHEN u.risk_score >= 20 THEN 4
        WHEN u.risk_score >= 10 THEN 2
        ELSE 1
      END
    )
    FROM before
    WHERE u.id = before.id
    RETURNING u.id,
              u.risk_score AS new_score,
              before.old_score
  `);
  const unquarantinedUserIds: number[] = result.rows
    .filter((r: { id: number; new_score: number; old_score: number }) =>
      Number(r.old_score) > RISK_THRESHOLDS.MEDIUM_MAX && Number(r.new_score) <= RISK_THRESHOLDS.MEDIUM_MAX,
    )
    .map((r: { id: number }) => r.id);
  return { updated: result.rowCount ?? 0, unquarantinedUserIds };
};
