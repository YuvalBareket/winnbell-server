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

import { getNearbyBusinessesService, getAllMapLocationsService, updateBusinessProfile } from '../business.service';
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

  it('filters to active locations of businesses in the Open draw, within the bounding box', async () => {
    setupPoolQueries({ rows: [] });

    await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/loc\.is_active = true/);
    // Participation = draw_entry in the Open campaign. Subscription status is deliberately
    // NOT filtered: billing runs on the 24th while campaigns run to month end, so a
    // business whose subscription ended on the 24th still owns the campaign it paid for.
    expect(sql).not.toMatch(/'Active',\s*'Trialing'/);
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

  it('caps the limit at 30 (hard map-budget rule)', async () => {
    setupPoolQueries({ rows: [] });

    await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1, undefined, 5000);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[params.length - 1]).toBe(30);
  });

  it('caps a NAME search at 30 too (used to widen to 100)', async () => {
    setupPoolQueries({ rows: [] });

    await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1, undefined, 5000, 'pizza');

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[params.length - 1]).toBe(30);
  });

  it('serves a repeated identical viewport from cache without hitting the DB again', async () => {
    setupPoolQueries({ rows: [NEARBY_ROW] });

    const first = await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1);
    const second = await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1);

    expect(first).toEqual(second);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('caches nearby tiles with a 2-minute TTL (longer than the 30s default)', async () => {
    setupPoolQueries({ rows: [NEARBY_ROW] });

    await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1);

    const key = 'business:nearby:2570:2580:-8030:-8010:all:';
    const expiresAt = publicCache.getTtl(key); // epoch ms of expiry
    expect(expiresAt).toBeGreaterThan(0);
    const secondsLeft = ((expiresAt as number) - Date.now()) / 1000;
    // Should be ~120s, well above the 30s default the shared cache uses.
    expect(secondsLeft).toBeGreaterThan(60);
    expect(secondsLeft).toBeLessThanOrEqual(120);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAllMapLocationsService (temporary launch mode: fetch-all, no viewport filter)
// ─────────────────────────────────────────────────────────────────────────────
describe('getAllMapLocationsService', () => {
  it('keeps the eligibility rule but drops the bounding-box FILTER (bbox only orders)', async () => {
    setupPoolQueries({ rows: [] });

    await getAllMapLocationsService(25.7, 25.8, -80.3, -80.1);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Same participation rule as the tiled service.
    expect(sql).toMatch(/loc\.is_active = true/);
    expect(sql).toMatch(/d\.status = 'Open'/);
    expect(sql).toMatch(/de\.paused_at IS NULL/);
    expect(sql).toMatch(/participation_paused = TRUE/);
    // The load-bearing difference: no viewport filter, so off-screen pins still return.
    // (\$ anchors to a real "BETWEEN $1" clause; a comment in the SQL mentions the word.)
    expect(sql).not.toMatch(/BETWEEN \$/);
    // The bbox still drives distance-from-center ordering (list order parity). The float8
    // casts are load-bearing: without a BETWEEN clause typing these params, Postgres
    // rejects "$1 + $2" as "operator is not unique: unknown + unknown".
    expect(sql).toMatch(/ORDER BY/);
    expect(sql).toMatch(/\(\$1::float8 \+ \$2::float8\) \/ 2\.0/);
    expect(sql).toMatch(/\(\$3::float8 \+ \$4::float8\) \/ 2\.0/);
  });

  it('still enforces the hard 30-row map budget', async () => {
    setupPoolQueries({ rows: [] });

    await getAllMapLocationsService(25.7, 25.8, -80.3, -80.1, undefined, 5000);

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[params.length - 1]).toBe(30);
  });

  it('binds sector and name filters (search/chips behave as before)', async () => {
    setupPoolQueries({ rows: [] });

    await getAllMapLocationsService(25.7, 25.8, -80.3, -80.1, 'Food', undefined, 'pizza');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/b\.sector = \$5/);
    expect(params[4]).toBe('Food');
    expect(params[5]).toBe('%pizza%');
  });

  it('serves repeated calls for the same center from cache without a second query', async () => {
    setupPoolQueries({ rows: [] });

    const first = await getAllMapLocationsService(25.7, 25.8, -80.3, -80.1);
    const second = await getAllMapLocationsService(25.7, 25.8, -80.3, -80.1);

    expect(first).toEqual(second);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // Distinct key space from the tiled service so a revert never serves mixed payloads.
    const key = publicCache.keys().find(k => k.startsWith('business:nearby-all:'));
    expect(key).toBeDefined();
  });

  it('never serves a small-limit cache entry to a larger-limit caller (receipt form vs map)', async () => {
    setupPoolQueries({ rows: [] });

    // Same center, different limits: the receipt form asks for 2, the map for 30.
    await getAllMapLocationsService(25.7, 25.8, -80.3, -80.1, undefined, 2);
    await getAllMapLocationsService(25.7, 25.8, -80.3, -80.1, undefined, 30);

    // Without the limit in the cache key the second call would be a (wrong) cache hit.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateBusinessProfile
// ─────────────────────────────────────────────────────────────────────────────
describe('updateBusinessProfile', () => {
  it('should pass website_url as a parameter in the UPDATE query', async () => {
    setupPoolQueries({ rows: [], rowCount: 1 });

    await updateBusinessProfile(42, {
      businessName: 'Joe\'s Coffee',
      businessSector: 'Food',
      description: 'Great food',
      terms_text: 'Standard terms',
      website_url: 'https://example.com',
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain('https://example.com');
    // The public name is forwarded (trimmed) to the UPDATE.
    expect(params).toContain('Joe\'s Coffee');
  });

  it('should trim the business name before the UPDATE', async () => {
    setupPoolQueries({ rows: [], rowCount: 1 });

    await updateBusinessProfile(42, {
      businessName: '  Spaced Cafe  ',
      businessSector: 'Coffee',
      description: 'x',
      terms_text: '',
      website_url: null,
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain('Spaced Cafe');
  });

  it('should accept null website_url without throwing', async () => {
    setupPoolQueries({ rows: [], rowCount: 1 });

    await expect(
      updateBusinessProfile(43, {
        businessName: 'A Shop',
        businessSector: 'Retail',
        description: 'A shop',
        terms_text: 'Standard terms',
        website_url: null,
      }),
    ).resolves.toBeUndefined();

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    const nullCount = params.filter((p) => p === null).length;
    expect(nullCount).toBeGreaterThanOrEqual(1);
  });

  it('should throw an error containing BUSINESS_NOT_FOUND when rowCount is 0', async () => {
    setupPoolQueries({ rows: [], rowCount: 0 });

    await expect(
      updateBusinessProfile(99, {
        businessName: 'No Match Co',
        businessSector: 'Tech',
        description: 'No match',
        terms_text: '',
        website_url: null,
      }),
    ).rejects.toThrow('BUSINESS_NOT_FOUND');
  });
});
