// Shared receipt matching helpers used by all OCR providers.
// Both TesseractProvider and GoogleVisionProvider import from here so
// validation logic stays consistent regardless of which provider extracted the text.

// Returns true  → amount found and matches user's claim
// Returns false → a total amount is visible but doesn't match (user lied) → fail
// Returns null  → no total visible in the image, can't verify → let it slide
export function matchAmount(text: string, amount: number): boolean | null {
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
  variants.add(`${amount.toFixed(2).replace('.', ',')}₪`);
  variants.add(`₪${amount.toFixed(2).replace('.', ',')}`);
  if (amount >= 1000) {
    const formatted = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    variants.add(formatted);
    variants.add(`$${formatted}`);
    variants.add(`₪${formatted}`);
    const ilFormatted = amount.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    variants.add(ilFormatted);
  }
  for (const v of variants) {
    if (text.includes(v.toUpperCase()) || text.includes(v)) return true;
  }

  // User's claimed amount not found in any formatting variant. Rather than depend on a
  // TOTAL/AMOUNT keyword sitting adjacent to the number (OCR frequently reorders layout, so
  // "TOTAL AMOUNT PAID <id> US$450.00" leaves no keyword next to the money), scan the whole
  // text for every monetary value printed on the receipt and compare against the claim:
  //   - claimed value is among the printed amounts         → true  (matches)
  //   - amounts are printed but the claim is not among them → false (user's amount is wrong)
  //   - no monetary amount is legible at all               → null  (can't verify, let it slide)
  // This closes the inflation hole where a wrong/high amount slid through as "unverifiable".
  const claimedCents = Math.round(amount * 100);
  let anyMoney = false;
  // A money value: digits with optional thousands separators, then a . or , and exactly 2 decimals,
  // not followed by another digit (so we don't clip "1.234" or a longer barcode run).
  for (const m of text.matchAll(/(\d[\d.,]*)[.,](\d{2})(?!\d)/g)) {
    const intPart = m[1].replace(/[.,]/g, '');
    const cents = Math.round(parseFloat(`${intPart}.${m[2]}`) * 100);
    if (!Number.isFinite(cents)) continue;
    anyMoney = true;
    if (cents === claimedCents) return true;
  }
  return anyMoney ? false : null;
}

// Returns true  → date found and matches user's claim
// Returns false → a date is visible but doesn't match (user lied) → fail
// Returns null  → no date visible in the image, can't verify → let it slide
export function matchDate(text: string, date: string): boolean | null {
  const [year, month, day] = date.split('-');
  const yy = year.slice(2); // 2-digit year (e.g. "26")
  const m  = String(parseInt(month));
  const d  = String(parseInt(day));
  const variants = [
    `${month}/${day}/${year}`,   // 04/18/2026
    `${day}/${month}/${year}`,   // 18/04/2026
    `${year}-${month}-${day}`,   // 2026-04-18
    `${month}-${day}-${year}`,   // 04-18-2026
    `${m}/${d}/${year}`,         // 4/18/2026
    `${month}/${day}/${yy}`,     // 04/18/26
    `${day}/${month}/${yy}`,     // 18/04/26
    `${m}/${d}/${yy}`,           // 4/18/26  ← most US retail receipts
  ];
  if (variants.some(v => text.includes(v))) return true;

  // Date not found — check if any date pattern is visible at all.
  // If a date is readable but didn't match any variant, the user entered the wrong date.
  const anyDateVisible = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(text)
    || /\b\d{4}-\d{2}-\d{2}\b/.test(text);
  return anyDateVisible ? false : null;
}

// Returns true  \u2192 business name confirmed in the receipt text
// Returns null  \u2192 cannot confirm (logo-only, abbreviated, not printed) \u2192 let it slide
// Never returns false \u2014 not finding the name doesn't mean it's the wrong business
export function matchBusinessName(text: string, businessName: string): true | null {
  const latinName  = businessName.toUpperCase().replace(/[^A-Z0-9\s]/g, '');
  const latinWords = latinName.split(/\s+/).filter(w => w.length >= 4);
  const hebrewName  = businessName.replace(/[^\u05D0-\u05EA\s]/g, '');
  const hebrewWords = hebrewName.split(/\s+/).filter(w => w.length >= 2);

  const significantWords = latinWords.length > 0 ? latinWords : hebrewWords;
  if (significantWords.length === 0) return null;

  const required = Math.min(2, significantWords.length);
  const matched  = significantWords.filter(word => text.includes(word)).length;
  return matched >= required ? true : null;
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
  amountMatches: boolean | null,
  dateMatches: boolean | null,
): 'high' | 'medium' | 'low' {
  const matchCount = [identifierFound, amountMatches === true, dateMatches === true].filter(Boolean).length;
  if (matchCount >= 2) return 'high';
  if (matchCount === 1) return 'medium';
  return 'low';
}
