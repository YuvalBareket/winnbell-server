import type { OcrProvider, OcrExpected, OcrValidationResult } from '../ocr.types.js';
import { matchAmount, matchDate, matchBusinessName, isReceiptText, scoreConfidence } from './ocr-matchers.js';
import { normalizeReceiptIdentifier, alnumOnly, extractDocumentTokens } from '../receiptIdentity.js';

export class GoogleVisionProvider implements OcrProvider {
  async validate(imageUrl: string, expected: OcrExpected): Promise<OcrValidationResult> {
    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_VISION_API_KEY env var is not set');

    // SSRF protection — only fetch from the configured R2 bucket
    const r2BaseUrl = process.env.R2_PUBLIC_URL;
    if (!r2BaseUrl || !imageUrl.startsWith(r2BaseUrl + '/')) {
      throw new Error('Invalid image URL: must reference the application storage bucket');
    }

    // Download image and encode as base64 for the Vision API. Defensive size cap: uploads
    // are already capped at 10 MB (signed into the presigned URL), but never load an
    // unbounded body into memory here. Check the declared length first, then verify the
    // actual bytes in case the header is missing or wrong.
    const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB — matches the upload cap
    const TOO_LARGE = 'Receipt image is too large to process. Please upload a photo under 10 MB.';
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to download the receipt image (status ${imageResponse.status}). Please try submitting it again.`);
    }
    const declaredLength = Number(imageResponse.headers.get('content-length'));
    if (declaredLength && declaredLength > MAX_IMAGE_BYTES) {
      throw new Error(TOO_LARGE);
    }
    const buffer = Buffer.from(await imageResponse.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(TOO_LARGE);
    }
    const base64Image = buffer.toString('base64');

    // Call Vision REST API — TEXT_DETECTION is optimised for sparse text (receipts)
    const visionResponse = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [{
            image: { content: base64Image },
            features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
          }],
        }),
      },
    );

    if (!visionResponse.ok) {
      const err = await visionResponse.text();
      throw new Error(`Google Vision API error ${visionResponse.status}: ${err}`);
    }

    const visionData = await visionResponse.json() as any;
    const annotation = visionData?.responses?.[0];

    if (annotation?.error) {
      throw new Error(`Google Vision annotation error: ${annotation.error.message}`);
    }

    // fullTextAnnotation.text has the complete extracted text with layout preserved
    const rawText: string = annotation?.fullTextAnnotation?.text ?? '';
    const normalizedText = rawText.toUpperCase().replace(/\s+/g, ' ');

    // Match the identifier on the fully alnum-only projection so a normalized id ("13663859")
    // is found even when the receipt printed it as "1366-3859" / "1366 3859". Guard the empty
    // case: "".includes("") is true, so an empty normalized id must never count as found.
    const normalizedId = normalizeReceiptIdentifier(expected.identifier);
    const identifierFound = normalizedId.length > 0 && alnumOnly(rawText).includes(normalizedId);
    const amountMatches = matchAmount(normalizedText, expected.amount);
    const dateMatches = expected.date ? matchDate(normalizedText, expected.date) : null;
    const isReceipt = isReceiptText(normalizedText);
    const businessNameFound = expected.businessName ? matchBusinessName(normalizedText, expected.businessName) : null;
    const confidence = scoreConfidence(identifierFound, amountMatches, dateMatches);
    const documentTokens = extractDocumentTokens(rawText);

    // Raw receipt text contains PII (names, card last-4, addresses) — never log it in production.
    if (process.env.NODE_ENV !== 'production') {
      console.log('[OCR] Google Vision raw text:', JSON.stringify(rawText));
    }
    console.log('[OCR] Result:', JSON.stringify({ isReceipt, identifierFound, amountMatches, dateMatches, businessNameFound, confidence, tokenCount: documentTokens.length }));

    return { isReceipt, identifierFound, amountMatches, dateMatches, businessNameFound, confidence, rawText, documentTokens };
  }
}
