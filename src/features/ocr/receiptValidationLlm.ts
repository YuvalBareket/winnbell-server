// LLM judgment layer for medium-risk receipt validation: the regex matchers in
// ocr-matchers.ts verify that the claimed values APPEAR in the OCR text, but cannot judge
// what a number IS. A claimed amount that matches an item price, a phone-number fragment,
// or a tip line passes matchAmount as long as the digits are printed somewhere. This module
// asks Gemini Flash-Lite to look at the same OCR text like a human would and answer: is this
// a purchase receipt, is the claimed amount the payable total, and whose receipt is it.
//
// Safety model - TIGHTEN ONLY, GROUNDED, FAIL OPEN:
//   - The judgment is consulted only for validations the regex layer already passed; it can
//     flip a check to a fail but can never rescue one. A hallucinating model can therefore
//     never approve a receipt the deterministic layer rejected.
//   - Every assertion must be grounded in the OCR text before it is allowed to flip a field
//     (a contradicting total must itself be printed; a foreign merchant name must itself be
//     printed). At worst the model picks the wrong printed candidate - it cannot invent one.
//   - No API key / timeout / bad JSON -> null -> the regex verdict stands unchanged, so a
//     Gemini outage degrades to exactly today's behavior. (A Vision outage still goes
//     through the existing ocr_error retry path - this module never throws.)
//
// Provider: Gemini Flash-Lite - deliberate vendor consolidation onto the same Google
// account that already runs the Vision OCR call. MUST run on PAID billing (free-tier terms
// allow training on inputs; receipt text carries customer PII). The API-enforced
// responseSchema fixes the JSON shape.

import type { OcrExpected, OcrValidationResult } from './ocr.types.js';

// Pinned (not the -latest alias) so behavior/cost can't shift silently. If Google retires
// it for this account the call 404s -> fail-open to the regex verdict + loud '[OCR] LLM
// judgment HTTP 404' logs, and this constant is the one-line fix (2.5-flash-lite died
// exactly that way on 2026-08-10: "no longer available to new users").
const MODEL = 'gemini-3.5-flash-lite';

// OpenAPI-subset schema enforced server-side by Gemini - the model cannot return a
// differently-shaped answer. parseJudgment still clamps the VALUES (enforcement covers
// shape, not sanity of contents).
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isReceipt: { type: 'BOOLEAN', nullable: true },
    actualPayableTotal: { type: 'NUMBER', nullable: true },
    merchantName: { type: 'STRING', nullable: true },
    preTipTotal: { type: 'NUMBER', nullable: true },
    subtotal: { type: 'NUMBER', nullable: true },
    tax: { type: 'NUMBER', nullable: true },
    tip: { type: 'NUMBER', nullable: true },
    lineItemTotals: { type: 'ARRAY', items: { type: 'NUMBER' }, nullable: true },
    mathConsistent: { type: 'BOOLEAN', nullable: true },
    mathProblem: { type: 'STRING', nullable: true },
  },
  required: [
    'isReceipt', 'actualPayableTotal', 'merchantName', 'preTipTotal',
    'subtotal', 'tax', 'tip', 'lineItemTotals', 'mathConsistent', 'mathProblem',
  ],
};

// The model is a pure EXTRACTOR: every field below is claim-independent (what is printed on
// the receipt), and all comparison against the user's claim happens server-side. This is
// deliberate - claim-aware questions ("is the claimed amount the total?") proved unstable on
// a small model (live 2026-08-10: the same receipt got different "totals" depending on the
// claim). Extraction stayed stable across claims.
export interface LlmReceiptJudgment {
  /** false = clearly not a purchase receipt (bank statement, email screenshot, ...) */
  isReceipt: boolean | null;
  /** The final bottom-line total INCLUDING any tip, as printed. */
  actualPayableTotal: number | null;
  /** The merchant name as printed on the receipt, per the model. Used for grounding. */
  merchantName: string | null;
  /** Total before tip when a tip line exists (equals the total on tipless receipts). */
  preTipTotal: number | null;
  /** The pre-tax subtotal as printed. Used for the math-coherence check. */
  subtotal: number | null;
  /** The tax amount as printed. */
  tax: number | null;
  /** The tip/gratuity amount as printed (or handwritten). */
  tip: number | null;
  /** Each charge line's price as printed (discounts negative). For the items-sum check. */
  lineItemTotals: number[] | null;
  /** false = the printed numbers clearly contradict each other (fabricated-receipt signal). */
  mathConsistent: boolean | null;
  /** One short sentence describing the contradiction, for admin logs. */
  mathProblem: string | null;
}

