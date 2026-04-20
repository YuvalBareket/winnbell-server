// The expected values the user submitted — what OCR should verify against
export interface OcrExpected {
  identifier: string;       // receipt/invoice identifier
  amount: number;           // transaction amount
  date?: string;            // YYYY-MM-DD, optional
}

// Structured result every provider must return
export interface OcrValidationResult {
  isReceipt: boolean;           // did the image look like a receipt at all?
  identifierFound: boolean;     // was the submitted identifier found in the image?
  amountMatches: boolean;       // was the submitted amount found in the image?
  dateMatches: boolean | null;  // null if no date was expected
  confidence: 'high' | 'medium' | 'low';
  rawText?: string;             // extracted text, for debugging/logging
}

// The contract every OCR provider must implement
export interface OcrProvider {
  validate(imageUrl: string, expected: OcrExpected): Promise<OcrValidationResult>;
}

export type OcrValidationStatus = 'not_required' | 'pending' | 'passed' | 'failed' | 'skipped';
