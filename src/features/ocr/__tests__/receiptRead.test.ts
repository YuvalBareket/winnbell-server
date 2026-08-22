// Pins the single-read economics and its integrity rule:
//   - ONE MODEL CALL PER PHOTO: the autofill scan pays the Gemini call; submit-time
//     validation reuses the cached read (the bytes are re-fetched, the model is not).
//   - BYTES ARE THE KEY: if the object behind the URL changes after the scan (image swap),
//     the hash mismatch forces a FRESH model read of the new bytes - a cached transcript
//     can never vouch for a photo it was not read from.
import { extractReceiptFields } from '../receiptScan';
import { readReceiptImage, clearReceiptReadCache } from '../receiptRead';
import { GeminiVisionProvider } from '../providers/gemini-vision.provider';
import type { OcrExpected } from '../ocr.types';

const R2 = 'https://cdn.example.com';
const IMAGE_URL = `${R2}/receipt-images/abc.webp`;

const TRANSCRIPT =
  'GALGAL\n123 Main St\nCheck #12\nSubtotal 1.50\nTax 0.11\nTotal 1.61\nCash 2.00\nChange 0.39';

const expected: OcrExpected = { identifier: '12', amount: 1.61, date: undefined as unknown as string, businessName: 'Galgal' };

// fillByte distinguishes image contents: same length, different bytes -> different sha256.
const imageResponse = (fillByte = 0) => ({
  ok: true,
  headers: { get: (h: string) => (h === 'content-length' ? '1000' : 'image/webp') },
  arrayBuffer: async () => new Uint8Array(1000).fill(fillByte).buffer,
}) as unknown as Response;

const geminiResponse = (transcript: string) => ({
  ok: true,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      is_receipt: true,
      identifier_candidates: [{ label: 'Check', value: '#12' }],
      transcript,
      qualifying_amount: 1.61,
      receipt_date: '2026-08-17',
    }) }] } }],
  }),
}) as unknown as Response;

const geminiCallCount = (spy: jest.SpyInstance) =>
  spy.mock.calls.filter(([url]) => String(url).includes('generativelanguage')).length;

describe('receiptRead single-call cache', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, GEMINI_API_KEY: 'test-key', R2_PUBLIC_URL: R2 };
    clearReceiptReadCache();
  });
  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  it('scan-then-validate makes exactly ONE Gemini call for the same photo', async () => {
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
      String(url).startsWith(R2) ? imageResponse() : geminiResponse(TRANSCRIPT));

    const fields = await extractReceiptFields(IMAGE_URL);
    expect(fields).toEqual({ identifier: '#12', amount: 1.61, date: '2026-08-17' });
    expect(geminiCallCount(spy)).toBe(1);

    const result = await new GeminiVisionProvider().validate(IMAGE_URL, expected);
    expect(result.identifierFound).toBe(true);
    expect(result.amountMatches).toBe(true);
    expect(result.rawText).toBe(TRANSCRIPT);
    // The validation reused the cached read: still one model call total.
    expect(geminiCallCount(spy)).toBe(1);
  });

  it('swapped bytes at the same URL force a fresh model read (no stale vouching)', async () => {
    const swappedTranscript = 'OTHER STORE\nTotal 99.99';
    let fill = 0;
    let transcript = TRANSCRIPT;
    const spy = jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
      String(url).startsWith(R2) ? imageResponse(fill) : geminiResponse(transcript));

    await readReceiptImage(IMAGE_URL);
    expect(geminiCallCount(spy)).toBe(1);

    // Same URL, same bytes: cached.
    const again = await readReceiptImage(IMAGE_URL);
    expect(again.transcript).toBe(TRANSCRIPT);
    expect(geminiCallCount(spy)).toBe(1);

    // Object swapped behind the URL: hash differs, model re-reads the NEW bytes.
    fill = 7;
    transcript = swappedTranscript;
    const swapped = await readReceiptImage(IMAGE_URL);
    expect(swapped.transcript).toBe(swappedTranscript);
    expect(geminiCallCount(spy)).toBe(2);
  });
});
