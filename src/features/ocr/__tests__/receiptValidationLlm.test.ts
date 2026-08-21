// Pins the safety model of the LLM validation-judgment layer:
//   - TIGHTEN ONLY: the judgment can flip a passing check to a fail, never the reverse.
//   - GROUNDED: a flip requires printed evidence (a different printed total; a printed
//     foreign merchant). Ungrounded assertions are ignored no matter what the model says.
//   - FAIL OPEN: null judgment (no key / timeout / bad JSON) leaves the verdict untouched.
import { applyLlmTightening, parseJudgment, judgeReceiptLlm } from '../receiptValidationLlm';
import type { LlmReceiptJudgment } from '../receiptValidationLlm';
import type { OcrExpected, OcrValidationResult } from '../ocr.types';

const baseResult = (overrides: Partial<OcrValidationResult> = {}): OcrValidationResult => ({
  isReceipt: true,
  identifierFound: true,
  amountMatches: true,
  dateMatches: null,
  businessNameFound: null,
  confidence: 'high',
  rawText: 'JOES DINER\nRECEIPT #12345678\nBURGER 22.00\nTAX 1.50\nTOTAL 23.50\nPAID CASH',
  ...overrides,
});

const expected: OcrExpected = { identifier: '12345678', amount: 22.00, businessName: 'Joes Diner' };

const judgment = (overrides: Partial<LlmReceiptJudgment> = {}): LlmReceiptJudgment => ({
  isReceipt: null,
  actualPayableTotal: null,
  merchantName: null,
  preTipTotal: null,
  subtotal: null,
  tax: null,
  tip: null,
  cashTendered: null,
  changeGiven: null,
  lineItemTotals: null,
  mathConsistent: null,
  mathProblem: null,
  ...overrides,
});