const PROMPT_HEADER = (expected: OcrExpected) => `You extract structured facts from raw OCR text of a purchase receipt (allegedly from "${expected.businessName ?? 'unknown business'}") so a fraud-check system can verify a sweepstake entry.

Answer every field of the JSON schema; use null for anything you cannot tell. Report ONLY what is printed or handwritten on the receipt.

Rules:
- "isReceipt": false ONLY if the text is clearly NOT from a purchase receipt or invoice (e.g. a bank statement, chat or email screenshot, product page). When unsure use true.
- "actualPayableTotal": the final bottom-line total of the transaction INCLUDING any tip, as a plain number, else null.
- "merchantName": the business name printed on the receipt, copied exactly as printed, else null.
- "preTipTotal": the total before any tip (the printed total on tipless receipts), as a plain number, else null.
- "subtotal": the pre-tax subtotal as printed, else null.
- "tax": the tax amount as printed, else null.
- "tip": the tip/gratuity amount as printed or handwritten, else null.
- "lineItemTotals": the price of each charge line as printed, in order, discounts as negative numbers; null when the item lines are not legible.
- "mathConsistent": do the printed numbers cohere (line items sum to the subtotal; subtotal + tax = total; total + tip = final total)? Use false ONLY when printed numbers clearly contradict each other after accounting for every printed discount, fee, and rounding line. When unsure use true.
- "mathProblem": when mathConsistent is false, one short sentence naming the contradiction, else null.

OCR text:
`;

/** Cent values printed in the text (same money regex family as matchAmount).
 *  `decimals` = values printed WITH cents ("23.47") - unambiguously money.
 *  `all` adds bare integers ("TOTAL 45") - money-ish, but receipts also print dates, times
 *  and phone fragments as bare integers, so the lookarounds exclude /-#: separators and the
 *  `all` set is treated as the weaker grounding tier. */
