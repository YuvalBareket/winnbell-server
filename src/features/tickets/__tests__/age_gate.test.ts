/**
 * 21+ age gate for tobacco & liquor (sector 'Liquor') businesses.
 *
 * Lawyer-mandated: users aged 18-20 must not earn entries at businesses whose
 * primary classification is liquor/tobacco. The gate lives in the preflight of
 * submitReceiptEntryService and fails closed on a missing DOB.
 *
 * Mock pattern matches multi_entry.test.ts exactly.
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
import { isAtLeast21, AGE_RESTRICTED_SECTOR } from '../../../shared/ageRestriction';

const BASE_INPUT = {
  locationId: 10,
  receiptIdentifier: 'RCP-AGE-001',
  transactionAmount: 150,
  transactionDate: new Date().toISOString().split('T')[0],
  submitterIp: '127.0.0.1',
};

const dobYearsAgo = (years: number): string => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().split('T')[0];
};

/** Full happy-path response sequence; sector/date_of_birth injected into the preflight row. */
const buildClientResponses = (opts: { sector: string; dateOfBirth: string | null }) => {
  const responses: Array<{ rows: unknown[]; rowCount?: number | null }> = [
    { rows: [] }, // BEGIN
    { rows: [] }, // user-level advisory lock
    { rows: [] }, // shared per-user cap lock (udcap)
    {
      rows: [{
        is_email_verified: true,
        risk_score: 0,
        risk_last_flagged_at: null,
        business_id: 5,
        business_name: 'Acme Liquor',
        business_sector: opts.sector,
        date_of_birth: opts.dateOfBirth,
        min_transaction_amount: null,
        draw_id: 42,
        draw_opened_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        settings_exists: true,
        global_entry_cap: null,
        has_conflict: false,
        daily_count: 0,
        draw_count: 0,
      }],
    }, // preflight CTE
    { rows: [] }, // receipt-level advisory lock
    { rows: [{ image_backed_by_other: false, typed_only_by_other: false }] }, // claim-state
    { rows: [] }, // ownExisting
    { rows: [] }, // duplicate-document fingerprint check
    { rows: [] }, // code conflict check
    { rows: [{ id: 100 }] }, // INSERT RETURNING id
    { rows: [] }, // COMMIT
  ];
  return responses;
};

const setupClientQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
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

describe('21+ gate at age-restricted (Liquor) businesses', () => {
  test('blocks a 19-year-old at a Liquor-sector business', async () => {
    setupClientQueries(...buildClientResponses({ sector: AGE_RESTRICTED_SECTOR, dateOfBirth: dobYearsAgo(19) }));

    await expect(submitReceiptEntryService(1, BASE_INPUT))
      .rejects.toThrow('aged 21 and older');
  });

  test('blocks when DOB is missing at a Liquor-sector business (fails closed)', async () => {
    setupClientQueries(...buildClientResponses({ sector: AGE_RESTRICTED_SECTOR, dateOfBirth: null }));

    await expect(submitReceiptEntryService(1, BASE_INPUT))
      .rejects.toThrow('aged 21 and older');
  });

  test('allows a 25-year-old at a Liquor-sector business', async () => {
    setupClientQueries(...buildClientResponses({ sector: AGE_RESTRICTED_SECTOR, dateOfBirth: dobYearsAgo(25) }));

    const result = await submitReceiptEntryService(1, BASE_INPUT);
    expect(result.tickets).toHaveLength(1);
  });

  test('allows a 19-year-old at a non-restricted (Food) business', async () => {
    setupClientQueries(...buildClientResponses({ sector: 'Food', dateOfBirth: dobYearsAgo(19) }));

    const result = await submitReceiptEntryService(1, BASE_INPUT);
    expect(result.tickets).toHaveLength(1);
  });
});

describe('isAtLeast21', () => {
  test('true exactly on the 21st birthday', () => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 21);
    expect(isAtLeast21(d.toISOString().split('T')[0])).toBe(true);
  });

  test('false the day before the 21st birthday', () => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 21);
    d.setDate(d.getDate() + 1);
    expect(isAtLeast21(d.toISOString().split('T')[0])).toBe(false);
  });

  test('false for null, undefined, and garbage', () => {
    expect(isAtLeast21(null)).toBe(false);
    expect(isAtLeast21(undefined)).toBe(false);
    expect(isAtLeast21('not-a-date')).toBe(false);
  });

  test('accepts Date objects (pg DATE columns hydrate as Date)', () => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 30);
    expect(isAtLeast21(d)).toBe(true);
  });
});
