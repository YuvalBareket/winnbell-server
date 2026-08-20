// Receipt-identity helpers shared by the submission controller and every OCR provider,
// so normalization stays identical on both sides of every comparison.

/**
 * Canonical form of a receipt identifier: uppercase letters + digits only.
 * Kills formatting variants of the SAME number so dedup can't be bypassed by punctuation:
 *   "#1366-3859" -> "13663859", "1366 3859" -> "13663859", "rcp/1366.3859" -> "RCP13663859".
 */
export function normalizeReceiptIdentifier(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Fully alnum-only projection of a block of OCR text (uppercase, every separator removed),
 * so a normalized identifier can be found even when the receipt printed it with spaces or
 * dashes. Used ONLY for the identifier substring check, not the amount/date/name matchers.
 */
export function alnumOnly(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Below this normalized length, substring containment stops meaning anything: the flattened
// alnum projection of any receipt ("$1.20" -> "120", "12:45" -> "1245") contains almost every
// 1-3 char string, so a short id (Toast-style "Check #12") must match a whole printed run.
const CONTAINMENT_MIN = 4;

/**
 * Is this identifier actually printed in the OCR text? The one matcher BOTH providers use, so
 * a verdict never depends on which OCR engine read the image.
 *  - Normalized length >= 4: substring containment on the alnum-only projection (finds
 *    "13663859" printed as "1366-3859" / "1366 3859").
 *  - Shorter (daily-reset POS check numbers): the id must be a whole alnum run of the text
 *    ("Check #12" -> runs CHECK, 12), or a run of letters glued to it ("NO12"). A digit-glued
 *    run ("1512", "120") never counts - that is a different number that merely contains it.
 */
export function identifierFoundInText(identifier: string, rawText: string): boolean {
  const id = normalizeReceiptIdentifier(identifier);
  if (id.length === 0) return false;
  if (id.length >= CONTAINMENT_MIN) return alnumOnly(rawText).includes(id);
  for (const run of rawText.split(/[^A-Za-z0-9]+/)) {
    const tok = run.toUpperCase();
    if (tok === id) return true;
    if (tok.length > id.length && tok.endsWith(id) && /^[A-Z]+$/.test(tok.slice(0, tok.length - id.length))) {
      return true;
    }
  }
  return false;
}

// Token length window: >= 6 excludes prices ("45000"), card last-4, and most date fragments;
// <= 40 excludes long barcodes / base64-ish blobs that never serve as a receipt number.
const TOKEN_MIN = 6;
const TOKEN_MAX = 40;
// Bound how many tokens we fingerprint per document (storage + query cost).
const MAX_TOKENS = 40;

/**
 * Extract the set of "identifier-like" tokens printed on a receipt image - the document's
 * fingerprint. A token is an alphanumeric run (normalized) that is long enough to be an
 * identifier and contains at least one digit (so pure words like RECEIPT/SUBTOTAL are out).
 * The typed receipt number, invoice number, order number, etc. all land here, which is what
 * lets us detect the SAME physical document being reused under a different number.
 *
 * We only ever compare a TYPED identifier against these tokens (never token-set vs token-set),
 * so shared boilerplate that happens to qualify (a store phone, a website with digits) can
 * never cross-flag two honest customers.
 */
/**
 * Complete a typed identifier to the full number it's a fragment of, using the document's own
 * tokens. If the user typed a chunk cut out of a longer number printed on the receipt (e.g.
 * "DWJRMDV0001" out of "KDWJRMDV0001"), return that longer number; otherwise return it unchanged.
 * We never need to know WHICH number is "the receipt id" - just whether what was typed is a
 * piece of a bigger continuous number on the image.
 */
export function canonicalizeReceiptIdentifier(typedId: string, tokens: string[]): string {
  // If what was typed is itself a full token on the image, it is already complete - never rewrite it.
  if (tokens.includes(typedId)) return typedId;
  // Otherwise complete the fragment to the SHORTEST token that fully contains it: the tightest
  // superset is the number the fragment was cut from. A longer token that merely also contains
  // the fragment would over-complete and could miss a real duplicate (Check B would look for a
  // number that no prior fingerprint holds).
  let best = typedId;
  for (const t of tokens) {
    if (t.length > typedId.length && t.includes(typedId) && (best === typedId || t.length < best.length)) {
      best = t;
    }
  }
  return best;
}

export function extractDocumentTokens(rawText: string): string[] {
  const seen = new Set<string>();
  // Split on anything that is NOT a letter/digit/dash/slash so a dashed or slashed identifier
  // ("1366-3859", "KDWJRMDV-0001") stays one run, then normalize each run to alnum-only.
  for (const run of rawText.split(/[^A-Za-z0-9/-]+/)) {
    const tok = normalizeReceiptIdentifier(run);
    if (tok.length < TOKEN_MIN || tok.length > TOKEN_MAX) continue;
    if (!/[0-9]/.test(tok)) continue; // must contain a digit to be an identifier
    seen.add(tok);
    if (seen.size >= MAX_TOKENS) break;
  }
  return [...seen];
}
