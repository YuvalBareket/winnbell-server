import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../shared/db/db.js';
import { safeRollback } from '../../shared/db/txn.js';
import { updateUserRiskScore, syncUserQuarantineState } from '../risk/risk.service.js';
import { GoogleVisionProvider } from './providers/google-vision.provider.js';
import { GeminiVisionProvider } from './providers/gemini-vision.provider.js';
import { judgeReceiptLlm, applyLlmTightening } from './receiptValidationLlm.js';
import type { OcrProvider, OcrExpected, OcrValidationResult } from './ocr.types.js';
import { canonicalizeReceiptIdentifier } from './receiptIdentity.js';
import { recordFunnelEvent } from '../analytics/analytics.service.js';

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
  failPenalty: number,
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
      `SELECT quarantine_reason, to_char(transaction_date, 'YYYY-MM-DD') AS tx_date, transaction_amount
       FROM ticket WHERE id = $1 FOR UPDATE`,
      [contestTicketId],
    );
    if (guard.rows[0]?.quarantine_reason !== 'contest_pending') {
      await safeRollback(client);
      return;
    }
    // A contest fights over ONE per-day dedup slot: the (identifier, claimed day) this entry
    // targets. Claims on other days are independent slots (daily-reset check numbers) and are
    // never displaced by this contest.
    const contestDate: string | null = guard.rows[0]?.tx_date ?? null;
    const contestCents: number | null = guard.rows[0]?.transaction_amount != null
      ? Math.round(parseFloat(guard.rows[0].transaction_amount) * 100) : null;

    let won = false;
    let docSeq: number | null = null;
    let duplicateOfVerified = false;
    const supersededUserIds: number[] = [];

    if (proven) {
      // Never displace a claim that already WON a draw.
      const winnerConflict = await client.query(
        `SELECT 1 FROM ticket o
         JOIN draw d ON d.winner_ticket_id = o.id
         WHERE o.business_id = $1 AND o.receipt_identifier = $2 AND o.activated_by_user_id <> $3 AND o.draw_id = $4
           AND o.transaction_date IS NOT DISTINCT FROM $5::date
           AND (o.is_quarantined = FALSE OR o.quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review'))
         LIMIT 1`,
        [businessId, receiptIdentifier, userId, drawId, contestDate],
      );

      if (winnerConflict.rows.length === 0) {
        // Supersede the squatter's group (typed-only standing claims by OTHER users; never a
        // draw winner). RETURNING gives us the users whose tickets were ACTUALLY superseded, so
        // the +2 penalty can never hit a squatter we protected (e.g. a draw winner).
        const superseded = await client.query(
          `WITH squatters AS (
             SELECT id FROM ticket
             WHERE business_id = $1 AND receipt_identifier = $2 AND activated_by_user_id <> $3 AND draw_id = $4
               AND transaction_date IS NOT DISTINCT FROM $5::date
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
          [businessId, receiptIdentifier, userId, drawId, contestDate],
        );
        for (const r of superseded.rows as Array<{ uid: number }>) {
          if (r.uid && !supersededUserIds.includes(r.uid)) supersededUserIds.push(r.uid);
        }

        // After clearing the squatters, what SAME-DAY claims still stand (e.g. a verified
        // image that landed during our OCR, or a degenerate register printing the same number
        // on every same-day receipt)? The distinct-document rung decides with scan-verified
        // AMOUNTS: all-different amounts = different purchases → this contest coexists in a
        // bumped receipt_doc_seq slot; an equal amount on a VERIFIED claim = the same paper →
        // duplicate; an equal amount on a still-unverified claim = an in-flight race we cannot
        // adjudicate yet → benign contest_not_won (no penalty), the slot stays theirs.
        const otherStanding = await client.query(
          `SELECT image_validation_status = 'passed' AS verified,
                  transaction_amount::text AS amount,
                  receipt_doc_seq
           FROM ticket
           WHERE business_id = $1 AND receipt_identifier = $2 AND activated_by_user_id <> $3 AND draw_id = $4
             AND transaction_date IS NOT DISTINCT FROM $5::date
             AND (is_quarantined = FALSE OR quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review'))`,
          [businessId, receiptIdentifier, userId, drawId, contestDate],
        );
        if (otherStanding.rows.length === 0) {
          won = true;
        } else {
          const centsOf = (a: string | null) => a != null ? Math.round(parseFloat(a) * 100) : null;
          const sameAmount = otherStanding.rows.filter(
            (r: { amount: string | null }) => centsOf(r.amount) === contestCents,
          );
          if (sameAmount.length === 0) {
            won = true;
            docSeq = otherStanding.rows.reduce(
              (m: number, r: { receipt_doc_seq: number }) => Math.max(m, Number(r.receipt_doc_seq)), 0,
            ) + 1;
          } else if (sameAmount.some((r: { verified: boolean }) => r.verified === true)) {
            duplicateOfVerified = true;
          }
        }
      }
    }

    if (won) {
      // Promote this entry into the standing slot (squatters already left the index above;
      // a coexisting distinct document takes the next doc_seq slot).
      // Deferred reward: a low-clean-streak account earns 0 here, not -3/-1 (laundering guard).
      const appliedDelta = await deferredOcrRewardDelta(client, userId, riskDelta);
      await client.query(
        `UPDATE ticket SET image_validation_status = 'passed', risk_score_delta = risk_score_delta + $2,
               receipt_doc_seq = COALESCE($3, receipt_doc_seq),
               is_quarantined = FALSE, quarantine_reason = NULL, quarantined_at = NULL
         WHERE id = $1`,
        [contestTicketId, appliedDelta, docSeq],
      );
      await client.query(
        `UPDATE ticket SET is_quarantined = FALSE, quarantine_reason = NULL, quarantined_at = NULL WHERE anchor_ticket_id = $1`,
        [contestTicketId],
      );
      // Zeroed reward: skip the call - updateUserRiskScore's delta-0 branch would double
      // count a "clean entry" the submission path already counted.
      if (appliedDelta !== 0) await updateUserRiskScore(userId, appliedDelta, client);
      for (const squatterUserId of supersededUserIds) {
        // +3: superseding a verified owner is a stronger fraud signal than a normal OCR
        // fail (+2). The squatter typed a number that turned out to belong to someone who
        // proved it, so push their score harder toward the image-required / throttle gates.
        await updateUserRiskScore(squatterUserId, 3, client);
      }
    } else if (duplicateOfVerified) {
      // Same number, same day, same amount as an already-VERIFIED claim: this contest photo
      // shows the same paper another user proved. That is the duplicate-document case, not a
      // benign loss - shadow-ban with the standard +3.
      await handleDuplicateDocument(client, contestTicketId, userId, drawId);
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
      // Genuinely failed OCR (not a receipt / identifier absent) → real fail + penalty
      // (failPenalty is 0 for honest-mistake failures like a with-tip claim).
      await client.query(
        `UPDATE ticket SET image_validation_status = 'failed', risk_score_delta = risk_score_delta + $2 WHERE id = $1`,
        [contestTicketId, failPenalty],
      );
      await client.query(
        `UPDATE ticket SET is_quarantined = TRUE, quarantine_reason = 'ocr_validation_failed', quarantined_at = NOW()
         WHERE id = $1 OR anchor_ticket_id = $1`,
        [contestTicketId],
      );
      if (failPenalty !== 0) await updateUserRiskScore(userId, failPenalty, client);
    }

    // Quarantine sync for the contester + any superseded squatters, inside the same txn.
    await syncUserQuarantineState(userId, drawId, client);
    for (const squatterUserId of supersededUserIds) {
      await syncUserQuarantineState(squatterUserId, drawId, client);
    }

    await client.query('COMMIT');
    // Funnel: contest verdict (internal-only). won -> cleared; otherwise the entry stays out.
    recordFunnelEvent({
      eventType: won ? 'submission_ocr_cleared' : 'submission_ocr_rejected',
      userId, reasonCode: won ? null : 'receipt_contested', meta: { ticket_id: contestTicketId },
    });
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}

