/**
 * Tests — createFullBusinessProfile one-business-per-user guard (F5).
 *
 * A user IS a business (1:1). The service must refuse to create a SECOND business for a user
 * (a double-submit / retry / direct API call) instead of silently duplicating - which made
 * login's business/subscription lookup non-deterministic. UNIQUE(business.user_id) is the
 * race-safe backstop; this guard gives a clean BUSINESS_ALREADY_EXISTS the controller maps to 409.
 */

const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockClient = { query: mockClientQuery, release: mockRelease };

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ connect: jest.fn().mockResolvedValue(mockClient) }),
}));

jest.mock('../../../shared/cache/cache.js', () => ({
  invalidatePublicBusinessData: jest.fn(),
}));

import { createFullBusinessProfile } from '../business.service';

const INPUT = {
  businessName: 'Test Cafe',
  businessSector: 'Food',
  description: 'desc',
  locations: [{ name: 'Main', address: '1 St', lat: 25.7, lon: -80.1 }],
} as unknown as Parameters<typeof createFullBusinessProfile>[1];

const sqlCalls = () => mockClientQuery.mock.calls.map((c) => String(c[0]).trim().split('\n')[0]);

beforeEach(() => {
  mockClientQuery.mockReset();
  mockRelease.mockReset();
});

describe('createFullBusinessProfile — one-business-per-user guard', () => {
  test('rejects a second business with BUSINESS_ALREADY_EXISTS (no INSERT, rolls back)', async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (/SELECT id FROM business WHERE user_id/i.test(sql)) return Promise.resolve({ rows: [{ id: 42 }] });
      return Promise.resolve({ rows: [] });
    });

    await expect(createFullBusinessProfile(713, INPUT)).rejects.toThrow('BUSINESS_ALREADY_EXISTS');

    expect(sqlCalls().some((s) => /^INSERT INTO business\b/i.test(s))).toBe(false); // never inserted
    expect(sqlCalls().some((s) => /^ROLLBACK/i.test(s))).toBe(true);
    expect(sqlCalls().some((s) => /^COMMIT/i.test(s))).toBe(false);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test('happy path: first business is created and committed', async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (/SELECT id FROM business WHERE user_id/i.test(sql)) return Promise.resolve({ rows: [] }); // none yet
      if (/INSERT INTO business\b/i.test(sql)) return Promise.resolve({ rows: [{ id: 99 }] });
      return Promise.resolve({ rows: [] });
    });

    const result = await createFullBusinessProfile(713, INPUT);

    expect(result).toEqual({ businessId: 99 });
    expect(sqlCalls().some((s) => /^INSERT INTO business\b/i.test(s))).toBe(true);
    expect(sqlCalls().some((s) => /^INSERT INTO business_location/i.test(s))).toBe(true);
    expect(sqlCalls().some((s) => /^COMMIT/i.test(s))).toBe(true);
    expect(sqlCalls().some((s) => /^ROLLBACK/i.test(s))).toBe(false);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
