// Shared receipt matching helpers used by all OCR providers.
// Both TesseractProvider and GoogleVisionProvider import from here so
// validation logic stays consistent regardless of which provider extracted the text.

export function matchAmount(text: string, amount: number): boolean {
  const variants = new Set<string>();
  variants.add(amount.toFixed(2));
  variants.add(amount.toFixed(0));
  variants.add(amount.toFixed(2).replace('.', ','));
  variants.add(`$${amount.toFixed(2)}`);
  variants.add(`$${amount.toFixed(0)}`);
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
  const normalizedBizName = businessName.toUpperCase().replace(/[^A-Z0-9\s]/g, '');
  const significantWords = normalizedBizName.split(/\s+/).filter(w => w.length >= 4);
  if (significantWords.length === 0) return null;
  return significantWords.some(word => text.includes(word));
}

export const RECEIPT_KEYWORDS = [
  'TOTAL', 'AMOUNT', 'RECEIPT', 'INVOICE', 'TAX', 'SUBTOTAL',
  'GST', 'VAT', 'PAID', 'CHANGE', 'BALANCE', 'PURCHASE',
];

export function isReceiptText(text: string): boolean {
  const keywordCount = RECEIPT_KEYWORDS.filter(k => text.includes(k)).length;
  return keywordCount >= 2 && text.length > 50;
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
