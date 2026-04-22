import { getPool } from '../../shared/db/db.js';
import { updateUserRiskScore, syncUserQuarantineState } from '../risk/risk.service.js';
import { TesseractProvider } from './providers/tesseract.provider.js';
import type { OcrProvider, OcrExpected } from './ocr.types.js';

// ─── Provider Factory ─────────────────────────────────────────────────────────
// To swap providers: set OCR_PROVIDER=claude (or google, etc.) in .env
// Each provider must implement the OcrProvider interface from ocr.types.ts

function getProvider(): OcrProvider {
  const provider = process.env.OCR_PROVIDER ?? 'tesseract';
  switch (provider) {
    case 'tesseract':
      return new TesseractProvider();
    // case 'claude':
    //   return new ClaudeProvider();
    // case 'google':
    //   return new GoogleVisionProvider();
    default:
      console.warn(`Unknown OCR_PROVIDER "${provider}", falling back to tesseract`);
      return new TesseractProvider();
  }
}

// ─── Async Validator ──────────────────────────────────────────────────────────
// Called after ticket commit — runs in background, never blocks the response.
// On failure: quarantines the ticket and adds a risk penalty.
// On provider error: quarantines for manual review (cannot be exploited by crashing the OCR provider).

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
        result.businessNameFound !== false;

      if (passed) {
        await pool.query(
          `UPDATE ticket SET image_validation_status = 'passed' WHERE id = $1`,
          [ticketId],
        );
        // Unquarantine medium-risk tickets that were held pending OCR
        await pool.query(
          `UPDATE ticket
           SET is_quarantined = FALSE, quarantine_reason = NULL, quarantined_at = NULL
           WHERE id = $1 AND quarantine_reason = 'ocr_pending'`,
          [ticketId],
        );
      } else {
        await pool.query(
          `UPDATE ticket SET image_validation_status = 'failed' WHERE id = $1`,
          [ticketId],
        );
        await pool.query(
          `UPDATE ticket
           SET is_quarantined = TRUE, quarantine_reason = 'ocr_validation_failed', quarantined_at = NOW()
           WHERE id = $1 AND is_quarantined = FALSE`,
          [ticketId],
        );
        // Penalty for submitting an image that doesn't match
        await updateUserRiskScore(userId, 2);
        await syncUserQuarantineState(userId, drawId);
      }
    } catch (err) {
      // Provider error (network, tesseract crash, etc.) — quarantine pending manual review
      // rather than leaving the ticket eligible, which could be exploited by crashing the OCR provider
      console.error(`[OCR] Validation error for ticket ${ticketId}:`, err);
      await pool.query(
        `UPDATE ticket SET image_validation_status = 'ocr_error' WHERE id = $1`,
        [ticketId],
      );
      await pool.query(
        `UPDATE ticket
         SET is_quarantined = TRUE, quarantine_reason = 'ocr_error_pending_review', quarantined_at = NOW()
         WHERE id = $1 AND is_quarantined = FALSE`,
        [ticketId],
      );
    }
  });
};
