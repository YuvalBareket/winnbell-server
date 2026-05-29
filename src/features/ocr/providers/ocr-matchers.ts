// Shared receipt matching helpers used by all OCR providers.
// Both TesseractProvider and GoogleVisionProvider import from here so
// validation logic stays consistent regardless of which provider extracted the text.

export function matchAmount(text: string, amount: number): boolean {
  const variants = new Set<string>();
  variants.add(amount.toFixed(2));
  variants.add(amount.toFixed(0));
  variants.add(amount.toFixed(2).replace('.', ','));
  // USD
  variants.add(`$${amount.toFixed(2)}`);
  variants.add(`$${amount.toFixed(0)}`);
  // ILS (shekel)
  variants.add(`₪${amount.toFixed(2)}`);
  variants.add(`₪${amount.toFixed(0)}`);
  variants.add(`${amount.toFixed(2)}₪`);
  variants.add(`${amount.toFixed(0)}₪`);
  // Israeli locale uses comma as decimal separator
  variants.add(amount.toFixed(2).replace('.', ','));
  variants.add(`${amount.toFixed(2).replace('.', ',')}₪`);
  variants.add(`₪${amount.toFixed(2).replace('.', ',')}`);
  if (amount >= 1000) {
    const formatted = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    variants.add(formatted);
    variants.add(`$${formatted}`);
    variants.add(`₪${formatted}`);
    // Israeli thousands with period separator: 1.619,40
    const ilFormatted = amount.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    variants.add(ilFormatted);
  }
  for (const v of variants) {
    if (text.includes(v.toUpperCase()) || text.includes(v)) return true;
  }
  return false;
}

export function matchDate(text: string, date: string): boolean {
  const [year, month, day] = date.split('-');
  const variants = [
    `${month}/${day}/${year}`,
    `${day}/${month}/${year}`,
    `${year}-${month}-${day}`,
    `${month}-${day}-${year}`,
    `${parseInt(month)}/${parseInt(day)}/${year}`,
  ];
  return variants.some(v => text.includes(v));
}

export function matchBusinessName(text: string, businessName: string): boolean | null {
  // Latin name matching (strip non-latin, uppercase)
  const latinName = businessName.toUpperCase().replace(/[^A-Z0-9\s]/g, '');
  const latinWords = latinName.split(/\s+/).filter(w => w.length >= 4);

  // Hebrew name matching (preserve Hebrew characters)
  const hebrewName = businessName.replace(/[^\u05D0-\u05EA\s]/g, '');
  const hebrewWords = hebrewName.split(/\s+/).filter(w => w.length >= 2);

  const significantWords = latinWords.length > 0 ? latinWords : hebrewWords;
  if (significantWords.length === 0) return null;

  const required = Math.min(2, significantWords.length);
  const matched = significantWords.filter(word => text.includes(word)).length;
  return matched >= required;
}

export const RECEIPT_KEYWORDS = [
  // English
  'TOTAL', 'AMOUNT', 'RECEIPT', 'INVOICE', 'TAX', 'SUBTOTAL',
  'GST', 'VAT', 'PAID', 'CHANGE', 'BALANCE', 'PURCHASE',
  // Hebrew
  'סהכ', 'סה"כ', 'מעמ', 'מע"מ', 'חשבונית', 'קבלה', 'תשלום',
  'מחיר', 'סכום', 'עודף', 'שולם', 'כולל', 'לתשלום',
];

export function isReceiptText(text: string): boolean {
  // Lower threshold for short receipts or non-Latin scripts
  const keywordCount = RECEIPT_KEYWORDS.filter(k => text.includes(k)).length;
  if (keywordCount >= 3 && text.length > 50) return true;
  // Hebrew receipts: 1 strong keyword is enough if there's Hebrew text present
  const hasHebrew = /[\u05D0-\u05EA]/.test(text);
  const hebrewKeywords = ['סהכ', 'סה"כ', 'מעמ', 'מע"מ', 'חשבונית', 'קבלה', 'לתשלום'];
  const hebrewKeywordCount = hebrewKeywords.filter(k => text.includes(k)).length;
  if (hasHebrew && hebrewKeywordCount >= 1) return true;
  return false;
}

export function scoreConfidence(
  identifierFound: boolean,
  amountMatches: boolean,
  dateMatches: boolean | null,
): 'high' | 'medium' | 'low' {
  const matchCount = [identifierFound, amountMatches, dateMatches === true].filter(Boolean).length;
  if (matchCount >= 2) return 'high';
  if (matchCount === 1) return 'medium';
  return 'low';
}
