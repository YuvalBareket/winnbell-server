import { getPool } from '../../shared/db/db.js';
import { updateUserRiskScore, syncUserQuarantineState } from '../risk/risk.service.js';
import { TesseractProvider } from './providers/tesseract.provider.js';
import { GoogleVisionProvider } from './providers/google-vision.provider.js';
import type { OcrProvider, OcrExpected } from './ocr.types.js';

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

  // Re-queue tickets where the OCR job itself was never completed (server restart mid-flight)
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
    WHERE t.image_validation_status = 'pending'
      AND t.activated_at < NOW() - INTERVAL '2 minutes'
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

      // businessNameFound === false means the check ran and failed (null = not checked = pass-through)
      const passed =
        result.identifierFound &&
        result.amountMatches &&
        result.isReceipt &&
        result.dateMatches !== false &&
        result.businessNameFound !== false;

      if (passed) {
        // Always record the OCR result on the anchor ticket
        await pool.query(
          `UPDATE ticket SET image_validation_status = 'passed', risk_score_delta = risk_score_delta - 3 WHERE id = $1`,
          [ticketId],
        );
        // Unquarantine anchor + siblings only if they were pending OCR review
        await pool.query(
          `UPDATE ticket
           SET is_quarantined    = FALSE,
               quarantine_reason = NULL,
               quarantined_at    = NULL
           WHERE (id = $1 OR anchor_ticket_id = $1)
             AND quarantine_reason = 'ocr_pending'`,
          [ticketId],
        );
        // Reward the user for a verified image — reduce risk score toward safety
        await updateUserRiskScore(userId, -3);
        await syncUserQuarantineState(userId, drawId);
      } else {
        // Always record the OCR failure on the anchor ticket and add the risk delta
        await pool.query(
          `UPDATE ticket SET image_validation_status = 'failed', risk_score_delta = risk_score_delta + 2 WHERE id = $1`,
          [ticketId],
        );
        // Update quarantine reason for tickets that were pending OCR (not already quarantined for another reason)
        await pool.query(
          `UPDATE ticket
           SET is_quarantined    = TRUE,
               quarantine_reason = 'ocr_validation_failed',
               quarantined_at    = NOW()
           WHERE (id = $1 OR anchor_ticket_id = $1)
             AND quarantine_reason = 'ocr_pending'`,
          [ticketId],
        );
        // Penalty for submitting an image that doesn't match
        await updateUserRiskScore(userId, 2);
        await syncUserQuarantineState(userId, drawId);
      }
    } catch (err) {
      // Provider error (network, tesseract crash, etc.) — quarantine pending manual review
      console.error(`[OCR] Validation error for ticket ${ticketId}:`, err);
      try {
        // Always record the OCR error on the anchor ticket
        await pool.query(
          `UPDATE ticket SET image_validation_status = 'ocr_error' WHERE id = $1`,
          [ticketId],
        );
        await pool.query(
          `UPDATE ticket
           SET is_quarantined    = TRUE,
               quarantine_reason = 'ocr_error_pending_review',
               quarantined_at    = NOW()
           WHERE (id = $1 OR anchor_ticket_id = $1)
             AND quarantine_reason = 'ocr_pending'`,
          [ticketId],
        );
      } catch (dbErr) {
        console.error(`[OCR] Failed to record OCR error for ticket ${ticketId}:`, dbErr);
      }
    }
  });
};
 