// ─── Deferred OCR reputation reward (image-authenticity posture) ──────────────
// A full OCR pass proves the CONTENT of a photographed receipt, not that the receipt is the
// submitter's OWN: real receipts from the trash or a social-media screenshot pass every content
// check, and each -3 reward would LAUNDER such an account toward low-risk (no image required,
// trusted). So the reward is deferred: negative OCR deltas only apply once the account holds a
// streak of OCR_REWARD_MIN_CLEAN_STREAK submissions with zero risk signals (risk_clean_entries
// resets on any flag - and farming fast is itself a velocity flag). Honest users lose nothing:
// a reward only ever matters to a score already above 0, i.e. an account carrying fraud
// signals. Positive deltas (penalties) always apply unchanged. The TICKET's risk_score_delta
// records what was ACTUALLY applied, so admin chips stay truthful.
const OCR_REWARD_MIN_CLEAN_STREAK = 6;

async function deferredOcrRewardDelta(
  client: PoolClient,
  userId: number,
  riskDelta: number,
): Promise<number> {
  if (riskDelta >= 0) return riskDelta;
  const r = await client.query(`SELECT risk_clean_entries FROM "user" WHERE id = $1`, [userId]);
  const streak = Number(r.rows[0]?.risk_clean_entries ?? 0);
  return streak >= OCR_REWARD_MIN_CLEAN_STREAK ? riskDelta : 0;
}

