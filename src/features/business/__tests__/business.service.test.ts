/**
 * QA/Security Tests — business.service.ts (PostgreSQL)
 *
 * Covers:
 *   getNearbyBusinessesService — website_url / phone fields returned and present in SQL
 *   updateBusinessProfile      — website_url / phone forwarded to UPDATE, null accepted,
 *                                BUSINESS_NOT_FOUND thrown on rowCount 0
 *
 * Mock pattern: pool.query(sql, params) → { rows, rowCount }
 */

// ── Mock the DB module before any imports ────────────────────────────────────
const mockQuery = jest.fn();

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockQuery }),
}));

import { getNearbyBusinessesService, updateBusinessProfile } from '../business.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Set up sequential pool.query responses. Repeats last entry if exhausted. */
const setupPoolQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// getNearbyBusinessesService
// ─────────────────────────────────────────────────────────────────────────────
describe('getNearbyBusinessesService', () => {
  it('should return website_url and phone from the query result rows', async () => {
    const fakeRow = {
      location_id: 1,
      address: '123 Main St',
      latitude: 51.5,
      longitude: -0.12,
      id: 10,
      name: 'Test Cafe',
      sector: 'Food',
      description: 'A nice cafe',
      terms_text: 'Terms here',
      logo_url: null,
      receipt_example_image_url: null,
      min_transaction_amount: 5,
      website_url: 'https://example.com',
      phone: '555-1234',
      other_locations: [],
      distance_km: 0.5,
    };

    setupPoolQueries({ rows: [fakeRow] });

    const results = await getNearbyBusinessesService(51.5, -0.12, 10);

    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty('website_url', 'https://example.com');
    expect(results[0]).toHaveProperty('phone', '555-1234');
  });

  it('should return the other_locations array from the query result rows', async () => {
    const fakeRow = {
      location_id: 2,
      address: '789 High St',
      latitude: 51.6,
      longitude: -0.13,
      id: 11,
      name: 'Test Bakery',
      sector: 'Food',
      description: 'A nice bakery',
      terms_text: null,
      logo_url: null,
      receipt_example_image_url: null,
      min_transaction_amount: null,
      website_url: null,
      phone: null,
      other_locations: [{ id: 2, name: 'Branch 2', address: '456 Oak St' }],
      distance_km: 1.2,
    };

    setupPoolQueries({ rows: [fakeRow] });

    const results = await getNearbyBusinessesService(51.6, -0.13, 10);

    expect(results[0]).toHaveProperty('other_locations');
    expect(results[0].other_locations).toEqual([
      { id: 2, name: 'Branch 2', address: '456 Oak St' },
    ]);
  });

  it('should include b.website_url and b.phone in the SQL query sent to the database', async () => {
    setupPoolQueries({ rows: [] });

    await getNearbyBusinessesService(51.5, -0.12, 10);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/b\.website_url/);
    expect(sql).toMatch(/b\.phone/);
  });

  it('should include an other_locations subquery in the SQL', async () => {
    setupPoolQueries({ rows: [] });

    await getNearbyBusinessesService(51.5, -0.12, 10);

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/other_locations/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateBusinessProfile
// ─────────────────────────────────────────────────────────────────────────────
describe('updateBusinessProfile', () => {
  it('should pass website_url and phone as parameters in the UPDATE query', async () => {
    setupPoolQueries({ rows: [], rowCount: 1 });

    await updateBusinessProfile(42, {
      businessSector: 'Food',
      description: 'Great food',
      terms_text: 'Standard terms',
      website_url: 'https://example.com',
      phone: '555-0000',
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain('https://example.com');
    expect(params).toContain('555-0000');
  });

  it('should accept null website_url and null phone without throwing', async () => {
    setupPoolQueries({ rows: [], rowCount: 1 });

    await expect(
      updateBusinessProfile(43, {
        businessSector: 'Retail',
        description: 'A shop',
        terms_text: 'Standard terms',
        website_url: null,
        phone: null,
      }),
    ).resolves.toBeUndefined();

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Both null slots must be present in the param list
    const nullCount = params.filter((p) => p === null).length;
    expect(nullCount).toBeGreaterThanOrEqual(2);
  });

  it('should throw an error containing BUSINESS_NOT_FOUND when rowCount is 0', async () => {
    setupPoolQueries({ rows: [], rowCount: 0 });

    await expect(
      updateBusinessProfile(99, {
        businessSector: 'Tech',
        description: 'No match',
        terms_text: '',
        website_url: null,
        phone: null,
      }),
    ).rejects.toThrow('BUSINESS_NOT_FOUND');
  });
});
