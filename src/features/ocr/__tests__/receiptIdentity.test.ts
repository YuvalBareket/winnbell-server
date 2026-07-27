import { normalizeReceiptIdentifier, alnumOnly, extractDocumentTokens, canonicalizeReceiptIdentifier } from '../receiptIdentity';

describe('canonicalizeReceiptIdentifier', () => {
  const tokens = ['KDWJRMDV0001', '21210637'];
  test('completes a fragment to the full number it is part of', () => {
    expect(canonicalizeReceiptIdentifier('DWJRMDV0001', tokens)).toBe('KDWJRMDV0001'); // missing first char
    expect(canonicalizeReceiptIdentifier('KDWJRMDV000', tokens)).toBe('KDWJRMDV0001'); // missing last char
    expect(canonicalizeReceiptIdentifier('WJRMDV000', tokens)).toBe('KDWJRMDV0001');   // missing both ends
  });
  test('leaves a whole number unchanged', () => {
    expect(canonicalizeReceiptIdentifier('KDWJRMDV0001', tokens)).toBe('KDWJRMDV0001');
    expect(canonicalizeReceiptIdentifier('21210637', tokens)).toBe('21210637');
  });
  test('leaves a number that is not a fragment of any token unchanged', () => {
    expect(canonicalizeReceiptIdentifier('ABC9999', tokens)).toBe('ABC9999');
  });
});

describe('normalizeReceiptIdentifier', () => {
  test('strips punctuation and uppercases so formatting variants collapse to one', () => {
    expect(normalizeReceiptIdentifier('#1366-3859')).toBe('13663859');
    expect(normalizeReceiptIdentifier('1366-3859')).toBe('13663859');
    expect(normalizeReceiptIdentifier('1366 3859')).toBe('13663859');
    expect(normalizeReceiptIdentifier('rcp/1366.3859')).toBe('RCP13663859');
  });

  test('all three "#"/space/dash variants of the same number are equal after normalization', () => {
    const a = normalizeReceiptIdentifier('#1366-3859');
    const b = normalizeReceiptIdentifier('1366-3859');
    const c = normalizeReceiptIdentifier('1366 3859');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('extractDocumentTokens', () => {
  test('picks up BOTH the receipt number and the invoice number from a Stripe-style receipt', () => {
    const text = `Receipt from Winnbell, Inc.\nUS$450.00\nReceipt number 2121-0637\nInvoice number KDWJRMDV-0001\nVISA - 4242`;
    const tokens = extractDocumentTokens(text);
    expect(tokens).toContain('21210637');       // the receipt number
    expect(tokens).toContain('KDWJRMDV0001');    // the invoice number
  });

  test('excludes prices, card last-4, and short fragments (len < 6 or no digit)', () => {
    const tokens = extractDocumentTokens('TOTAL $450.00 VISA 4242 SUBTOTAL RECEIPT 45000');
    expect(tokens).not.toContain('45000');   // 5 chars — too short
    expect(tokens).not.toContain('4242');    // card last-4
    expect(tokens).not.toContain('RECEIPT'); // no digit
    expect(tokens).not.toContain('SUBTOTAL');
  });

  test('the typed (normalized) identifier is itself among the extracted tokens', () => {
    const id = normalizeReceiptIdentifier('2121-0637');
    const tokens = extractDocumentTokens('Order 2121-0637 total $12.00');
    expect(tokens).toContain(id);
  });

  test('caps the token set and returns a de-duplicated list', () => {
    const many = Array.from({ length: 100 }, (_, i) => `ID${100000 + i}`).join(' ');
    const tokens = extractDocumentTokens(many + ' ID100000 ID100000');
    expect(tokens.length).toBeLessThanOrEqual(40);
    expect(new Set(tokens).size).toBe(tokens.length); // de-duplicated
  });
});

describe('alnumOnly (identifier substring match projection)', () => {
  test('lets a normalized id be found even when the receipt printed it with a dash/space', () => {
    const printed = alnumOnly('Receipt number 1366-3859 thank you');
    expect(printed.includes(normalizeReceiptIdentifier('#1366-3859'))).toBe(true);
    expect(printed.includes(normalizeReceiptIdentifier('1366 3859'))).toBe(true);
  });
});
