/**
 * Campaign start-date boundary tests (regression for the 2026-08-31 launch-night bug).
 *
 * draw.start_date is a timestamp holding campaign-LOCAL midnight, which on the UTC
 * server parses with an intra-day offset (e.g. 2026-08-31 04:00 UTC for US Eastern).
 * The client's transactionDate is date-only ("YYYY-MM-DD") and parses to 00:00 UTC.
 * Compared raw, a receipt dated exactly on the start day is rejected as pre-campaign.
 * The service must compare at DATE granularity.
 *
 * Mock pattern matches multi_entry.test.ts.
 */

// ---- mock the DB module before any imports ----
const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();

const mockClient = {
  query: mockClientQuery,
  release: mockRelease,
};

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue(mockClient),
  }),
}));

jest.mock('../../risk/risk.service.js', () => ({
  evaluateUserRisk: jest.fn().mockResolvedValue({ delta: 0, totalScore: 0, level: 'low', flags: [] }),
  updateUserRiskScore: jest.fn().mockResolvedValue(undefined),
  checkDuplicateReceiptIdentifier: jest.fn().mockResolvedValue({ isDuplicate: false }),
  countsAgainstCap: jest.fn().mockReturnValue(true),
  syncUserQuarantineState: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../ocr/ocr.service.js', () => ({
  validateReceiptAsync: jest.fn(),
}));

import { submitReceiptEntryService } from '../tickets.service';

// ─────────────────────────────────────────────
// Date fixtures — dynamic so the suite never ages into the 7-day-receipt rejection.
// "Start day" = today's UTC calendar date; the stored timestamp carries the 04:00
// offset exactly as pg hands it to the service on the UTC production server.
// ─────────────────────────────────────────────

const utcDateString = (d: Date): string => d.toISOString().split('T')[0];

const startDay = utcDateString(new Date()); // e.g. "2026-08-31"
const dayBefore = utcDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

// What pf.draw_start_date is on Render for an admin-entered start of `startDay`:
// campaign-local midnight (US Eastern) parsed on a UTC server.
const drawStartWithOffset = new Date(`${startDay}T04:00:00Z`);

const BASE_INPUT = {
  locationId: 10,
  receiptIdentifier: 'RCP-BOUNDARY-001',
  transactionAmount: 150,
  transactionDate: startDay,
  submitterIp: '127.0.0.1',
};

/** Full happy-path client.query response chain (see multi_entry.test.ts for the map). */
const buildResponses = () => [
  { rows: [] }, // BEGIN
  { rows: [] }, // user-level advisory lock
  { rows: [] }, // shared per-user cap lock
  {
    rows: [{
      is_email_verified: true,
      is_phone_verified: true,
      risk_score: 0,
      risk_last_flagged_at: null,
      risk_last_decayed_at: null,
      business_id: 5,
      business_name: 'Acme',
      business_sector: null,
      date_of_birth: null,
      min_transaction_amount: null,
      draw_id: 42,
      draw_start_date: drawStartWithOffset,
      settings_exists: true,
      global_entry_cap: null,
      entries_per_location: null,
      has_conflict: false,
      daily_count: 0,
      draw_count: 0,
    }],
  }, // preflight CTE
  { rows: [] }, // receipt-level advisory lock
  { rows: [{}] }, // claim map — no claims
  { rows: [] }, // duplicate-document fingerprint check
  { rows: [] }, // code conflict check
  { rows: [{ id: 100 }] }, // INSERT RETURNING id
  { rows: [] }, // COMMIT
];

const setupClientQueries = (responses: Array<{ rows: unknown[] }>) => {
  let i = 0;
  mockClientQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('campaign start-date boundary', () => {
  test('accepts a receipt dated exactly on the campaign start day despite the timezone offset in start_date', async () => {
    setupClientQueries(buildResponses());

    const result = await submitReceiptEntryService(1, { ...BASE_INPUT });

    expect(result.entryCount).toBe(1);
    expect(result.tickets).toHaveLength(1);
  });

  test('still rejects a receipt dated the day before the campaign start', async () => {
    setupClientQueries(buildResponses());

    await expect(
      submitReceiptEntryService(1, { ...BASE_INPUT, transactionDate: dayBefore }),
    ).rejects.toThrow('Transaction date must fall within the current campaign period.');

    // And nothing was inserted
    const insertCall = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO ticket'),
    );
    expect(insertCall).toBeUndefined();
  });
});
