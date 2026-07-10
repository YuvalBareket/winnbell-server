/**
 * Tests — TesseractProvider (OCR validation)
 *
 * External dependencies mocked:
 *   - tesseract.js  → Tesseract.recognize()
 *   - fetch         → global fetch (image download)
 *
 * Environment:
 *   - R2_PUBLIC_URL set to 'https://cdn.example.com' in each test
 *   - imageUrl constructed as `${R2_PUBLIC_URL}/receipts/test.jpg`
 *
 * The provider validates:
 *   - isReceipt:          ≥2 receipt-domain keywords AND text.length > 50
 *   - identifierFound:    the submitted identifier string appears in OCR text
 *   - amountMatches:      the amount (in any supported format) appears in OCR text
 *   - businessNameFound:  at least one significant word (4+ chars) of business name found
 *   - dateMatches:        date string appears in at least one receipt date format
 */

// ── Mock tesseract.js before importing the provider ──────────────────────────

const mockRecognize = jest.fn();
jest.mock('tesseract.js', () => ({
  __esModule: true,
  default: { recognize: mockRecognize },
}));

// ── Mock global fetch ─────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { TesseractProvider } from '../providers/tesseract.provider';

// ─── Shared setup ─────────────────────────────────────────────────────────────

const R2_BASE = 'https://cdn.example.com';
const IMAGE_URL = `${R2_BASE}/receipts/test.jpg`;

/**
 * Configure the fetch mock to return a successful response with a fake buffer,
 * and the Tesseract mock to return the supplied OCR text.
 */
