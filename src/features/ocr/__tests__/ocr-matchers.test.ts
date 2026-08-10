import { matchAmount, isReceiptText } from '../providers/ocr-matchers';

// matchAmount is the amount-verification gate. Three states:
//   true  → the claimed amount is printed on the receipt
//   false → monetary amounts are printed but the claim is not among them (user's amount is wrong)
//   null  → no monetary amount is legible → can't verify → let it slide
describe('matchAmount', () => {
  test('matches the claimed amount when it is printed (simple total)', () => {
    expect(matchAmount('TOTAL $450.00', 450)).toBe(true);
  });

  test('matches even when OCR reorders the layout away from the keyword', () => {
    // The real Google Vision failure that let a wrong amount slide: the keyword and the number
    // are separated by an identifier, so a TOTAL-anchored regex would never see the money.
    expect(matchAmount('TOTAL AMOUNT PAID 2121-0637 US$450.00', 450)).toBe(true);
  });

  test('rejects an inflated amount when a different amount is visible (the exploit)', () => {
    // Claiming $900 on a $450 receipt must FAIL, not slide through as "unverifiable".
    expect(matchAmount('TOTAL AMOUNT PAID 2121-0637 US$450.00', 900)).toBe(false);
  });

  test('lets the claim slide only when no monetary amount is legible at all', () => {
    expect(matchAmount('RECEIPT THANK YOU FOR SHOPPING', 450)).toBe(null);
  });

  test('accepts the total among subtotal/tax lines', () => {
    expect(matchAmount('SUBTOTAL 5.00 TAX 0.40 TOTAL 5.40', 5.40)).toBe(true);
  });

  test('rejects a wrong claim when subtotal/total amounts are visible', () => {
    expect(matchAmount('SUBTOTAL 5.00 TAX 0.40 TOTAL 5.40', 900)).toBe(false);
  });

  test('handles thousands separators', () => {
    expect(matchAmount('TOTAL $1,450.00', 1450)).toBe(true);
    expect(matchAmount('TOTAL $1,450.00', 1451)).toBe(false);
  });

  test('handles a comma decimal separator', () => {
    expect(matchAmount('SUM 450,00', 450)).toBe(true);
  });

  test('a whole-dollar claim matches a printed .00 amount', () => {
    expect(matchAmount('TOTAL $12.00', 12)).toBe(true);
  });
});

// isReceiptText is the "is this even a receipt" hard gate (≥3 keywords). Pinned by a real
// false-negative: a legible US restaurant receipt printing "Sub Total" (with a space) and no
// RECEIPT/PAID/AMOUNT words scored only TOTAL+TAX = 2 and hard-failed an honest customer.
describe('isReceiptText', () => {
  test('accepts a normal US restaurant receipt ("Sub Total" spaced, payment-method line)', () => {
    // Normalized the way the provider does: uppercased, whitespace collapsed to single spaces.
    const text = 'PIZZZOSH 145 MAIN STREET ORDER: #10432 1 LARGE PIZZA 34.00 SUB TOTAL $64.00 TAX (8.875%) $6.00 TOTAL $70.00 PAYMENT METHOD: VISA **** 7891';
    expect(isReceiptText(text)).toBe(true);
  });

  test('spaced "SUB TOTAL" counts as the SUBTOTAL keyword', () => {
    expect(isReceiptText('SUB TOTAL 5.00 TAX 0.40 GRAND TOTAL 5.40 PLUS FILLER TEXT TO PASS LENGTH')).toBe(true);
  });

  test('still rejects text with no receipt keywords', () => {
    expect(isReceiptText('HELLO WORLD THIS IS A PHOTO OF A DOG IN A PARK WEARING A LITTLE HAT')).toBe(false);
  });

  test('still rejects sparse keyword matches (fewer than 3)', () => {
    expect(isReceiptText('TOTAL 45.00 AND SOME OTHER UNRELATED WRITING WITH NO OTHER MARKERS')).toBe(false);
  });
});
