import type { OcrProvider, OcrExpected, OcrValidationResult } from '../ocr.types.js';
import { matchAmount, matchDate, matchBusinessName, isReceiptText, scoreConfidence } from './ocr-matchers.js';
import { identifierFoundInText, normalizeReceiptIdentifier, extractDocumentTokens } from '../receiptIdentity.js';
import { readReceiptImage } from '../receiptRead.js';

// The model is a pure TRANSCRIBER: the image read (shared with the autofill endpoint via
// receiptRead.ts, which also caches it so a scanned photo is read ONCE, not once per stage)
// carries no user claim, so a hallucinating or prompt-injected model can never be steered
// toward a claim. All matching runs server-side on the returned transcript with the SAME
// deterministic matchers the Vision provider uses - the engine changes, the verdict logic
// does not. Read errors THROW out of readReceiptImage -> the ticket lands in the ocr_error
// retry loop (never a user-facing fail), exactly like a Vision outage.
export class GeminiVisionProvider implements OcrProvider {
  async validate(imageUrl: string, expected: OcrExpected): Promise<OcrValidationResult> {
    const read = await readReceiptImage(imageUrl);
    const rawText = read.transcript;
    const normalizedText = rawText.toUpperCase().replace(/\s+/g, ' ');

    // Identifier: the shared transcript matcher, plus the model's own label-value pairing as a
    // secondary signal - a candidate VALUE that normalizes to the typed id counts (this is the
    // pairing Vision structurally cannot do, and it is claim-independent: the model listed the
    // number before ever being compared to a claim). Candidates can WIDEN identifierFound only,
    // and ONLY for SHORT ids (under 4 alnum chars), where transcript glue can genuinely hide
    // the run; for normal-length ids the containment check is already reliable, so letting a
    // model field override it would just add injection surface for zero benefit. Every other
    // check stays transcript-deterministic, so injected text printed on the paper cannot flip
    // amounts, dates, or the receipt-ness verdict.
    const normalizedId = normalizeReceiptIdentifier(expected.identifier);
    const candidateHit = normalizedId.length > 0 && normalizedId.length < 4 && read.candidates.some(
      (c) => typeof (c as { value?: unknown })?.value === 'string'
        && normalizeReceiptIdentifier((c as { value: string }).value) === normalizedId,
    );
    const identifierFound = identifierFoundInText(expected.identifier, rawText) || candidateHit;

    const amountMatches = matchAmount(normalizedText, expected.amount);
    const dateMatches = expected.date ? matchDate(normalizedText, expected.date) : null;
    const isReceipt = isReceiptText(normalizedText);
    const businessNameFound = expected.businessName ? matchBusinessName(normalizedText, expected.businessName) : null;
    const confidence = scoreConfidence(identifierFound, amountMatches, dateMatches);
    const documentTokens = extractDocumentTokens(rawText);

    // Raw receipt text contains PII (names, card last-4, addresses) — never log it in production.
    if (process.env.NODE_ENV !== 'production') {
      console.log('[OCR] Gemini transcript:', JSON.stringify(rawText));
    }
    console.log('[OCR] Result (gemini):', JSON.stringify({ isReceipt, identifierFound, candidateHit, amountMatches, dateMatches, businessNameFound, confidence, tokenCount: documentTokens.length }));

    return { isReceipt, identifierFound, amountMatches, dateMatches, businessNameFound, confidence, rawText, documentTokens };
  }
}
