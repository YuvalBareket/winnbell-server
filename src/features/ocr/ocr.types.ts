// The expected values the user submitted — what OCR should verify against
export interface OcrExpected {
  identifier: string;       // receipt/invoice identifier
  amount: number;           // transaction amount
  date?: string;            // YYYY-MM-DD, optional
  businessName?: string;    // used to verify the receipt belongs to the claimed business
}


// Structured result every provider must return
export interface OcrValidationResult {
  isReceipt: boolean;               // did the image look like a receipt at all? (requires ≥2 keywords)
  identifierFound: boolean;         // was the submitted identifier found in the image?
  amountMatches: boolean | null;    // null = total not visible; false = visible but wrong → fail
  dateMatches: boolean | null;      // null = date not visible; false = visible but wrong → fail
  businessNameFound: true | null;    // true = confirmed; null = unverifiable (logo-only, etc.) → never fails
  confidence: 'high' | 'medium' | 'low';
  rawText?: string;                 // extracted text, for debugging/logging
}

// The contract every OCR provider must implement
export interface OcrProvider {
  validate(imageUrl: string, expected: OcrExpected): Promise<OcrValidationResult>;
}

export type OcrValidationStatus = 'not_required' | 'pending' | 'passed' | 'failed' | 'ocr_error';