// ─── Same-business velocity signal (receipt-farming signature) ────────────────
// Several image-VERIFIED receipts from one business inside a day is the farming shape
// (collecting other customers' receipts at a single location); a loyal regular produces one.
// FLAG ONLY - admin-visible on the ticket and the user, never a score change and never a
// block, precisely because that loyal regular exists.
const SAME_BUSINESS_VERIFIED_24H_FLAG_AT = 3;
const SAME_BUSINESS_VELOCITY_FLAG = 'same_business_receipt_velocity';

// ─── Duplicate-document handling ──────────────────────────────────────────────
// The image is a receipt already used at this business (same paper under a different number,
// or an unrelaxable claim on a taken number). Silent shadow-ban: the entry looks accepted but
// is quarantined (never drawn), +penalty risk, and a 'duplicate_document' flag so admins see
// WHY. Mirrors the OCR-fail write shape. penalty=0 is for NON-fraud duplicates (e.g. a
// different-day claim whose receipt prints no date, so the relaxation cannot be verified):
// the entry stays out of the draw but the user is not treated as a fraud signal.
async function handleDuplicateDocument(
  client: PoolClient,
  ticketId: number,
  userId: number,
  drawId: number,
  penalty = 3,
): Promise<void> {
  await client.query(
    `UPDATE ticket SET image_validation_status = 'failed', risk_score_delta = risk_score_delta + $2,
       risk_flags = CASE WHEN NOT (COALESCE(risk_flags, '{}') @> ARRAY['duplicate_document'])
                         THEN array_append(COALESCE(risk_flags, '{}'), 'duplicate_document') ELSE risk_flags END
     WHERE id = $1`,
    [ticketId, penalty],
  );
  await client.query(
    `UPDATE ticket SET is_quarantined = TRUE, quarantine_reason = 'duplicate_document', quarantined_at = NOW()
     WHERE id = $1 OR anchor_ticket_id = $1`,
    [ticketId],
  );
  if (penalty !== 0) await updateUserRiskScore(userId, penalty, client);
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
  failPenalty: number,
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
      await safeRollback(client);
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
          // Funnel (internal-only; the user is never told - shadowban invariant).
          recordFunnelEvent({
            eventType: 'submission_ocr_rejected', userId,
            reasonCode: 'duplicate_receipt', meta: { ticket_id: ticketId },
          });
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

    // ── Date ladder (per-day dedup slots - scan evidence only) ──────────────────
    // The dedup identity is (business, draw, identifier, DAY). A passing entry that shares
    // its number with other standing claims may only stand when the relaxation it relies on
    // is verified by THIS scan:
    //  - claims on OTHER days only → the printed date must positively match the claimed date
    //    (dateMatches === true). Unverifiable (no legible date printed) = no relaxation is
    //    GRANTED, but it is no longer treated as a duplicate either: the entry is HELD for
    //    review under 'date_unreadable_review' (an undated receipt is not a fraud signal,
    //    and faded thermal dates are common exactly at the daily-reset registers this
    //    rung exists for).
    //  - a claim on the SAME day (degenerate registers that repeat numbers within a day, or
    //    a race) → the distinct-document rung: scan-verified AMOUNTS discriminate. A different
    //    amount is a different purchase → coexist in a bumped receipt_doc_seq slot; the same
    //    amount is the same paper → duplicate (+3 vs a verified claim). Typed-only same-day
    //    assertions lose to proof exactly like the collider path (strict contest bar).
    let docSeq: number | null = null;
    if (passed && identifier) {
      const selfRow = await client.query(
        `SELECT to_char(transaction_date, 'YYYY-MM-DD') AS tx_date, transaction_amount
         FROM ticket WHERE id = $1`,
        [ticketId],
      );
      const txDate: string | null = selfRow.rows[0]?.tx_date ?? null;
      const txCents: number | null = selfRow.rows[0]?.transaction_amount != null
        ? Math.round(parseFloat(selfRow.rows[0].transaction_amount) * 100) : null;
      const claims = await client.query(
        `SELECT id,
                transaction_date IS NOT DISTINCT FROM $5::date AS same_day,
                image_validation_status = 'passed' AS verified,
                (is_quarantined = FALSE AND image_validation_status = 'not_required') AS typed_only,
                transaction_amount::text AS amount,
                receipt_doc_seq
         FROM ticket
         WHERE business_id = $1 AND receipt_identifier = $2 AND draw_id = $3 AND id <> $4
           AND (is_quarantined = FALSE OR quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review'))`,
        [businessId, identifier, drawId, ticketId, txDate],
      );
      const sameDay = claims.rows.filter((r: { same_day: boolean }) => r.same_day === true);
      const quarantineAsDuplicate = async (penalty: number) => {
        await handleDuplicateDocument(client, ticketId, userId, drawId, penalty);
        await client.query('COMMIT');
        recordFunnelEvent({
          eventType: 'submission_ocr_rejected', userId,
          reasonCode: 'duplicate_receipt', meta: { ticket_id: ticketId },
        });
      };
      if (claims.rows.length > 0 && sameDay.length === 0) {
        if (result.dateMatches !== true) {
          // The number is claimed on OTHER days and THIS scan could not read a printed date.
          // (dateMatches === false would have failed the verdict upstream, so only the
          // unreadable NULL reaches here - this is "can't verify", never "contradicted".)
          // Quarantining it as a duplicate silently killed honest cross-day customers
          // whose thermal date faded. Instead: HOLD for human review - truthful 'passed'
          // content status (everything legible matched the claim), NO reward, NO penalty,
          // quarantined under a distinct, countable reason. The cross-day dup exploit
          // stays closed: a held entry never enters the pool, is never auto-granted, and
          // the partial unique index ignores it, so it blocks no one. Admins release it
          // via the image-decision approve (which re-checks the slot) or leave it held.
          await client.query(
            `UPDATE ticket SET image_validation_status = 'passed' WHERE id = $1`,
            [ticketId],
          );
          await client.query(
            `UPDATE ticket
             SET is_quarantined = TRUE, quarantine_reason = 'date_unreadable_review', quarantined_at = NOW()
             WHERE id = $1 OR anchor_ticket_id = $1`,
            [ticketId],
          );
          await syncUserQuarantineState(userId, drawId, client);
          await client.query('COMMIT');
          // Funnel: held, not cleared (internal-only; the user is never told - shadowban
          // invariant). Distinct meta so the hold is countable apart from real rejections.
          recordFunnelEvent({
            eventType: 'submission_ocr_rejected', userId,
            meta: { ticket_id: ticketId, held: 'date_unreadable' },
          });
          return;
        }
        // Printed date verified → this entry owns its per-day slot (doc_seq stays 0).
      } else if (sameDay.length > 0) {
        const typedOnly = sameDay.filter((r: { typed_only: boolean }) => r.typed_only === true);
        const imageBacked = sameDay.filter((r: { typed_only: boolean }) => r.typed_only !== true);
        if (imageBacked.length === 0) {
          if (!contestProven) {
            // An unproven image cannot displace another human's standing assertion.
            await quarantineAsDuplicate(3);
            return;
          }
          await supersedeTypedOnlyDocumentClaims(
            client, typedOnly.map((r: { id: number }) => r.id), drawId,
          );
        } else {
          const centsOf = (a: string | null) => a != null ? Math.round(parseFloat(a) * 100) : null;
          const sameAmount = imageBacked.filter((r: { amount: string | null }) => centsOf(r.amount) === txCents);
          if (sameAmount.length === 0) {
            // Every image-backed same-day claim is a DIFFERENT purchase (distinct verified
            // amounts): coexist in the next doc_seq slot. Typed-only same-day assertions,
            // if any, keep their slot untouched (they were not displaced by this proof).
            docSeq = sameDay.reduce(
              (m: number, r: { receipt_doc_seq: number }) => Math.max(m, Number(r.receipt_doc_seq)), 0,
            ) + 1;
          } else if (sameAmount.some((r: { verified: boolean }) => r.verified === true)) {
            // Same number, same day, same amount as a VERIFIED claim: the same paper.
            await quarantineAsDuplicate(3);
            return;
          } else {
            // Equal amount but the competing claim is still unverified (in-flight race):
            // cannot prove which is the dup yet - this one stands aside without penalty.
            await quarantineAsDuplicate(0);
            return;
          }
        }
      }
    }

    if (passed) {
      // Deferred reward: a low-clean-streak account earns 0 here, not -3/-1 (laundering guard).
      const appliedDelta = await deferredOcrRewardDelta(client, userId, riskDelta);
      await client.query(
        `UPDATE ticket SET image_validation_status = 'passed', risk_score_delta = risk_score_delta + $2,
                receipt_doc_seq = COALESCE($3, receipt_doc_seq)
         WHERE id = $1`,
        [ticketId, appliedDelta, docSeq],
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
      // A deferred (zeroed) reward must NOT call updateUserRiskScore: its delta-0 branch
      // counts a "clean entry", which the submission path already counted for this receipt.
      if (appliedDelta !== 0) await updateUserRiskScore(userId, appliedDelta, client);
      await syncUserQuarantineState(userId, drawId, client);

      // Same-business velocity signal. Only anchor tickets ever reach 'passed', so this
      // COUNT is a count of verified RECEIPTS (not inflated by multi-entry siblings), and
      // it includes the row updated above. Scoped to THIS draw: the flag exists to inform
      // the current draw's winner review, and without the scope a regular customer with a
      // couple of receipts on each side of a draw boundary (both inside the 24h window)
      // would trip a farming flag that means nothing for either campaign.
      const vel = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM ticket
         WHERE activated_by_user_id = $1 AND business_id = $2 AND draw_id = $3
           AND image_validation_status = 'passed'
           AND activated_at >= NOW() - INTERVAL '24 hours'`,
        [userId, businessId, drawId],
      );
      if (Number(vel.rows[0]?.cnt ?? 0) >= SAME_BUSINESS_VERIFIED_24H_FLAG_AT) {
        await client.query(
          `UPDATE ticket SET risk_flags = array_append(COALESCE(risk_flags, '{}'), $2)
           WHERE id = $1 AND NOT (COALESCE(risk_flags, '{}') @> ARRAY[$2::text])`,
          [ticketId, SAME_BUSINESS_VELOCITY_FLAG],
        );
        await client.query(
          `UPDATE "user" SET risk_flags = array_append(COALESCE(risk_flags, '{}'), $2)
           WHERE id = $1 AND NOT (COALESCE(risk_flags, '{}') @> ARRAY[$2::text])`,
          [userId, SAME_BUSINESS_VELOCITY_FLAG],
        );
      }
    } else {
      // failPenalty is 0 for honest-mistake failures (e.g. a with-tip claim): the entry is
      // still quarantined so the inflated amount never enters the draw, but the user is not
      // treated as a fraud signal.
      await client.query(
        `UPDATE ticket SET image_validation_status = 'failed', risk_score_delta = risk_score_delta + $2 WHERE id = $1`,
        [ticketId, failPenalty],
      );
      await client.query(
        `UPDATE ticket
         SET is_quarantined = TRUE, quarantine_reason = 'ocr_validation_failed', quarantined_at = NOW()
         WHERE (id = $1 OR anchor_ticket_id = $1)
           AND (quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review') OR quarantine_reason IS NULL)`,
        [ticketId],
      );
      if (failPenalty !== 0) await updateUserRiskScore(userId, failPenalty, client);
      await syncUserQuarantineState(userId, drawId, client);
    }

    await client.query('COMMIT');
    // Funnel: the spec's review-outcome beats (internal-only; user never notified).
    recordFunnelEvent({
      eventType: passed ? 'submission_ocr_cleared' : 'submission_ocr_rejected',
      userId, meta: { ticket_id: ticketId },
    });
  } catch (err) {
    await safeRollback(client);
    throw err; // let the caller's catch record an ocr_error for retry
  } finally {
    client.release();
  }
}

