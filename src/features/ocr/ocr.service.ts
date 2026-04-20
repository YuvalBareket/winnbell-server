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
// On provider error: marks as 'skipped' so the ticket is not unfairly quarantined.

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

      const passed = result.identifierFound && result.amountMatches && result.isReceipt;
      const status = passed ? 'passed' : 'failed';

      await pool.query(
        `UPDATE ticket SET image_validation_status = $1 WHERE id = $2`,
        [status, ticketId],
      );

      if (!passed) {
        await pool.query(
          `UPDATE ticket
           SET is_quarantined = TRUE, quarantine_reason = 'ocr_validation_failed', quarantined_at = NOW()
           WHERE id = $1 AND is_quarantined = FALSE`,
          [ticketId],
        );
        // Penalty for submitting an image that doesn't match — use pool (no transaction context)
        await updateUserRiskScore(userId, 2);
        await syncUserQuarantineState(userId, drawId);
      }
    } catch (err) {
      // Provider error (network, tesseract crash, etc.) — skip rather than penalise
      console.error(`[OCR] Validation error for ticket ${ticketId}:`, err);
      await pool.query(
        `UPDATE ticket SET image_validation_status = 'skipped' WHERE id = $1`,
        [ticketId],
      );
    }
  });
};
