// Receipt-scan autofill: derives the submit-form fields (identifier, pre-tip amount, date)
// from the shared receipt read (receiptRead.ts) so the user does not have to type them.
// The read is CACHED: the model call this endpoint pays is the same one submit-time
// validation reuses, so a scanned photo costs one Gemini read total, not two.
//
// CONVENIENCE LAYER ONLY - nothing here is trusted: the submitted values go through the
// exact same validation, dedup ladder, and async OCR verification as hand-typed ones, and
// the user is told to check the filled values against the paper before submitting.
//
// Soft-failure contract: this NEVER throws. Any problem (no key, download failure, model
// error, unparseable output) returns null and the form falls back to typing, photo kept.

import { readReceiptImage } from './receiptRead.js';

export interface ReceiptScanFields {
  /** The most likely receipt/check/order number, as printed. */
  identifier: string | null;
  /** The pre-tip total in dollars (Rules count pre-tip amounts only). */
  amount: number | null;
  /** The transaction date as YYYY-MM-DD, when printed and unambiguous. */
  date: string | null;
}

// Labels that name THE transaction number, in preference order. A receipt often prints
// several numbers (order #, auth code, terminal id); prefer the one whose label says what
// the form asks for.
const LABEL_PREFERENCE = [/check/i, /receipt/i, /order/i, /invoice/i, /trans/i, /ticket/i, /ref/i];

/** Exported for tests: pick the best identifier from the model's label-value pairs. */
export function pickIdentifierCandidate(
  candidates: Array<{ label?: unknown; value?: unknown }>,
): string | null {
  const usable = candidates
    .map((c) => ({
      label: typeof c.label === 'string' ? c.label : '',
      value: typeof c.value === 'string' ? c.value.trim() : '',
    }))
    .filter((c) => {
      const alnum = c.value.replace(/[^A-Za-z0-9]/g, '');
      return alnum.length >= 1 && c.value.length <= 100;
    });
  if (usable.length === 0) return null;
  for (const re of LABEL_PREFERENCE) {
    const hit = usable.find((c) => re.test(c.label));
    if (hit) return hit.value;
  }
  return usable[0].value;
}

export async function extractReceiptFields(imageUrl: string): Promise<ReceiptScanFields | null> {
  try {
    // Autofill is interactive: fail soft after 15s rather than leaving the form waiting.
    // (Validation later re-reads with its own timeout; on a cache hit it costs nothing.)
    const read = await readReceiptImage(imageUrl, { timeoutMs: 15_000 });
    if (!read.isReceiptFlag) return null;

    const identifier = pickIdentifierCandidate(read.candidates);
    // Same sanity bounds as the submit endpoint, and cents-rounded like the stored amount.
    const amount = read.preTipTotal !== null && read.preTipTotal > 0 && read.preTipTotal <= 1_000_000
      ? Math.round(read.preTipTotal * 100) / 100 : null;
    const date = read.receiptDate;

    if (!identifier && amount === null && date === null) return null;
    return { identifier, amount, date };
  } catch (err) {
    console.error('[ReceiptScan] extraction failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