// ─── Provider Factory ─────────────────────────────────────────────────────────
// OCR_PROVIDER selects the engine per environment:
//   'gemini'         → GeminiVisionProvider (Gemini Flash-Lite reads the photo directly and
//                      returns a verbatim transcript; the same deterministic matchers decide).
//   anything else    → GoogleVisionProvider (the default - flipping the env var is the whole
//                      rollout, and unsetting it is the whole rollback).
// Both enforce the same SSRF guard and 10MB image cap; the old Tesseract provider (no size
// cap, unbounded CPU) was removed as a DoS vector.

function getProvider(): OcrProvider {
  return process.env.OCR_PROVIDER === 'gemini' ? new GeminiVisionProvider() : new GoogleVisionProvider();
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
      -- Format as text: pg returns a DATE column as a JS Date, but the matcher (and the live
      -- submit path) expect a 'YYYY-MM-DD' string. to_char also avoids any TZ-shift a JS Date
      -- conversion could introduce. Without this the boot/6h recovery crashed in matchDate.
      to_char(t.transaction_date, 'YYYY-MM-DD') AS transaction_date,
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
      let result = await provider.validate(imageUrl, expected);

      // Hard requirements — instant fail if either is missing.
      // Soft checks — three states:
      //   true  = found on receipt and matches user's claim ✓
      //   false = found on receipt but doesn't match → fraud signal → fail
      //   null  = not visible in image → can't verify → let it slide
      const verdictOf = (r: OcrValidationResult) => {
        const hardFail   = !r.isReceipt || !r.identifierFound;
        const softChecks = [r.amountMatches, r.dateMatches, r.businessNameFound];
        const anyWrong   = softChecks.some(v => v === false);
        const anyMissing = softChecks.some(v => v === null);
        // If any check found a value but it contradicts the user's claim → fail
        // If all found checks match, but some couldn't be verified → partial pass (-1)
        // If everything verified and matches → full pass (-3)
        const fullPass    = !hardFail && !anyWrong && !anyMissing;
        const partialPass = !hardFail && !anyWrong && anyMissing;
        return { passed: fullPass || partialPass, riskDelta: fullPass ? -3 : partialPass ? -1 : 2 };
      };
      let { passed, riskDelta } = verdictOf(result);
      // Risk penalty applied on a FAILED validation. 2 = the standard fraud-signal penalty;
      // zeroed for honest-mistake failures (see the tip-flag case below).
      let failPenalty = 2;

      // LLM judgment layer (Gemini on the SAME Vision text — no extra OCR call): consulted only
      // for regex passes, tighten-only and grounded, so it can catch a claimed amount that is
      // printed but isn't the total, a with-tip claim (Rules count pre-tip only), incoherent
      // arithmetic (fabricated document), a non-receipt with receipt keywords, or a receipt
      // from a different merchant — but can never rescue a fail nor invent evidence. Any LLM
      // failure returns null and the regex verdict stands (see receiptValidationLlm.ts).
      if (passed && result.rawText) {
        // Cheap idempotency pre-check: a concurrent run (boot recovery racing a live job, or
        // two instances) may have resolved this ticket while Vision ran. resolveReceipt*'s
        // transactional guard already makes the double-fire a no-op; this just skips a wasted
        // (and nondeterministic) LLM call whose judgment would be discarded anyway.
        const preCheck = await pool.query(
          `SELECT image_validation_status FROM ticket WHERE id = $1`,
          [ticketId],
        );
        const preStatus: string | undefined = preCheck.rows[0]?.image_validation_status;
        if (preStatus !== 'pending' && preStatus !== 'ocr_error') return;

        const judgment = await judgeReceiptLlm(result.rawText, expected);
        const tightening = applyLlmTightening(result, expected, judgment);
        if (tightening.reasons.length > 0) {
          console.log(`[OCR] LLM tightened ticket ${ticketId}: ${tightening.reasons.join(', ')}`);
          result = tightening.result;
          ({ passed, riskDelta } = verdictOf(result));
          // A tip-inclusive claim is an HONEST mistake (they typed the bottom line of their
          // own receipt), not fraud: quarantine the entry so the inflated amount never enters
          // the draw, but apply NO fraud penalty. Every other flag keeps the standard +2.
          if (!passed && tightening.reasons.every(r => r === 'llm_amount_includes_tip')) {
            failPenalty = 0;
          }
        }
        if (judgment && judgment.tip !== null) {
          console.log(`[OCR] Tip line on ticket ${ticketId}: claimed ${expected.amount}, pre-tip ${judgment.preTipTotal ?? 'unknown'}, tip ${judgment.tip}`);
        }
        if (judgment?.mathConsistent === false) {
          // Logged even when the grounding check discarded the flag, so admins can audit.
          // mathProblem is model free-text that may echo receipt content (PII) - dev only,
          // same policy as the raw Vision text log.
          const detail = process.env.NODE_ENV !== 'production' ? (judgment.mathProblem ?? 'unspecified') : '[detail redacted]';
          console.log(`[OCR] Math inconsistency reported on ticket ${ticketId}: ${detail}`);
        }
      }

      // Anti-squatting: a 'contest_pending' ticket is a user proving (with this image) that a
      // receipt a SQUATTER typed with no image is really theirs. Overriding another human's
      // entry demands a STRICTER bar than a normal OCR pass: the business name AND the amount
      // must be positively confirmed on the image (not merely "not contradicted"). Without this,
      // any photo that merely CONTAINS the number string could supersede an honest typed-only
      // entry (identifierFound is a naive substring; the regex matcher never sets
      // businessNameFound=false — only the grounded LLM layer can). Requiring both confirmed
      // means the contester must hold a legible receipt
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
          businessId, meta.rows[0].receipt_identifier, failPenalty,
        );
        return;
      }

      // Everything else (fingerprint, duplicate-document detection, supersede, pass/fail) runs in
      // one transaction under the per-receipt advisory lock so concurrency can't race a second
      // standing entry and a crash can't leave a half-applied verdict.
      await resolveReceiptValidation(
        pool, ticketId, userId, drawId, businessId, identifier, result, passed, contestProven, riskDelta, failPenalty,
      );
    } catch (err) {
      // Provider error (network, OCR failure, etc.) or a resolution that rolled back —
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
 