const printedMoney = (text: string): { decimals: Set<number>; all: Set<number> } => {
  const decimals = new Set<number>();
  for (const m of text.matchAll(/(\d[\d.,]*)[.,](\d{2})(?!\d)/g)) {
    const c = Math.round(parseFloat(`${m[1].replace(/[.,]/g, '')}.${m[2]}`) * 100);
    if (Number.isFinite(c)) decimals.add(c);
  }
  const all = new Set(decimals);
  // Whole-dollar totals can print without decimals ("TOTAL 45"); exclude integers glued to
  // date/time/phone/number punctuation (08/10/2026, 12:14, 555-0123, #10432).
  for (const m of text.matchAll(/(?<![\d.,/#:\-])(\d{1,6})(?![\d.,/#:\-])/g)) {
    all.add(parseInt(m[1], 10) * 100);
  }
  return { decimals, all };
};

const toNumber = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Line items may legitimately be negative (discount lines); still bounded for sanity.
const toLineAmount = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n !== 0 && Math.abs(n) < 100_000 ? n : null;
};

/** Parse + clamp a raw model answer into a well-typed judgment. Exported for tests. */
export const parseJudgment = (parsed: Record<string, unknown>): LlmReceiptJudgment => ({
  isReceipt: typeof parsed.isReceipt === 'boolean' ? parsed.isReceipt : null,
  actualPayableTotal: toNumber(parsed.actualPayableTotal),
  merchantName: typeof parsed.merchantName === 'string' && parsed.merchantName.trim().length >= 2
    ? parsed.merchantName.trim() : null,
  preTipTotal: toNumber(parsed.preTipTotal),
  subtotal: toNumber(parsed.subtotal),
  tax: toNumber(parsed.tax),
  tip: toNumber(parsed.tip),
  lineItemTotals: Array.isArray(parsed.lineItemTotals) && parsed.lineItemTotals.length > 0
    ? (() => {
        const items = parsed.lineItemTotals.map(toLineAmount);
        return items.every((v): v is number => v !== null) ? items : null;
      })()
    : null,
  mathConsistent: typeof parsed.mathConsistent === 'boolean' ? parsed.mathConsistent : null,
  mathProblem: typeof parsed.mathProblem === 'string' && parsed.mathProblem.trim().length > 0
    ? parsed.mathProblem.trim().slice(0, 200) : null,
});

/**
 * Apply the judgment to a regex-passed validation result - tighten only, grounded.
 * Returns the (possibly) tightened result plus the reasons applied, for logging.
 * Pure function; exported for tests.
 */
export const applyLlmTightening = (
  result: OcrValidationResult,
  expected: OcrExpected,
  judgment: LlmReceiptJudgment | null,
): { result: OcrValidationResult; reasons: string[] } => {
  if (!judgment) return { result, reasons: [] };
  const rawText = result.rawText ?? '';
  const reasons: string[] = [];
  const tightened: OcrValidationResult = { ...result };

  // Not a receipt: the regex keyword check passed, but keywords also appear in bank
  // statements and order-confirmation screenshots. No grounding is possible for a negative;
  // the prompt demands high confidence and the flip only ever applies to regex-passes.
  if (judgment.isReceipt === false && tightened.isReceipt) {
    tightened.isReceipt = false;
    reasons.push('llm_not_a_receipt');
  }

  // ── Amount disposition (all comparison is server-side and deterministic) ──────────
  // The model only reports which totals are PRINTED; we compare the claim against them.
  // A dollar of rounding grace applies throughout (people type "$23" off a $23.47 slip):
  //   claim ~= pre-tip total             -> ideal, pass
  //   claim ~= pre-tip + tip (grounded)  -> with-tip claim; Rules count pre-tip only -> flag
  //   claim  > every printed total + $1  -> inflation (order number / approval code typed
  //                                         as the amount) -> flag
  //   claim  < the totals                -> ALLOWED. A smaller printed amount can be a split
  //                                         check or partial payment; under-claiming earns
  //                                         fewer entries and is never an inflation fraud.
  if (tightened.amountMatches === true) {
    const DOLLAR_TOL = 100; // cents
    const printed = printedMoney(rawText);
    const claimedCents = Math.round(expected.amount * 100);
    const grounded = (v: number | null): number | null => {
      if (v === null) return null;
      const c = Math.round(v * 100);
      return c > 0 && printed.all.has(c) ? c : null;
    };
    const near = (a: number, b: number) => Math.abs(a - b) < DOLLAR_TOL;
    const preTip = grounded(judgment.preTipTotal);
    const final = grounded(judgment.actualPayableTotal);
    const tip = grounded(judgment.tip);

    const totals: number[] = [];
    if (preTip !== null) totals.push(preTip);
    if (final !== null) totals.push(final);
    // The with-tip sum counts as a known total even when no final line is printed (a
    // handwritten tip with a blank final-total line is common).
    if (preTip !== null && tip !== null) totals.push(preTip + tip);

    if (preTip !== null && near(claimedCents, preTip)) {
      // Pre-tip claim (possibly rounded) - exactly what the form asks for; nothing to flag.
    } else if (preTip !== null && tip !== null && near(claimedCents, preTip + tip)) {
      tightened.amountMatches = false;
      reasons.push('llm_amount_includes_tip');
    } else if (
      totals.length > 0 &&
      claimedCents > Math.max(...totals) + DOLLAR_TOL &&
      // The claim itself must NOT be printed as decimal-formatted money. A cents-formatted
      // claim ("100.00" printed) that exceeds the extracted totals means the MODEL likely
      // under-extracted (grabbed the subtotal as the total) - flagging there would fail
      // honest users. The inflation fraud this targets (order number / approval code typed
      // as the amount) is only ever printed as a bare integer, never as "10432.00".
      !printed.decimals.has(claimedCents)
    ) {
      tightened.amountMatches = false;
      reasons.push('llm_amount_not_total');
    }
  }

  // Receipt names a different merchant. Only when the regex could not confirm the business
  // (businessNameFound === null), and grounded twice: the merchant the model read must be
  // printed in the text, and it must share NO significant word with the expected business
  // (any overlap -> same business, e.g. "STARBUCKS #123" vs "Starbucks Coffee" -> no flag).
  if (
    judgment.merchantName !== null &&
    tightened.businessNameFound === null &&
    expected.businessName
  ) {
    const merchantUpper = judgment.merchantName.toUpperCase();
    const grounded = rawText.toUpperCase().includes(merchantUpper);
    const expectedWords = expected.businessName.toUpperCase()
      .replace(/[^A-Z0-9\sא-ת]/g, '')
      .split(/\s+/)
      .filter((w) => w.length >= 4 || /[א-ת]{2,}/.test(w));
    const overlap = expectedWords.some((w) => merchantUpper.includes(w));
    if (grounded && expectedWords.length > 0 && !overlap) {
      tightened.businessNameFound = false;
      reasons.push('llm_wrong_business');
    }
  }

  // Fabricated-document detector: a real register COMPUTES its numbers, a generated or
  // hand-edited fake often just draws plausible ones. DUAL condition - the model must
  // assert inconsistency AND the server must reproduce the contradiction from the model's
  // own numbers, each grounded as printed. Never trust either side alone: the model can
  // mis-pair numbers off a multi-section receipt, and the server can't see discount/fee
  // lines the model accounted for.
  if (judgment.mathConsistent === false && tightened.isReceipt) {
    const printed = printedMoney(rawText);
    // Totals/tax/tip are always positive; only LINE ITEMS may be negative (discount lines),
    // and those ground against the printed absolute value ("-5.00" prints the digits 5.00).
    const groundedPos = (v: number | null): number | null => {
      if (v === null) return null;
      const c = Math.round(v * 100);
      return c > 0 && printed.all.has(c) ? c : null;
    };
    const groundedLine = (v: number | null): number | null => {
      if (v === null) return null;
      const c = Math.round(v * 100);
      return printed.all.has(Math.abs(c)) ? c : null;
    };
    const sub = groundedPos(judgment.subtotal);
    const tax = groundedPos(judgment.tax);
    const tip = groundedPos(judgment.tip);
    const preTip = groundedPos(judgment.preTipTotal);
    const final = groundedPos(judgment.actualPayableTotal);
    const items = (judgment.lineItemTotals ?? []).map(groundedLine);
    const itemsSum = items.length > 0 && items.every((c): c is number => c !== null)
      ? items.reduce((a, b) => a + b, 0)
      : null;

    // A: subtotal + tax must reach the pre-tip total (use the final total only when no tip
    //    exists - with a tip the final legitimately exceeds subtotal + tax).
    const totalForA = preTip ?? (tip === null ? final : null);
    const badA = sub !== null && tax !== null && totalForA !== null && Math.abs(sub + tax - totalForA) > 2;
    // C: the item lines must sum to the subtotal (tolerance for a rounding line).
    // (A former check "preTip + tip = final" was removed after a LIVE false positive: the
    // model's final-total field proved claim-sensitive - it echoed the claimed amount back
    // as the "final", turning an honest pre-tip claim into a fake contradiction. A and C
    // use only claim-independent printed fields, which stayed stable across claims.)
    const badC = itemsSum !== null && sub !== null && Math.abs(itemsSum - sub) > 5;

    if (badA || badC) {
      tightened.isReceipt = false;
      reasons.push('llm_math_inconsistent');
    }
  }

  return { result: tightened, reasons };
};

/** Ask Gemini Flash-Lite to judge the receipt. Returns null whenever the LLM path is
 *  unavailable or failed in any way - callers keep the regex verdict. Never throws. */
export const judgeReceiptLlm = async (
  rawText: string,
  expected: OcrExpected,
): Promise<LlmReceiptJudgment | null> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !rawText.trim()) return null;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          'x-goog-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          // Generous cap: real receipts OCR to a few hundred chars, so 20K covers anything
          // genuine many times over. The cap exists only to bound cost; keeping it far above
          // realistic sizes closes the crafted-header attack (stuffing a fake total early and
          // hiding the real one past the slice) for any document that still resembles a
          // receipt. (~5K tokens ≈ a tenth of a cent worst case.)
          contents: [{ parts: [{ text: PROMPT_HEADER(expected) + rawText.slice(0, 20_000) }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            maxOutputTokens: 256,
            // No thinkingConfig: Gemini 3.x removed thinkingBudget (sending it is a 400).
            // Lite models default to minimal thinking, which is right for this task.
          },
        }),
      },
    );
    if (!response.ok) {
      console.error(`[OCR] LLM judgment HTTP ${response.status}`);
      return null;
    }
    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    // responseSchema guarantees JSON, but stay defensive: take the first {...} block.
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (!jsonMatch) return null;
    return parseJudgment(JSON.parse(jsonMatch[0]) as Record<string, unknown>);
  } catch (err) {
    console.error('[OCR] LLM judgment failed:', err instanceof Error ? err.message : err);
    return null;
  }
};
