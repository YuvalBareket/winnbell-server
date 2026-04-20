import Tesseract from 'tesseract.js';
import type { OcrProvider, OcrExpected, OcrValidationResult } from '../ocr.types.js';

export class TesseractProvider implements OcrProvider {
  async validate(imageUrl: string, expected: OcrExpected): Promise<OcrValidationResult> {
    // Download image into a buffer
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image for OCR: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    // Run Tesseract OCR — suppress verbose logging
    const { data: { text } } = await Tesseract.recognize(buffer, 'eng', {
      logger: () => {},
    });

    const normalizedText = text.toUpperCase().replace(/\s+/g, ' ');

    // --- Identifier match ---
    const identifierFound = normalizedText.includes(expected.identifier.toUpperCase());

    // --- Amount match ---
    // Normalize amount to handle "$50.00", "50.00", "50,00", "$50" etc.
    const amountMatches = matchAmount(normalizedText, expected.amount);

    // --- Date match ---
    let dateMatches: boolean | null = null;
    if (expected.date) {
      dateMatches = matchDate(normalizedText, expected.date);
    }

    // --- Receipt heuristic ---
    // A real receipt typically contains keywords like TOTAL, AMOUNT, RECEIPT, INVOICE, TAX, etc.
    const receiptKeywords = ['TOTAL', 'AMOUNT', 'RECEIPT', 'INVOICE', 'TAX', 'SUBTOTAL', 'GST', 'VAT', 'PAID'];
    const keywordCount = receiptKeywords.filter(k => normalizedText.includes(k)).length;
    const isReceipt = keywordCount >= 1 && normalizedText.length > 20;

    // --- Confidence ---
    let confidence: 'high' | 'medium' | 'low';
    const matchCount = [identifierFound, amountMatches, dateMatches === true].filter(Boolean).length;
    if (matchCount >= 2) confidence = 'high';
    else if (matchCount === 1) confidence = 'medium';
    else confidence = 'low';

    return { isReceipt, identifierFound, amountMatches, dateMatches, confidence, rawText: text };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function matchAmount(text: string, amount: number): boolean {
  // Generate possible representations of the amount
  const variants = new Set<string>();
  variants.add(amount.toFixed(2));                          // "50.00"
  variants.add(amount.toFixed(0));                          // "50"
  variants.add(amount.toFixed(2).replace('.', ','));         // "50,00"
  variants.add(`$${amount.toFixed(2)}`);                    // "$50.00"
  variants.add(`$${amount.toFixed(0)}`);                    // "$50"
  // Handle thousands separators for large amounts (e.g. 1,234.56)
  if (amount >= 1000) {
    const formatted = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    variants.add(formatted);
    variants.add(`$${formatted}`);
  }
  for (const v of variants) {
    if (text.includes(v.toUpperCase()) || text.includes(v)) return true;
  }
  return false;
}

function matchDate(text: string, date: string): boolean {
  // date is YYYY-MM-DD — try common receipt date formats
  const [year, month, day] = date.split('-');
  const variants = [
    `${month}/${day}/${year}`,           // MM/DD/YYYY
    `${day}/${month}/${year}`,           // DD/MM/YYYY
    `${year}-${month}-${day}`,           // YYYY-MM-DD
    `${month}-${day}-${year}`,           // MM-DD-YYYY
    `${parseInt(month)}/${parseInt(day)}/${year}`, // M/D/YYYY no leading zeros
  ];
  return variants.some(v => text.includes(v));
}
