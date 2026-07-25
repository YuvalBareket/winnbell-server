import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../shared/db/db.js';
import { updateUserRiskScore, syncUserQuarantineState } from '../risk/risk.service.js';
import { TesseractProvider } from './providers/tesseract.provider.js';
import { GoogleVisionProvider } from './providers/google-vision.provider.js';
import type { OcrProvider, OcrExpected, OcrValidationResult } from './ocr.types.js';
import { canonicalizeReceiptIdentifier } from './receiptIdentity.js';

// ─── Anti-squatting: contest resolution ───────────────────────────────────────
// A 'contest_pending' ticket carries an image proving the real owner holds a receipt that
// a SQUATTER typed with no image. Its OCR verdict decides the fight. Outcomes:
//   PROVEN + wins slot → supersede the squatter (shadow-ban) and promote this entry.
//   PROVEN but loses (raced another winner / a verified claim survived) → benign
//       'contest_not_won' (truthful 'passed' status, NO penalty - they had valid proof).
//   passed normal OCR but NOT proven for a contest (business/amount unconfirmed) → benign
//       'contest_not_won', NO penalty (good-faith attempt, just didn't clear the higher bar).
//   genuinely failed OCR (not a receipt / identifier absent) → 'ocr_validation_failed' + penalty.
// Everything (including risk-score writes) runs in ONE transaction under the same per-receipt
// advisory lock the submission path uses, so nothing races through and a crash can't split it.
// `proven` is the STRICT contest bar (business name + amount confirmed), not the lenient OCR pass.
async function resolveReceiptContest(
  pool: Pool,
  contestTicketId: number,
  userId: number,
  drawId: number,
  passed: boolean,
  proven: boolean,
  riskDelta: number,
  businessId: number,
  receiptIdentifier: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Same key + namespace as the submission path so a concurrent submission of this receipt
    // cannot slip a new standing claim in between our checks and our commit.
    await client.query(
      `SELECT pg_advisory_xact_lock(4, hashtext($1::text || '|' || $2::text))`,
      [String(businessId), receiptIdentifier],
    );

    // Idempotency / multi-instance guard: only the run that still sees 'contest_pending' may
    // resolve. A double fire (recovery re-queue after resolution, two app instances, webhook
    // + verify) finds a different reason under the row lock and no-ops - so riskDelta is never
    // double-applied and the slot is never promoted twice.
    const guard = await client.query(
      `SELECT quarantine_reason FROM ticket WHERE id = $1 FOR UPDATE`,
      [contestTicketId],
    );
    if (guard.rows[0]?.quarantine_reason !== 'contest_pending') {
      await client.query('ROLLBACK');
      return;
    }

    let won = false;
    const supersededUserIds: number[] = [];

    if (proven) {
      // Never displace a claim that already WON a draw.
      const winnerConflict = await client.query(
        `SELECT 1 FROM ticket o
         JOIN draw d ON d.winner_ticket_id = o.id
         WHERE o.business_id = $1 AND o.receipt_identifier = $2 AND o.activated_by_user_id <> $3 AND o.draw_id = $4
           AND (o.is_quarantined = FALSE OR o.quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review'))
         LIMIT 1`,
        [businessId, receiptIdentifier, userId, drawId],
      );

      if (winnerConflict.rows.length === 0) {
        // Supersede the squatter's group (typed-only standing claims by OTHER users; never a
        // draw winner). RETURNING gives us the users whose tickets were ACTUALLY superseded, so
        // the +2 penalty can never hit a squatter we protected (e.g. a draw winner).
        const superseded = await client.query(
          `WITH squatters AS (
             SELECT id FROM ticket
             WHERE business_id = $1 AND receipt_identifier = $2 AND activated_by_user_id <> $3 AND draw_id = $4
               AND is_quarantined = FALSE AND image_validation_status = 'not_required'
               AND id NOT IN (SELECT winner_ticket_id FROM draw WHERE winner_ticket_id IS NOT NULL)
           )
           UPDATE ticket t
           SET is_quarantined = TRUE, quarantine_reason = 'superseded_by_verified_image', quarantined_at = NOW(),
               -- Record the +3 ON the anchor entry (mirrors the OCR-fail pattern) so admin views
               -- show a "+3" chip on the superseded entry, not just a bump to the user's total.
               risk_score_delta = risk_score_delta + CASE WHEN t.id = s.id THEN 3 ELSE 0 END,
               -- Tag the anchor with a Risk Signal so the admin sees WHY it was penalised
               -- (the +3 reason), not just the number. Dup-safe.
               risk_flags = CASE
                 WHEN t.id = s.id AND NOT (COALESCE(t.risk_flags, '{}') @> ARRAY['superseded_duplicate_receipt'])
                   THEN array_append(COALESCE(t.risk_flags, '{}'), 'superseded_duplicate_receipt')
                 ELSE t.risk_flags END
           FROM squatters s
           WHERE (t.id = s.id OR t.anchor_ticket_id = s.id)
             AND t.id NOT IN (SELECT winner_ticket_id FROM draw WHERE winner_ticket_id IS NOT NULL)
           RETURNING t.activated_by_user_id AS uid`,
          [businessId, receiptIdentifier, userId, drawId],
        );
        for (const r of superseded.rows as Array<{ uid: number }>) {
          if (r.uid && !supersededUserIds.includes(r.uid)) supersededUserIds.push(r.uid);
        }

        // After clearing the squatters, is any OTHER standing claim still held (e.g. a verified
        // image that landed during our OCR)? If so we must not override it - the contest loses.
        const otherStanding = await client.query(
          `SELECT 1 FROM ticket
           WHERE business_id = $1 AND receipt_identifier = $2 AND activated_by_user_id <> $3 AND draw_id = $4
             AND (is_quarantined = FALSE OR quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review'))
           LIMIT 1`,
          [businessId, receiptIdentifier, userId, drawId],
        );
        won = otherStanding.rows.length === 0;
      }
    }

    if (won) {
      // Promote this entry into the standing slot (squatters already left the index above).
      await client.query(
        `UPDATE ticket SET image_validation_status = 'passed', risk_score_delta = risk_score_delta + $2,
               is_quarantined = FALSE, quarantine_reason = NULL, quarantined_at = NULL
         WHERE id = $1`,
        [contestTicketId, riskDelta],
      );
      await client.query(
        `UPDATE ticket SET is_quarantined = FALSE, quarantine_reason = NULL, quarantined_at = NULL WHERE anchor_ticket_id = $1`,
        [contestTicketId],
      );
      await updateUserRiskScore(userId, riskDelta, client);
      for (const squatterUserId of supersededUserIds) {
        // +3: superseding a verified owner is a stronger fraud signal than a normal OCR
        // fail (+2). The squatter typed a number that turned out to belong to someone who
        // proved it, so push their score harder toward the image-required / throttle gates.
        await updateUserRiskScore(squatterUserId, 3, client);
      }
    } else if (passed) {
      // Valid image (passed normal OCR) but did not win the slot - either not proven to the
      // stricter contest bar, or it lost the race to another verified claim. NOT fraud: keep the
      // truthful 'passed' status, release from the slot with a distinct reason, apply NO penalty.
      await client.query(
        `UPDATE ticket SET image_validation_status = 'passed', is_quarantined = TRUE,
               quarantine_reason = 'contest_not_won', quarantined_at = NOW()
         WHERE id = $1 OR anchor_ticket_id = $1`,
        [contestTicketId],
      );
    } else {
      // Genuinely failed OCR (not a receipt / identifier absent) → real fail + penalty.
      await client.query(
        `UPDATE ticket SET image_validation_status = 'failed', risk_score_delta = risk_score_delta + 2 WHERE id = $1`,
        [contestTicketId],
      );
      await client.query(
        `UPDATE ticket SET is_quarantined = TRUE, quarantine_reason = 'ocr_validation_failed', quarantined_at = NOW()
         WHERE id = $1 OR anchor_ticket_id = $1`,
        [contestTicketId],
      );
      await updateUserRiskScore(userId, 2, client);
    }

    // Quarantine sync for the contester + any superseded squatters, inside the same txn.
    await syncUserQuarantineState(userId, drawId, client);
    for (const squatterUserId of supersededUserIds) {
      await syncUserQuarantineState(squatterUserId, drawId, client);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Duplicate-document handling ──────────────────────────────────────────────
// The image is a receipt already used at this business under a different number. Silent
// shadow-ban: the entry looks accepted but is quarantined (never drawn), +3 risk, and a
// 'duplicate_document' flag so admins see WHY. Mirrors the OCR-fail write shape.
async function handleDuplicateDocument(
  client: PoolClient,
  ticketId: number,
  userId: number,
  drawId: number,
): Promise<void> {
  await client.query(
    `UPDATE ticket SET image_validation_status = 'failed', risk_score_delta = risk_score_delta + 3,
       risk_flags = CASE WHEN NOT (COALESCE(risk_flags, '{}') @> ARRAY['duplicate_document'])
                         THEN array_append(COALESCE(risk_flags, '{}'), 'duplicate_document') ELSE risk_flags END
     WHERE id = $1`,
    [ticketId],
  );
  await client.query(
    `UPDATE ticket SET is_quarantined = TRUE, quarantine_reason = 'duplicate_document', quarantined_at = NOW()
     WHERE id = $1 OR anchor_ticket_id = $1`,
    [ticketId],
  );
  await updateUserRiskScore(userId, 3, client);
  await syncUserQuarantineState(userId, drawId, client);
}

// A VERIFIED image beats an unproven TYPED-ONLY claim on the same document, even under a
// different number (owner typed the invoice #, squatter typed the receipt #). Same treatment
// as a superseded contest squatter: silent shadow-ban, +3, 'superseded_duplicate_receipt' flag,
// never displacing a draw winner. `anchorIds` are the typed-only claims being disqualified.
async function supersedeTypedOnlyDocumentClaims(
  client: PoolClient,
  anchorIds: number[],
  drawId: number,
): Promise<void> {
  if (anchorIds.length === 0) return;
  const res = await client.query(
    `UPDATE ticket t
     SET is_quarantined = TRUE, quarantine_reason = 'superseded_by_verified_image', quarantined_at = NOW(),
         risk_score_delta = risk_score_delta + CASE WHEN t.id = ANY($1::int[]) THEN 3 ELSE 0 END,
         risk_flags = CASE WHEN t.id = ANY($1::int[]) AND NOT (COALESCE(t.risk_flags, '{}') @> ARRAY['superseded_duplicate_receipt'])
                           THEN array_append(COALESCE(t.risk_flags, '{}'), 'superseded_duplicate_receipt') ELSE t.risk_flags END
     WHERE (t.id = ANY($1::int[]) OR t.anchor_ticket_id = ANY($1::int[]))
       AND t.id NOT IN (SELECT winner_ticket_id FROM draw WHERE winner_ticket_id IS NOT NULL)
     RETURNING t.activated_by_user_id AS uid`,
    [anchorIds],
  );
  const users = [...new Set(res.rows.map((r: { uid: number }) => r.uid).filter(Boolean))];
  for (const uid of users) {
    await updateUserRiskScore(uid, 3, client);
    await syncUserQuarantineState(uid, drawId, client);
  }
}

// ─── Normal (non-contest) OCR resolution ──────────────────────────────────────
// Fingerprint the document, detect a reused document (same image / a cropped fragment re-uploaded
// under a different number), supersede unproven typed-only claims when THIS image proves the
// receipt, then apply the pass/fail verdict - all in ONE transaction under the same per-receipt
// advisory lock the submission + contest paths use. That serialization is what stops a concurrent
// OCR resolution or submission from racing a second standing entry through, and the transaction is
// what stops a crash from leaving a half-applied verdict (e.g. status='failed' but not quarantined,
// which would sit in the draw pool as a live entry).
async function resolveReceiptValidation(
  pool: Pool,
  ticketId: number,
  userId: number,
  drawId: number,
  businessId: number,
  identifier: string | null,
  result: OcrValidationResult,
  passed: boolean,
  contestProven: boolean,
  riskDelta: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(4, hashtext($1::text || '|' || $2::text))`,
      [String(businessId), identifier ?? ''],
    );

    // Idempotency / multi-instance guard: only a ticket still awaiting OCR (pending, or an
    // ocr_error being retried) may be resolved. A double fire - recovery re-queue after a prior
    // resolution, two app instances, a retried provider blip - finds a final status under the row
    // lock and no-ops, so the risk delta is never applied twice and the slot never double-promoted.
    const guard = await client.query(
      `SELECT image_validation_status FROM ticket WHERE id = $1 FOR UPDATE`,
      [ticketId],
    );
    const status: string | undefined = guard.rows[0]?.image_validation_status;
    if (status !== 'pending' && status !== 'ocr_error') {
      await client.query('ROLLBACK');
      return;
    }

    // Store the document fingerprint on the anchor so FUTURE entries can be checked against it.
    const tokens: string[] = result.documentTokens ?? [];
    await client.query(`UPDATE ticket SET receipt_tokens = $2 WHERE id = $1`, [ticketId, tokens]);

    // ── Duplicate-document detection (one receipt = one entry) ──────────────────
    // A real receipt carries several identifier-like numbers (receipt #, invoice #, order #).
    // Typing a different one off the SAME image, or cropping the first out and re-uploading,
    // would otherwise each earn an entry. Two asymmetric checks, both TYPED-id <-> tokens
    // (never token-set <-> token-set, so shared boilerplate can't cross-flag honest people):
    //   A) another valid entry's identifier appears among THIS image's tokens (same image reused
    //      under its other number), OR
    //   B) THIS typed identifier appears in a PRIOR entry's token set (cropped + re-uploaded).
    // If the user typed a FRAGMENT of a number on the image, complete it to that full number so
    // partials of one number can't each earn an entry. Same-identifier matches are excluded (that
    // is the dedup / contest path, handled at submit time and by resolveReceiptContest).
    const canonical = identifier ? canonicalizeReceiptIdentifier(identifier, tokens) : null;
    if (result.isReceipt && businessId && (tokens.length > 0 || identifier)) {
      const colliders = await client.query(
        `SELECT id, (is_quarantined = FALSE AND image_validation_status = 'not_required') AS typed_only
         FROM ticket
         WHERE business_id = $1 AND id <> $2 AND draw_id = $6
           AND (is_quarantined = FALSE OR quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review'))
           AND (
             (receipt_identifier IS NOT NULL AND receipt_identifier = ANY($3::text[]) AND receipt_identifier IS DISTINCT FROM $4)
             OR ($5::text IS NOT NULL AND receipt_tokens @> ARRAY[$5::text])
             OR (
               receipt_identifier IS NOT NULL
               AND length(receipt_identifier) >= 8
               AND receipt_identifier IS DISTINCT FROM $4
               AND receipt_identifier <> ALL($3::text[])
               AND EXISTS (SELECT 1 FROM unnest($3::text[]) bt WHERE bt <> receipt_identifier AND position(receipt_identifier IN bt) > 0)
             )
           )`,
        [businessId, ticketId, tokens, identifier, canonical, drawId],
      );
      if (colliders.rows.length > 0) {
        const anyImageBacked = colliders.rows.some((r: { typed_only: boolean }) => !r.typed_only);
        if (anyImageBacked || !contestProven) {
          // Someone already PROVED this document with an image, OR this image can't prove it
          // (business + amount not both confirmed) - so THIS entry is the later duplicate.
          await handleDuplicateDocument(client, ticketId, userId, drawId);
          await client.query('COMMIT');
          return;
        }
        // This image is PROVEN and every competing claim is just a typed number: this user holds
        // the real receipt. Disqualify those unproven claims (proof beats assertion), then let
        // this entry stand as a valid one below.
        const typedOnlyIds = colliders.rows
          .filter((r: { typed_only: boolean }) => r.typed_only)
          .map((r: { id: number }) => r.id);
        await supersedeTypedOnlyDocumentClaims(client, typedOnlyIds, drawId);
      }
    }

    if (passed) {
      await client.query(
        `UPDATE ticket SET image_validation_status = 'passed', risk_score_delta = risk_score_delta + $2 WHERE id = $1`,
        [ticketId, riskDelta],
      );
      // Unquarantine anchor + siblings that were held for OCR (awaiting the first pass, or held
      // after a provider error that a retry has now cleared).
      await client.query(
        `UPDATE ticket
         SET is_quarantined = FALSE, quarantine_reason = NULL, quarantined_at = NULL
         WHERE (id = $1 OR anchor_ticket_id = $1)
           AND quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review')`,
        [ticketId],
      );
      await updateUserRiskScore(userId, riskDelta, client);
      await syncUserQuarantineState(userId, drawId, client);
    } else {
      await client.query(
        `UPDATE ticket SET image_validation_status = 'failed', risk_score_delta = risk_score_delta + 2 WHERE id = $1`,
        [ticketId],
      );
      await client.query(
        `UPDATE ticket
         SET is_quarantined = TRUE, quarantine_reason = 'ocr_validation_failed', quarantined_at = NOW()
         WHERE (id = $1 OR anchor_ticket_id = $1)
           AND (quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review') OR quarantine_reason IS NULL)`,
        [ticketId],
      );
      await updateUserRiskScore(userId, 2, client);
      await syncUserQuarantineState(userId, drawId, client);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err; // let the caller's catch record an ocr_error for retry
  } finally {
    client.release();
  }
}

// ─── Provider Factory ─────────────────────────────────────────────────────────
// Set OCR_PROVIDER=google in .env to use Google Vision (recommended for production).
// Defaults to tesseract for local dev without credentials.

function getProvider(): OcrProvider {
  const provider = process.env.OCR_PROVIDER ?? 'tesseract';
  switch (provider) {
    case 'google':
      return new GoogleVisionProvider();
    case 'tesseract':
      return new TesseractProvider();
    default:
      console.warn(`Unknown OCR_PROVIDER "${provider}", falling back to tesseract`);
      return new TesseractProvider();
  }
}

// ─── Async Validator ──────────────────────────────────────────────────────────
// Called after ticket commit — runs in background, never blocks the response.
// On failure: quarantines the ticket and adds a risk penalty.
// On provider error: quarantines for manual review (cannot be exploited by crashing the OCR provider).

/**
 * On startup: re-queue any tickets whose OCR job was lost (e.g. server restart mid-flight).
 * Targets tickets with image_validation_status = 'pending' older than 2 minutes.
 */
export const recoverStaleOcrJobs = async (): Promise<void> => {
  const pool = getPool();

  // Fix sibling tickets whose anchor already has a final OCR result but whose quarantine_reason
  // was never propagated (e.g. from before anchor_ticket_id existed, or a crash mid-update).
  const fixRes = await pool.query(`
    UPDATE ticket t
    SET is_quarantined    = CASE WHEN a.image_validation_status = 'passed' THEN FALSE ELSE TRUE END,
        quarantine_reason = CASE
          WHEN a.image_validation_status = 'passed'    THEN NULL
          WHEN a.image_validation_status = 'failed'    THEN 'ocr_validation_failed'
          WHEN a.image_validation_status = 'ocr_error' THEN 'ocr_error_pending_review'
        END,
        quarantined_at    = CASE WHEN a.image_validation_status = 'passed' THEN NULL ELSE NOW() END
    FROM ticket a
    WHERE t.anchor_ticket_id = a.id
      AND t.quarantine_reason = 'ocr_pending'
      AND a.image_validation_status IN ('passed', 'failed', 'ocr_error')
  `);
  if ((fixRes.rowCount ?? 0) > 0) {
    console.log(`[OCR] Fixed ${fixRes.rowCount} sibling ticket(s) with stale quarantine reason.`);
  }

  // Re-queue OCR for two cases:
  //  - 'pending': the job was never completed (server restart mid-flight).
  //  - 'ocr_error': the OCR PROVIDER errored (network / Vision down / rate limit) - NOT the
  //    customer's fault. Retrying self-heals once the provider recovers, so an honest entry is
  //    not held forever by an infrastructure blip. (Genuine 'failed' validations are NOT retried.)
  const result = await pool.query(`
    SELECT
      t.id AS ticket_id,
      t.activated_by_user_id AS user_id,
      t.draw_id,
      t.receipt_image_url,
      t.receipt_identifier,
      t.transaction_amount,
      t.transaction_date,
      b.name AS business_name
    FROM ticket t
    LEFT JOIN business b ON b.id = t.business_id
    WHERE (
        (t.image_validation_status = 'pending' AND t.activated_at < NOW() - INTERVAL '2 minutes')
        -- Back off ocr_error retries: only re-queue an error at least 5 minutes old. Without this
        -- a boot (or the 6h sweep) racing a fresh provider blip would retry instantly and thrash.
        -- Concurrent double-processing is separately prevented by the resolve idempotency guard.
        OR (t.image_validation_status = 'ocr_error'
            AND COALESCE(t.quarantined_at, t.activated_at) < NOW() - INTERVAL '5 minutes')
      )
      AND t.receipt_image_url IS NOT NULL
  `);

  if (result.rows.length === 0) return;

  console.log(`[OCR] Recovering ${result.rows.length} stale OCR job(s)...`);
  for (const row of result.rows) {
    if (!row.receipt_image_url) continue;
    validateReceiptAsync(row.ticket_id, row.user_id, row.draw_id, row.receipt_image_url, {
      identifier: row.receipt_identifier,
      amount: row.transaction_amount ? parseFloat(row.transaction_amount) : 0,
      date: row.transaction_date,
      businessName: row.business_name,
    });
  }
};

export const validateReceiptAsync = (
  ticketId: number,
  userId: number,
  drawId: number,
  imageUrl: string,
  expected: OcrExpected,
): void => {
  setImmediate(async () => {
    const pool = getPool();
    try {
      const provider = getProvider();
      const result = await provider.validate(imageUrl, expected);

      // Hard requirements — instant fail if either is missing
      const hardFail = !result.isReceipt || !result.identifierFound;

      // Soft checks — three states:
      //   true  = found on receipt and matches user's claim ✓
      //   false = found on receipt but doesn't match → fraud signal → fail
      //   null  = not visible in image → can't verify → let it slide
      const softChecks = [result.amountMatches, result.dateMatches, result.businessNameFound];
      const anyWrong   = softChecks.some(v => v === false);
      const anyMissing = softChecks.some(v => v === null);

      // If any check found a value but it contradicts the user's claim → fail
      // If all found checks match, but some couldn't be verified → partial pass (-1)
      // If everything verified and matches → full pass (-3)
      const fullPass    = !hardFail && !anyWrong && !anyMissing;
      const partialPass = !hardFail && !anyWrong && anyMissing;
      const passed      = fullPass || partialPass;
      const riskDelta   = fullPass ? -3 : partialPass ? -1 : 2;

      // Anti-squatting: a 'contest_pending' ticket is a user proving (with this image) that a
      // receipt a SQUATTER typed with no image is really theirs. Overriding another human's
      // entry demands a STRICTER bar than a normal OCR pass: the business name AND the amount
      // must be positively confirmed on the image (not merely "not contradicted"). Without this,
      // any photo that merely CONTAINS the number string could supersede an honest typed-only
      // entry (identifierFound is a naive substring; businessNameFound alone is true|null and can
      // never fail). Requiring both confirmed means the contester must hold a legible receipt
      // that names the business and shows the amount - effectively the real receipt.
      const contestProven = passed && result.businessNameFound === true && result.amountMatches === true;
      const meta = await pool.query(
        `SELECT quarantine_reason, business_id, receipt_identifier FROM ticket WHERE id = $1`,
        [ticketId],
      );
      const quarantineReason: string | null = meta.rows[0]?.quarantine_reason ?? null;
      const businessId: number = meta.rows[0]?.business_id;
      const identifier: string | null = meta.rows[0]?.receipt_identifier ?? null;

      // A 'contest_pending' ticket has its own locked-transaction resolver. Route it there BEFORE
      // any duplicate-document handling: a contest is a SAME-number dispute, and the contester's
      // image naturally contains the squatter's number, so running the dup check on it would
      // mislabel a legitimate contester as a duplicate.
      if (quarantineReason === 'contest_pending') {
        await resolveReceiptContest(
          pool, ticketId, userId, drawId, passed, contestProven, riskDelta,
          businessId, meta.rows[0].receipt_identifier,
        );
        return;
      }

      // Everything else (fingerprint, duplicate-document detection, supersede, pass/fail) runs in
      // one transaction under the per-receipt advisory lock so concurrency can't race a second
      // standing entry and a crash can't leave a half-applied verdict.
      await resolveReceiptValidation(
        pool, ticketId, userId, drawId, businessId, identifier, result, passed, contestProven, riskDelta,
      );
    } catch (err) {
      // Provider error (network, tesseract crash, etc.) or a resolution that rolled back —
      // quarantine pending manual review / retry. Guarded so it can NEVER overwrite a verdict
      // that a concurrent run already committed (a resolved 'passed'/'failed' stays as-is).
      console.error(`[OCR] Validation error for ticket ${ticketId}:`, err);
      try {
        await pool.query(
          `UPDATE ticket SET image_validation_status = 'ocr_error'
           WHERE id = $1 AND image_validation_status IN ('pending', 'ocr_error')`,
          [ticketId],
        );
        await pool.query(
          `UPDATE ticket
           SET is_quarantined    = TRUE,
               quarantine_reason = 'ocr_error_pending_review',
               quarantined_at    = NOW()
           WHERE (id = $1 OR anchor_ticket_id = $1)
             AND (quarantine_reason = 'ocr_pending' OR quarantine_reason IS NULL)`,
          [ticketId],
        );
      } catch (dbErr) {
        console.error(`[OCR] Failed to record OCR error for ticket ${ticketId}:`, dbErr);
      }
    }
  });
};
 