import type { OcrProvider, OcrExpected, OcrValidationResult } from '../ocr.types.js';
import { matchAmount, matchDate, matchBusinessName, isReceiptText, scoreConfidence } from './ocr-matchers.js';

export class GoogleVisionProvider implements OcrProvider {
  async validate(imageUrl: string, expected: OcrExpected): Promise<OcrValidationResult> {
    const apiKey = process.env.GOOGLE_VISION_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_VISION_API_KEY env var is not set');

    // SSRF protection — only fetch from the configured R2 bucket
    const r2BaseUrl = process.env.R2_PUBLIC_URL;
    if (!r2BaseUrl || !imageUrl.startsWith(r2BaseUrl + '/')) {
      throw new Error('Invalid image URL: must reference the application storage bucket');
    }

    // Download image and encode as base64 for Vision API
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to download image for OCR: ${imageResponse.status}`);
    }
    const buffer = Buffer.from(await imageResponse.arrayBuffer());
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

    const identifierFound = normalizedText.includes(expected.identifier.toUpperCase());
    const amountMatches = matchAmount(normalizedText, expected.amount);
    const dateMatches = expected.date ? matchDate(normalizedText, expected.date) : null;
    const isReceipt = isReceiptText(normalizedText);
    const businessNameFound = expected.businessName ? matchBusinessName(normalizedText, expected.businessName) : null;
    const confidence = scoreConfidence(identifierFound, amountMatches, dateMatches);

return { isReceipt, identifierFound, amountMatches, dateMatches, businessNameFound, confidence, rawText };
  }
}
