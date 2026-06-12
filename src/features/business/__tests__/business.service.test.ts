/**
 * QA/Security Tests — business.service.ts (PostgreSQL)
 *
 * Covers:
 *   getNearbyBusinessesService — bounding-box query: filters, distance ordering,
 *                                limit capping, and viewport caching
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
import { publicCache } from '../../../shared/cache/cache.js';

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
  // Nearby results are cached in a real node-cache keyed by viewport — flush between tests
  publicCache.flushAll();
});

// ─────────────────────────────────────────────────────────────────────────────
// getNearbyBusinessesService (bounding-box API)
// ─────────────────────────────────────────────────────────────────────────────
describe('getNearbyBusinessesService', () => {
  const NEARBY_ROW = {
    location_id: 1,
    address: '123 Main St',
    latitude: 25.77,
    longitude: -80.19,
    id: 10,
    name: 'Test Cafe',
    sector: 'Food',
    logo_url: null,
  };

  it('returns the location rows from the query result', async () => {
    setupPoolQueries({ rows: [NEARBY_ROW] });

    const results = await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1);

    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty('location_id', 1);
    expect(results[0]).toHaveProperty('name', 'Test Cafe');
  });

  it('filters to active locations of subscribed businesses in an Open draw, within the bounding box', async () => {
    setupPoolQueries({ rows: [] });

    await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/loc\.is_active = true/);
    expect(sql).toMatch(/'Active',\s*'Trialing'/);
    expect(sql).toMatch(/d\.status = 'Open'/);
    expect(sql).toMatch(/BETWEEN \$1 AND \$2/);
    expect(sql).toMatch(/BETWEEN \$3 AND \$4/);
    expect(params.slice(0, 4)).toEqual([25.7, 25.8, -80.3, -80.1]);
  });

  it('orders by distance from the viewport center', async () => {
    setupPoolQueries({ rows: [] });

    await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1);

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY/);
    expect(sql).toMatch(/\(\$1 \+ \$2\) \/ 2\.0/); // lat center
    expect(sql).toMatch(/\(\$3 \+ \$4\) \/ 2\.0/); // lng center
  });

  it('appends the sector filter as a bound parameter when provided', async () => {
    setupPoolQueries({ rows: [] });

    await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1, 'Food');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/b\.sector = \$5/);
    expect(params[4]).toBe('Food');
  });

  it('caps the limit at 100', async () => {
    setupPoolQueries({ rows: [] });

    await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1, undefined, 5000);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[params.length - 1]).toBe(100);
  });

  it('serves a repeated identical viewport from cache without hitting the DB again', async () => {
    setupPoolQueries({ rows: [NEARBY_ROW] });

    const first = await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1);
    const second = await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1);

    expect(first).toEqual(second);
    expect(mockQuery).toHaveBeenCalledTimes(1);
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