describe('applyLlmTightening', () => {
  it('null judgment (LLM unavailable) is a no-op — fail open to the regex verdict', () => {
    const result = baseResult();
    const out = applyLlmTightening(result, expected, null);
    expect(out.result).toEqual(result);
    expect(out.reasons).toEqual([]);
  });

  it('all-null judgment changes nothing', () => {
    const out = applyLlmTightening(baseResult(), expected, judgment());
    expect(out.result).toEqual(baseResult());
    expect(out.reasons).toEqual([]);
  });

  it('flags an INFLATED claim above every printed total (order number typed as the amount)', () => {
    // "10432" is printed as the order number; the real total is 23.50. Claiming $10,432
    // passes the regex (whole-dollar match on the order number) - the extractor's grounded
    // totals expose the inflation.
    const inflated = 'JOES DINER\nORDER: #10432\nBURGER 22.00\nTAX 1.50\nTOTAL 23.50\nPAID CASH';
    const out = applyLlmTightening(
      baseResult({ rawText: inflated }),
      { ...expected, amount: 10432 },
      judgment({ actualPayableTotal: 23.50, preTipTotal: 23.50 }),
    );
    expect(out.result.amountMatches).toBe(false);
    expect(out.reasons).toContain('llm_amount_not_total');
  });

  it('ALLOWS an under-claim (split check / partial payment is legitimate)', () => {
    // Claimed 22.00 while the printed total is 23.50: could be their share of a split bill,
    // and under-claiming can never inflate entries - allowed.
    const out = applyLlmTightening(
      baseResult(),
      expected,
      judgment({ actualPayableTotal: 23.50, preTipTotal: 23.50 }),
    );
    expect(out.result.amountMatches).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('IGNORES an inflation flag when the extracted totals are not printed (ungrounded)', () => {
    const out = applyLlmTightening(
      baseResult(),
      { ...expected, amount: 10432 },
      judgment({ actualPayableTotal: 9.99, preTipTotal: 9.99 }), // 9.99 nowhere in the text
    );
    expect(out.result.amountMatches).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('no flag when the claim equals the printed total', () => {
    const out = applyLlmTightening(
      baseResult(),
      { ...expected, amount: 23.50 },
      judgment({ actualPayableTotal: 23.50, preTipTotal: 23.50 }),
    );
    expect(out.result.amountMatches).toBe(true);
  });

  it('never rescues: extracted totals cannot flip a failed amountMatches back', () => {
    const out = applyLlmTightening(
      baseResult({ amountMatches: false }),
      expected,
      judgment({ actualPayableTotal: 22.00, preTipTotal: 22.00 }),
    );
    expect(out.result.amountMatches).toBe(false);
  });

  it('flags a non-receipt document', () => {
    const out = applyLlmTightening(baseResult(), expected, judgment({ isReceipt: false }));
    expect(out.result.isReceipt).toBe(false);
    expect(out.reasons).toContain('llm_not_a_receipt');
  });

  it('isReceipt=true never rescues a regex isReceipt fail', () => {
    const out = applyLlmTightening(
      baseResult({ isReceipt: false }),
      expected,
      judgment({ isReceipt: true }),
    );
    expect(out.result.isReceipt).toBe(false);
  });

  it('flags a receipt legibly from a DIFFERENT merchant (grounded, zero name overlap)', () => {
    const out = applyLlmTightening(
      baseResult({ rawText: 'MARIA PIZZA PALACE\nRECEIPT #12345678\nTOTAL 22.00' }),
      expected,
      judgment({ merchantName: 'MARIA PIZZA PALACE' }),
    );
    expect(out.result.businessNameFound).toBe(false);
    expect(out.reasons).toContain('llm_wrong_business');
  });

  it('does NOT flag when the merchant shares a significant word with the expected business', () => {
    // "JOES DINER #123" vs expected "Joes Diner" — same business, abbreviated/suffixed.
    const out = applyLlmTightening(
      baseResult(),
      expected,
      judgment({ merchantName: 'JOES DINER #123' }),
    );
    expect(out.result.businessNameFound).toBeNull();
  });

  it('does NOT flag a merchant name that is not printed in the OCR text (ungrounded)', () => {
    const out = applyLlmTightening(
      baseResult(),
      expected,
      judgment({ merchantName: 'TOTALLY INVENTED CORP' }),
    );
    expect(out.result.businessNameFound).toBeNull();
  });

  it('does NOT touch businessNameFound when the regex already confirmed it', () => {
    const out = applyLlmTightening(
      baseResult({ businessNameFound: true, rawText: 'MARIA PIZZA PALACE\nTOTAL 22.00' }),
      expected,
      judgment({ merchantName: 'MARIA PIZZA PALACE' }),
    );
    expect(out.result.businessNameFound).toBe(true);
  });

  // ── Tip inclusion (Official Rules: only the pre-tip amount counts) ──────────────
  const tipReceipt = 'JOES DINER\nRECEIPT #12345678\nSUB TOTAL 62.00\nTAX 8.00\nTOTAL 70.00\nTIP 20.00\nTOTAL 90.00';

  it('flags a claim that is exactly pre-tip total + tip, both printed', () => {
    const out = applyLlmTightening(
      baseResult({ rawText: tipReceipt }),
      { ...expected, amount: 90 },
      judgment({ preTipTotal: 70, tip: 20, actualPayableTotal: 90 }),
    );
    expect(out.result.amountMatches).toBe(false);
    expect(out.reasons).toContain('llm_amount_includes_tip');
  });

  it('does NOT flag the correct pre-tip claim on the same receipt', () => {
    const out = applyLlmTightening(
      baseResult({ rawText: tipReceipt }),
      { ...expected, amount: 70 },
      judgment({ preTipTotal: 70, tip: 20, actualPayableTotal: 90 }),
    );
    expect(out.result.amountMatches).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('tip flag still fires when the final-total line is blank (sum of grounded parts)', () => {
    // Handwritten tip, final line left empty - no printed 90, but 70 and 20 are printed.
    const blankFinal = 'JOES DINER\nRECEIPT #12345678\nTOTAL 70.00\nTIP 20.00\nTOTAL';
    const out = applyLlmTightening(
      baseResult({ rawText: blankFinal }),
      { ...expected, amount: 90 },
      judgment({ preTipTotal: 70, tip: 20, actualPayableTotal: null }),
    );
    expect(out.result.amountMatches).toBe(false);
    expect(out.reasons).toContain('llm_amount_includes_tip');
  });

  it('a ROUNDED pre-tip claim passes ($70 off a $69.50 pre-tip total)', () => {
    const rounded = 'JOES DINER\nRECEIPT #12345678\nSUB TOTAL 62.00\nTAX 7.50\nTOTAL 69.50\nTIP 20.00\nTOTAL 89.50';
    const out = applyLlmTightening(
      baseResult({ rawText: rounded }),
      { ...expected, amount: 70 },
      judgment({ preTipTotal: 69.50, tip: 20, actualPayableTotal: 89.50 }),
    );
    expect(out.result.amountMatches).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('a ROUNDED with-tip claim is still flagged ($90 off a $89.58 final)', () => {
    const rounded = 'JOES DINER\nRECEIPT #12345678\nTOTAL 70.00\nTIP 19.58\nTOTAL 89.58';
    const out = applyLlmTightening(
      baseResult({ rawText: rounded }),
      { ...expected, amount: 90 },
      judgment({ preTipTotal: 70, tip: 19.58, actualPayableTotal: 89.58 }),
    );
    expect(out.result.amountMatches).toBe(false);
    expect(out.reasons).toContain('llm_amount_includes_tip');
  });

  it('AUDIT REGRESSION: model under-extraction (subtotal as total) cannot inflation-flag an honest claim', () => {
    // Reviewer finding: claim $100 off "SUBTOTAL 95.00 TAX 5.00 TOTAL 100.00"; a weak model
    // returns preTipTotal=95 (the subtotal) and misses the real total. The claim exceeds the
    // extracted "total" - but 100.00 IS printed as decimal money, which proves the model
    // under-extracted rather than the user inflating. Must not flag.
    const receipt = 'JOES DINER\nRECEIPT #12345678\nSUBTOTAL 95.00\nTAX 5.00\nTOTAL 100.00\nPAID VISA';
    const out = applyLlmTightening(
      baseResult({ rawText: receipt }),
      { ...expected, amount: 100 },
      judgment({ preTipTotal: 95, actualPayableTotal: null }),
    );
    expect(out.result.amountMatches).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('AUDIT REGRESSION: date/time/phone fragments no longer ground model values', () => {
    // "12:14" must not make a hallucinated $12 total grounded (colon-adjacent integers are
    // excluded from the money projection).
    const receipt = 'JOES DINER 12:14 PM\nRECEIPT #12345678\nTOTAL 23.50';
    const out = applyLlmTightening(
      baseResult({ rawText: receipt }),
      { ...expected, amount: 30 },
      judgment({ preTipTotal: 12, actualPayableTotal: null }), // 12 only appears in "12:14"
    );
    // preTip ungrounded -> totals empty -> no inflation flag possible.
    expect(out.result.amountMatches).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('inflation must exceed the dollar grace to flag', () => {
    const out = applyLlmTightening(
      baseResult({ rawText: 'JOES DINER\nRECEIPT #12345678\nORDER 25\nTOTAL 23.50' }),
      { ...expected, amount: 25 }, // 25.00 vs max total 23.50: over by 1.50 -> flag
      judgment({ actualPayableTotal: 23.50, preTipTotal: 23.50 }),
    );
    expect(out.result.amountMatches).toBe(false);
    expect(out.reasons).toContain('llm_amount_not_total');
  });

  // ── Cash tendered / change (2026-08-20 review issue A) ──────────────────────────
  // "Total 12.00 / Cash 100.00 / Change 88.00": the cash and change lines are printed as
  // decimal money, so the plain decimals-printed escape used to let a $100 claim through.
  const cashReceipt = 'JOES DINER\nRECEIPT #12345678\nBURGER 11.00\nTAX 1.00\nTOTAL 12.00\nCASH 100.00\nCHANGE 88.00';

  it('flags a claim equal to the printed CASH-TENDERED line (decimal-printed inflation)', () => {
    const out = applyLlmTightening(
      baseResult({ rawText: cashReceipt }),
      { ...expected, amount: 100 },
      judgment({ preTipTotal: 12, actualPayableTotal: 12, cashTendered: 100, changeGiven: 88 }),
    );
    expect(out.result.amountMatches).toBe(false);
    expect(out.reasons).toContain('llm_amount_not_total');
  });

  it('flags a claim equal to the printed CHANGE line', () => {
    const out = applyLlmTightening(
      baseResult({ rawText: cashReceipt }),
      { ...expected, amount: 88 },
      judgment({ preTipTotal: 12, actualPayableTotal: 12, cashTendered: 100, changeGiven: 88 }),
    );
    expect(out.result.amountMatches).toBe(false);
    expect(out.reasons).toContain('llm_amount_not_total');
  });

  it('an exact-change cash payment (claim == total == cash) still passes', () => {
    // The claim matches the pre-tip total, so the first branch returns before the
    // inflation check ever sees that the same number is also the cash line.
    const exactCash = 'JOES DINER\nRECEIPT #12345678\nTOTAL 12.00\nCASH 12.00\nCHANGE 0.00';
    const out = applyLlmTightening(
      baseResult({ rawText: exactCash }),
      { ...expected, amount: 12 },
      judgment({ preTipTotal: 12, actualPayableTotal: 12, cashTendered: 12 }),
    );
    expect(out.result.amountMatches).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('FAILS OPEN when the model misses the cash fields (decimal-printed claim, old behavior)', () => {
    // cashTendered/changeGiven null -> the decimals-printed escape stands, exactly as before
    // the fields existed. The under-extraction protection for honest users is untouched.
    const out = applyLlmTightening(
      baseResult({ rawText: cashReceipt }),
      { ...expected, amount: 100 },
      judgment({ preTipTotal: 12, actualPayableTotal: 12 }),
    );
    expect(out.result.amountMatches).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('a MIS-EXTRACTED cash value that is not printed cannot flag (grounded)', () => {
    // Model asserts cashTendered=95 but no 95.00 is printed: the value grounds to null and
    // the claim (printed as decimal money) keeps the honest-under-extraction escape.
    const out = applyLlmTightening(
      baseResult({ rawText: cashReceipt }),
      { ...expected, amount: 100 },
      judgment({ preTipTotal: 12, actualPayableTotal: 12, cashTendered: 95 }),
    );
    expect(out.result.amountMatches).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('a claim that equals changeGiven but is ALSO within $1 of the pre-tip total passes via the near-preTip branch (no flag)', () => {
    // Receipt: Total 88.00, Cash 100.00, Change 88.00 — the preTip matches the claim first,
    // so the inflation branch is never reached even though changeGiven equals the claim.
    const sameAsChange = 'JOES DINER\nRECEIPT #12345678\nBURGER 80.00\nTAX 8.00\nTOTAL 88.00\nCASH 100.00\nCHANGE 88.00';
    const out = applyLlmTightening(
      baseResult({ rawText: sameAsChange }),
      { ...expected, amount: 88 },
      judgment({ preTipTotal: 88, actualPayableTotal: 88, cashTendered: 100, changeGiven: 88 }),
    );
    // near(claim, preTip) fires first -> no inflation flag despite changeGiven === claim.
    expect(out.result.amountMatches).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('IGNORES a tip disposition whose tip amount is not printed (ungrounded)', () => {
    const noTipPrinted = 'JOES DINER\nRECEIPT #12345678\nTOTAL 70.00\nFINAL 90.00';
    const out = applyLlmTightening(
      baseResult({ rawText: noTipPrinted }),
      { ...expected, amount: 90 },
      judgment({ preTipTotal: 70, tip: 20, actualPayableTotal: 90 }), // 20.00 nowhere in text
    );
    // Tip part ungrounded -> no tip flag; claim equals the printed final -> no inflation.
    expect(out.result.amountMatches).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  // ── Math coherence (fabricated-document detector, dual condition) ───────────────
  it('flags when the model reports inconsistency AND the printed numbers confirm it', () => {
    // 62.00 + 8.00 = 70.00, but the printed total is 75.00 - a drawn, not computed, receipt.
    const fake = 'JOES DINER\nRECEIPT #12345678\nSUB TOTAL 62.00\nTAX 8.00\nTOTAL 75.00';
    const out = applyLlmTightening(
      baseResult({ rawText: fake }),
      { ...expected, amount: 75 },
      judgment({ mathConsistent: false, mathProblem: 'subtotal+tax is 70 not 75', subtotal: 62, tax: 8, actualPayableTotal: 75 }),
    );
    expect(out.result.isReceipt).toBe(false);
    expect(out.reasons).toContain('llm_math_inconsistent');
  });

  it('IGNORES a math flag when the numbers actually cohere (model arithmetic error)', () => {
    const out = applyLlmTightening(
      baseResult({ rawText: tipReceipt }),
      { ...expected, amount: 70 },
      judgment({ mathConsistent: false, subtotal: 62, tax: 8, preTipTotal: 70, tip: 20, actualPayableTotal: 90 }),
    );
    expect(out.result.isReceipt).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('IGNORES a math flag built on numbers that are not printed (ungrounded)', () => {
    const out = applyLlmTightening(
      baseResult({ rawText: 'JOES DINER\nRECEIPT #12345678\nTOTAL 22.00' }),
      expected,
      judgment({ mathConsistent: false, subtotal: 99, tax: 1, actualPayableTotal: 22 }),
    );
    expect(out.result.isReceipt).toBe(true);
  });

  it('flags when the printed line items do not sum to the printed subtotal', () => {
    const fake = 'JOES DINER\nRECEIPT #12345678\nBURGER 10.00\nFRIES 5.00\nSUB TOTAL 40.00\nTAX 2.00\nTOTAL 42.00';
    const out = applyLlmTightening(
      baseResult({ rawText: fake }),
      { ...expected, amount: 42 },
      judgment({ mathConsistent: false, lineItemTotals: [10, 5], subtotal: 40, tax: 2, actualPayableTotal: 42 }),
    );
    expect(out.result.isReceipt).toBe(false);
    expect(out.reasons).toContain('llm_math_inconsistent');
  });

  it('a with-tip receipt is NOT judged inconsistent for final total exceeding subtotal+tax', () => {
    // Guard against the classic false positive: 62+8=70 while the final says 90 (tip 20).
    const out = applyLlmTightening(
      baseResult({ rawText: tipReceipt }),
      { ...expected, amount: 70 },
      judgment({ mathConsistent: false, subtotal: 62, tax: 8, tip: 20, preTipTotal: 70, actualPayableTotal: 90 }),
    );
    expect(out.result.isReceipt).toBe(true);
  });

  it('AUDIT REGRESSION: a sign-confused subtotal cannot enter the math check', () => {
    // Reviewer finding: model returns subtotal=-62 on a receipt printing 62.00; the old
    // abs-grounding accepted the negative value and corrupted the arithmetic. Totals must
    // ground as positive-only; a negative subtotal is discarded and no contradiction fires.
    const receipt = 'JOES DINER\nRECEIPT #12345678\nSUB TOTAL 62.00\nTAX 8.00\nTOTAL 70.00';
    const out = applyLlmTightening(
      baseResult({ rawText: receipt }),
      { ...expected, amount: 70 },
      judgment({ mathConsistent: false, subtotal: -62, tax: 8, preTipTotal: 70 }),
    );
    expect(out.result.isReceipt).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  it('REGRESSION: a claim-echoing final total cannot fabricate a contradiction', () => {
    // Observed live 2026-08-10: on an honest $70 pre-tip claim the model echoed 70 back as
    // actualPayableTotal while also reporting tip 20, so a "preTip + tip = final" check
    // computed 70+20 != 70 and failed the honest entry. The final-vs-tip check was removed;
    // this pins that an equivalent judgment can never flag again.
    const out = applyLlmTightening(
      baseResult({ rawText: tipReceipt }),
      { ...expected, amount: 70 },
      judgment({
        mathConsistent: false,
        mathProblem: 'adding the tip makes 90 not 70',
        subtotal: 62, tax: 8, tip: 20, preTipTotal: 70,
        actualPayableTotal: 70, // claim echo, not the real bottom line
      }),
    );
    expect(out.result.isReceipt).toBe(true);
    expect(out.reasons).toEqual([]);
  });
});

describe('parseJudgment', () => {
  it('clamps malformed fields to null instead of trusting the model', () => {
    const j = parseJudgment({
      isReceipt: 'yes',                 // wrong type
      actualPayableTotal: '23.50',      // numeric string is accepted
      merchantName: ' J ',              // too short after trim
      preTipTotal: -5,                  // non-positive
    });
    expect(j.isReceipt).toBeNull();
    expect(j.actualPayableTotal).toBe(23.5);
    expect(j.merchantName).toBeNull();
    expect(j.preTipTotal).toBeNull();
  });

  it('clamps the math fields: mixed-validity item arrays collapse to null', () => {
    const j = parseJudgment({
      subtotal: 62, tax: '8.00', tip: 0,            // 0 is not a real tip line
      cashTendered: '100.00',                        // numeric string is accepted
      changeGiven: -3,                               // non-positive -> null
      lineItemTotals: [10, 'x', 5],                  // one junk entry -> whole array unusable
      mathConsistent: false, mathProblem: '  sums are off  ',
    });
    expect(j.subtotal).toBe(62);
    expect(j.tax).toBe(8);
    expect(j.tip).toBeNull();
    expect(j.cashTendered).toBe(100);
    expect(j.changeGiven).toBeNull();
    expect(j.lineItemTotals).toBeNull();
    expect(j.mathConsistent).toBe(false);
    expect(j.mathProblem).toBe('sums are off');
  });

  it('accepts discount lines as negative line items', () => {
    const j = parseJudgment({ lineItemTotals: [10, -2.5, 5] });
    expect(j.lineItemTotals).toEqual([10, -2.5, 5]);
  });
});

describe('judgeReceiptLlm', () => {
  const OLD_ENV = process.env;
  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  it('returns null without an API key (feature is a safe no-op until the key is configured)', async () => {
    process.env = { ...OLD_ENV };
    delete process.env.GEMINI_API_KEY;
    expect(await judgeReceiptLlm('TOTAL 23.50', expected)).toBeNull();
  });

  it('returns null on a non-OK response instead of throwing', async () => {
    process.env = { ...OLD_ENV, GEMINI_API_KEY: 'test-key' };
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 429 } as Response);
    expect(await judgeReceiptLlm('TOTAL 23.50', expected)).toBeNull();
  });

  it('returns null on malformed model output instead of throwing', async () => {
    process.env = { ...OLD_ENV, GEMINI_API_KEY: 'test-key' };
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'sorry, no JSON here' }] } }] }),
    } as Response);
    expect(await judgeReceiptLlm('TOTAL 23.50', expected)).toBeNull();
  });

  it('parses a well-formed judgment out of the response', async () => {
    process.env = { ...OLD_ENV, GEMINI_API_KEY: 'test-key' };
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"isReceipt":true,"actualPayableTotal":23.50,"merchantName":"JOES DINER","preTipTotal":23.50,"mathConsistent":true}' }] } }],
      }),
    } as Response);
    const j = await judgeReceiptLlm('TOTAL 23.50', expected);
    expect(j).toEqual({
      isReceipt: true,
      actualPayableTotal: 23.5,
      merchantName: 'JOES DINER',
      preTipTotal: 23.5,
      subtotal: null,
      tax: null,
      tip: null,
      cashTendered: null,
      changeGiven: null,
      lineItemTotals: null,
      mathConsistent: true,
      mathProblem: null,
    });
  });
});
