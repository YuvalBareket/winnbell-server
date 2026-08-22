// Pins the receipt-scan autofill contract:
//   - SOFT FAILURE: any problem (no key, bad URL, HTTP error, junk output) returns null,
//     never throws - the form falls back to typing with the photo kept.
//   - SSRF guard: only the configured R2 bucket is ever fetched.
//   - Value clamps: the model's fields are sanitized before they ever reach the form.
import { extractReceiptFields, pickIdentifierCandidate } from '../receiptScan';
import { clearReceiptReadCache } from '../receiptRead';

const R2 = 'https://cdn.example.com';
const IMAGE_URL = `${R2}/receipt-images/abc.webp`;

const imageResponse = () => ({
  ok: true,
  headers: { get: (h: string) => (h === 'content-length' ? '1000' : 'image/webp') },
  arrayBuffer: async () => new ArrayBuffer(1000),
}) as unknown as Response;

const geminiResponse = (body: unknown) => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }),
}) as unknown as Response;

const mockFetch = (gemini: Response) =>
  jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
    String(url).startsWith(R2) ? imageResponse() : gemini);

describe('pickIdentifierCandidate', () => {
  it('prefers the transaction-number label over incidental numbers', () => {
    expect(pickIdentifierCandidate([
      { label: 'Auth code', value: '99181' },
      { label: 'Check', value: '#12' },
    ])).toBe('#12');
  });

  it('falls back to the first usable candidate when no label matches', () => {
    expect(pickIdentifierCandidate([
      { label: 'Something', value: 'A-77' },
      { label: 'Other', value: 'B-88' },
    ])).toBe('A-77');
  });

  it('rejects valueless, all-punctuation, and oversized candidates', () => {
    expect(pickIdentifierCandidate([])).toBeNull();
    expect(pickIdentifierCandidate([{ label: 'Check', value: '##--' }])).toBeNull();
    expect(pickIdentifierCandidate([{ label: 'Check', value: 'X'.repeat(101) }])).toBeNull();
    expect(pickIdentifierCandidate([{ label: 'Check' }])).toBeNull();
  });
});

describe('extractReceiptFields', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, GEMINI_API_KEY: 'test-key', R2_PUBLIC_URL: R2 };
    // The shared read caches by (url, byte hash); tests reuse both, so clear between cases.
    clearReceiptReadCache();
  });
  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  it('returns the picked identifier, cents-rounded amount, and valid date', async () => {
    mockFetch(geminiResponse({
      is_receipt: true,
      identifier_candidates: [{ label: 'Check', value: '#12' }],
      transcript: 'CHECK #12\nTOTAL 1.61',
      qualifying_amount: 1.611,
      receipt_date: '2026-08-17',
    }));
    expect(await extractReceiptFields(IMAGE_URL)).toEqual({ identifier: '#12', amount: 1.61, date: '2026-08-17' });
  });

  it('nulls out an invalid date and a non-positive amount instead of passing them through', async () => {
    mockFetch(geminiResponse({
      is_receipt: true,
      identifier_candidates: [{ label: 'Order', value: '8842' }],
      transcript: 'ORDER 8842',
      qualifying_amount: -5,
      receipt_date: '8/17/26',
    }));
    expect(await extractReceiptFields(IMAGE_URL)).toEqual({ identifier: '8842', amount: null, date: null });
  });

  it('returns null when the model says the photo is not a receipt', async () => {
    mockFetch(geminiResponse({ is_receipt: false, identifier_candidates: [], qualifying_amount: null, receipt_date: null }));
    expect(await extractReceiptFields(IMAGE_URL)).toBeNull();
  });

  it('returns null when nothing usable was read', async () => {
    mockFetch(geminiResponse({ is_receipt: true, identifier_candidates: [], transcript: 'COFFEE SHOP', qualifying_amount: null, receipt_date: null }));
    expect(await extractReceiptFields(IMAGE_URL)).toBeNull();
  });

  it('soft-fails (null, no throw) on missing key, foreign URL, HTTP error, and junk output', async () => {
    delete process.env.GEMINI_API_KEY;
    expect(await extractReceiptFields(IMAGE_URL)).toBeNull();

    process.env.GEMINI_API_KEY = 'test-key';
    const fetchSpy = jest.spyOn(global, 'fetch');
    expect(await extractReceiptFields('https://evil.example.com/x.jpg')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    jest.spyOn(global, 'fetch').mockImplementation(async (url) =>
      String(url).startsWith(R2)
        ? imageResponse()
        : ({ ok: false, status: 429 } as unknown as Response));
    expect(await extractReceiptFields(IMAGE_URL)).toBeNull();

    mockFetch({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'sorry' }] } }] }) } as unknown as Response);
    expect(await extractReceiptFields(IMAGE_URL)).toBeNull();
  });
});
