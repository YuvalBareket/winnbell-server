import Tesseract from 'tesseract.js';
import type { OcrProvider, OcrExpected, OcrValidationResult } from '../ocr.types.js';
import { matchAmount, matchDate, matchBusinessName, isReceiptText, scoreConfidence } from './ocr-matchers.js';
import { normalizeReceiptIdentifier, alnumOnly, extractDocumentTokens } from '../receiptIdentity.js';

export class TesseractProvider implements OcrProvider {
  async validate(imageUrl: string, expected: OcrExpected): Promise<OcrValidationResult> {
    const r2BaseUrl = process.env.R2_PUBLIC_URL;
    if (!r2BaseUrl || !imageUrl.startsWith(r2BaseUrl + '/')) {
      throw new Error('Invalid image URL: must reference the application storage bucket');
    }

    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image for OCR: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const { data: { text } } = await Tesseract.recognize(buffer, 'eng', {
      logger: () => {},
    });

    const normalizedText = text.toUpperCase().replace(/\s+/g, ' ');

    // Guard the empty case: "".includes("") is true, so an empty normalized id must not "match".
    const normalizedId = normalizeReceiptIdentifier(expected.identifier);
    const identifierFound = normalizedId.length > 0 && alnumOnly(text).includes(normalizedId);
    const amountMatches = matchAmount(normalizedText, expected.amount);
    const dateMatches = expected.date ? matchDate(normalizedText, expected.date) : null;
    const isReceipt = isReceiptText(normalizedText);
    const businessNameFound = expected.businessName ? matchBusinessName(normalizedText, expected.businessName) : null;
    const confidence = scoreConfidence(identifierFound, amountMatches, dateMatches);
    const documentTokens = extractDocumentTokens(text);

    return { isReceipt, identifierFound, amountMatches, dateMatches, businessNameFound, confidence, rawText: text, documentTokens };
  }
}