const setupOcr = (ocrText: string) => {
  const fakeBuffer = new Uint8Array([1, 2, 3]).buffer;
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(fakeBuffer),
  } as unknown as Response);

  mockRecognize.mockResolvedValue({ data: { text: ocrText } });
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.R2_PUBLIC_URL = R2_BASE;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. SSRF / URL validation
// ─────────────────────────────────────────────────────────────────────────────
describe('SSRF protection — image URL validation', () => {
  const provider = new TesseractProvider();

  test('throws when R2_PUBLIC_URL is not set', async () => {
    delete process.env.R2_PUBLIC_URL;
    await expect(
      provider.validate(IMAGE_URL, { identifier: 'RCPT001', amount: 50 }),
    ).rejects.toThrow('Invalid image URL');
  });

  test('throws when imageUrl does not start with R2_PUBLIC_URL prefix', async () => {
    await expect(
      provider.validate('https://evil.com/image.jpg', { identifier: 'RCPT001', amount: 50 }),
    ).rejects.toThrow('Invalid image URL');
  });

  test('throws when fetch returns a non-OK status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
    await expect(
      provider.validate(IMAGE_URL, { identifier: 'RCPT001', amount: 50 }),
    ).rejects.toThrow('Failed to download image');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. isReceipt heuristic
// ─────────────────────────────────────────────────────────────────────────────
describe('isReceipt heuristic', () => {
  const provider = new TesseractProvider();

  test('isReceipt is true when text has ≥2 receipt keywords and length > 50', async () => {
    // "TOTAL" and "RECEIPT" are two keywords; the identifier and padding ensure > 50 chars
    setupOcr(
      'RECEIPT STORE ABC TOTAL 50.00 THANK YOU FOR YOUR PURCHASE RCPT001 DATE 2026-04-22',
    );
    const result = await provider.validate(IMAGE_URL, { identifier: 'RCPT001', amount: 50 });
    expect(result.isReceipt).toBe(true);
  });

  test('isReceipt is false when only 1 keyword is present', async () => {
    // Only "TOTAL" — that is exactly 1 keyword
    setupOcr('TOTAL 50.00 something something something something something something something');
    const result = await provider.validate(IMAGE_URL, { identifier: 'RCPT001', amount: 50 });
    expect(result.isReceipt).toBe(false);
  });

  test('isReceipt is false when text is too short even with 2 keywords', async () => {
    // "TOTAL RECEIPT" is < 50 chars and no identifier padding
    setupOcr('TOTAL RECEIPT 50.00');
    const result = await provider.validate(IMAGE_URL, { identifier: 'RCPT001', amount: 50 });
    expect(result.isReceipt).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Identifier match
// ─────────────────────────────────────────────────────────────────────────────
describe('Identifier match', () => {
  const provider = new TesseractProvider();

  test('identifierFound is true when identifier appears in OCR text', async () => {
    setupOcr('RECEIPT TOTAL 99.00 TAX 9.00 RCPT001 THANK YOU PAID IN FULL TODAY');
    const result = await provider.validate(IMAGE_URL, { identifier: 'RCPT001', amount: 99 });
    expect(result.identifierFound).toBe(true);
  });

  test('identifierFound is false when identifier is absent', async () => {
    setupOcr('RECEIPT TOTAL 99.00 TAX 9.00 XXXXXXX THANK YOU PAID IN FULL TODAY');
    const result = await provider.validate(IMAGE_URL, { identifier: 'RCPT001', amount: 99 });
    expect(result.identifierFound).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Amount match
// ─────────────────────────────────────────────────────────────────────────────
describe('Amount match', () => {
  const provider = new TesseractProvider();

  test('amountMatches is true when amount appears as decimal in OCR text', async () => {
    setupOcr('RECEIPT TOTAL 75.00 TAX 5.00 RCPT002 PAID THANK YOU PURCHASE SUBTOTAL');
    const result = await provider.validate(IMAGE_URL, { identifier: 'RCPT002', amount: 75 });
    expect(result.amountMatches).toBe(true);
  });

  test('amountMatches is true when amount appears with dollar sign', async () => {
    setupOcr('RECEIPT TOTAL $75.00 TAX 5.00 RCPT002 PAID THANK YOU PURCHASE SUBTOTAL');
    const result = await provider.validate(IMAGE_URL, { identifier: 'RCPT002', amount: 75 });
    expect(result.amountMatches).toBe(true);
  });

  test('amountMatches is false when the submitted amount is absent from OCR text', async () => {
    // Text contains 99.00 but submitted amount is 50
    setupOcr('RECEIPT TOTAL 99.00 TAX 9.00 RCPT002 PAID THANK YOU PURCHASE SUBTOTAL');
    const result = await provider.validate(IMAGE_URL, { identifier: 'RCPT002', amount: 50 });
    expect(result.amountMatches).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Business name match
// ─────────────────────────────────────────────────────────────────────────────
describe('Business name match', () => {
  const provider = new TesseractProvider();

  test('businessNameFound is true when a significant word (4+ chars) from business name appears', async () => {
    setupOcr('STARBUCKS COFFEE RECEIPT TOTAL 12.00 PAID RCPT003 PURCHASE SUBTOTAL THANK YOU');
    const result = await provider.validate(IMAGE_URL, {
      identifier: 'RCPT003',
      amount: 12,
      businessName: 'Starbucks Coffee',
    });
    expect(result.businessNameFound).toBe(true);
  });

  test('businessNameFound is null when no significant word from business name appears', async () => {
    // matchBusinessName never returns false: not finding the name does not prove it is the
    // wrong business (logos, abbreviations). Absent -> null ("cannot confirm, let it slide").
    setupOcr('ACME CORP RECEIPT TOTAL 12.00 PAID RCPT003 PURCHASE SUBTOTAL THANK YOU');
    const result = await provider.validate(IMAGE_URL, {
      identifier: 'RCPT003',
      amount: 12,
      businessName: 'Starbucks Coffee',
    });
    expect(result.businessNameFound).toBeNull();
  });

  test('businessNameFound is null when no businessName is provided in expected', async () => {
    setupOcr('RECEIPT TOTAL 12.00 PAID RCPT003 PURCHASE SUBTOTAL THANK YOU FOR SHOPPING');
    const result = await provider.validate(IMAGE_URL, {
      identifier: 'RCPT003',
      amount: 12,
      // businessName intentionally omitted
    });
    expect(result.businessNameFound).toBeNull();
  });

  test('businessNameFound is null when all words in business name are shorter than 4 chars', async () => {
    // "ABC" → 3 chars → filtered out → significantWords is empty → null
    setupOcr('RECEIPT TOTAL 12.00 PAID RCPT003 PURCHASE SUBTOTAL THANK YOU FOR SHOPPING');
    const result = await provider.validate(IMAGE_URL, {
      identifier: 'RCPT003',
      amount: 12,
      businessName: 'ABC',
    });
    expect(result.businessNameFound).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Date match
// ─────────────────────────────────────────────────────────────────────────────
describe('Date match', () => {
  const provider = new TesseractProvider();

  test('dateMatches is true when date appears in MM/DD/YYYY format', async () => {
    setupOcr('RECEIPT TOTAL 30.00 PAID 04/22/2026 RCPT004 PURCHASE SUBTOTAL THANK YOU');
    const result = await provider.validate(IMAGE_URL, {
      identifier: 'RCPT004',
      amount: 30,
      date: '2026-04-22',
    });
    expect(result.dateMatches).toBe(true);
  });

  test('dateMatches is null when no date is visible in the OCR text', async () => {
    // Absent date -> null ("cannot verify, let it slide"). It only returns false when a
    // DIFFERENT date is visible on the receipt (a real contradiction / fraud signal).
    setupOcr('RECEIPT TOTAL 30.00 PAID RCPT004 PURCHASE SUBTOTAL THANK YOU SOMETHING HERE');
    const result = await provider.validate(IMAGE_URL, {
      identifier: 'RCPT004',
      amount: 30,
      date: '2026-04-22',
    });
    expect(result.dateMatches).toBeNull();
  });

  test('dateMatches is null when no date is provided in expected', async () => {
    setupOcr('RECEIPT TOTAL 30.00 PAID RCPT004 PURCHASE SUBTOTAL THANK YOU SOMETHING HERE');
    const result = await provider.validate(IMAGE_URL, {
      identifier: 'RCPT004',
      amount: 30,
      // date intentionally omitted
    });
    expect(result.dateMatches).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Confidence levels
// ─────────────────────────────────────────────────────────────────────────────
describe('Confidence level derivation', () => {
  const provider = new TesseractProvider();

  test('confidence is "high" when ≥2 of identifier/amount/date match', async () => {
    // identifier matches + amount matches + date matches → 3 → high
    setupOcr(
      'RECEIPT TOTAL 50.00 PAID RCPT005 04/22/2026 PURCHASE SUBTOTAL THANK YOU HERE',
    );
    const result = await provider.validate(IMAGE_URL, {
      identifier: 'RCPT005',
      amount: 50,
      date: '2026-04-22',
    });
    expect(result.confidence).toBe('high');
  });

  test('confidence is "medium" when exactly 1 of identifier/amount/date matches', async () => {
    // Only identifier matches; amount is wrong; no date provided
    setupOcr('RECEIPT TOTAL 999.00 PAID RCPT005 PURCHASE SUBTOTAL THANK YOU FOR BEING HERE');
    const result = await provider.validate(IMAGE_URL, {
      identifier: 'RCPT005',
      amount: 50, // won't match 999.00
    });
    expect(result.confidence).toBe('medium');
  });

  test('confidence is "low" when no match fields are satisfied', async () => {
    // Nothing matches
    setupOcr('RECEIPT TOTAL 999.00 PAID XXXXXXX PURCHASE SUBTOTAL THANK YOU FOR BEING HERE');
    const result = await provider.validate(IMAGE_URL, {
      identifier: 'RCPT005',
      amount: 50,
    });
    expect(result.confidence).toBe('low');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Full passing receipt — all checks satisfied
// ─────────────────────────────────────────────────────────────────────────────
describe('Full passing receipt — all fields satisfied', () => {
  test('returns passed=true equivalent (isReceipt, identifierFound, amountMatches all true)', async () => {
    setupOcr(
      'STARBUCKS COFFEE RECEIPT INVOICE TOTAL $45.00 TAX $4.50 SUBTOTAL $40.50 ' +
      'RCPT123 04/22/2026 THANK YOU FOR YOUR PURCHASE PAID CHANGE 0.00',
    );
    const result = await provider.validate(IMAGE_URL, {
      identifier: 'RCPT123',
      amount: 45,
      date: '2026-04-22',
      businessName: 'Starbucks Coffee',
    });
    expect(result.isReceipt).toBe(true);
    expect(result.identifierFound).toBe(true);
    expect(result.amountMatches).toBe(true);
    expect(result.dateMatches).toBe(true);
    expect(result.businessNameFound).toBe(true);
    expect(result.confidence).toBe('high');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared provider instance for last describe block (avoids re-declaration)
// ─────────────────────────────────────────────────────────────────────────────
const provider = new TesseractProvider();
