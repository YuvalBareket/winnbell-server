/**
 * Tests — draw_entry pause/reinstate feature
 *
 * Covers:
 *   pauseBusinessInDrawService — pause sets paused_at + actor; reinstate clears;
 *                                404 on unknown enrollment; 400 on closed draw
 *   getDrawBusinessesService   — is_paused included in SELECT
 *   getNearbyBusinessesService — gate SQL includes paused_at IS NULL
 *   searchParticipatingLocationsService — gate SQL includes paused_at IS NULL
 *   submitReceiptEntryService (biz CTE) — gate SQL includes paused_at IS NULL
 *   pickDrawWinnerService      — winner SELECT does NOT contain paused_at
 *   cap check (tickets.service) — cap SELECT does NOT contain paused_at
 *
 * Mock pattern: pool.query(sql, params) -> { rows, rowCount }
 *               pool.connect() -> client with query / release
 */

// ── mock the DB module before any imports ────────────────────────────────────
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

// transitive stubs required by admin.service
jest.mock('../../tickets/tickets.service.js', () => ({
  generateGlobalUniqueCode: jest.fn().mockResolvedValue('TESTCODE'),
}));
jest.mock('../../risk/risk.service.js', () => ({
  decayAllUserRiskScores: jest.fn().mockResolvedValue({ unquarantinedUserIds: [] }),
  updateUserRiskScore: jest.fn().mockResolvedValue(undefined),
  syncUserQuarantineState: jest.fn().mockResolvedValue(undefined),
  evaluateUserRisk: jest.fn().mockResolvedValue({ delta: 0, totalScore: 0, level: 'low', flags: [] }),
  checkDuplicateReceiptIdentifier: jest.fn().mockResolvedValue({ isDuplicate: false }),
  countsAgainstCap: jest.fn().mockReturnValue(true),
}));
jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
  sendFoundingFinalCampaignEmail: jest.fn(),
}));
jest.mock('../../ocr/ocr.service.js', () => ({
  validateReceiptAsync: jest.fn(),
}));

import { pauseBusinessInDrawService, getDrawBusinessesService } from '../admin.service';
import { getNearbyBusinessesService, searchParticipatingLocationsService } from '../../business/business.service';
import { publicCache } from '../../../shared/cache/cache.js';

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
  publicCache.flushAll();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ─────────────────────────────────────────────
// pauseBusinessInDrawService — pause
// ─────────────────────────────────────────────
describe('pauseBusinessInDrawService — pause', () => {
  test('pause: issues UPDATE with paused_at = NOW() and actor, returns { paused: true }', async () => {
    setupPoolQueries(
      { rows: [{ id: 5, status: 'Open' }] },  // enrollment exists check
      { rows: [], rowCount: 1 },               // UPDATE (atomically re-guarded on draw status)
      { rows: [{ paused: true }] },            // resulting-state SELECT
    );

    const result = await pauseBusinessInDrawService(1, 42, true, 99);

    expect(result).toEqual({ paused: true });

    const updateCall = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE draw_entry') && sql.includes('paused_at = NOW()'),
    );
    expect(updateCall).toBeDefined();
    // actor ID passed as parameter
    expect(updateCall![1]).toContain(99);
    // idempotency guard: only updates rows where paused_at IS NULL
    expect(updateCall![0]).toMatch(/paused_at IS NULL/);
  });

  test('pause on already-paused row is a no-op success (idempotent)', async () => {
    setupPoolQueries(
      { rows: [{ id: 5, status: 'Open' }] },
      { rows: [], rowCount: 0 },     // UPDATE matched 0 rows (already paused) — no error
      { rows: [{ paused: true }] },  // resulting-state SELECT still reports paused
    );

    await expect(pauseBusinessInDrawService(1, 42, true, 99)).resolves.toEqual({ paused: true });
  });
});

// ─────────────────────────────────────────────
// pauseBusinessInDrawService — reinstate
// ─────────────────────────────────────────────
describe('pauseBusinessInDrawService — reinstate', () => {
  test('reinstate: issues UPDATE clearing paused_at and paused_by_user_id, returns { paused: false }', async () => {
    setupPoolQueries(
      { rows: [{ id: 5, status: 'Open' }] },
      { rows: [], rowCount: 1 },
      { rows: [{ paused: false }] },  // resulting-state SELECT
    );

    const result = await pauseBusinessInDrawService(1, 42, false, 99);

    expect(result).toEqual({ paused: false });

    const updateCall = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE draw_entry') && sql.includes('paused_at = NULL'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toMatch(/paused_by_user_id = NULL/);
    // drawId and businessId are the only params (actor is not stored on reinstate)
    expect(updateCall![1]).toEqual([1, 42]);
  });
});

// ─────────────────────────────────────────────
// pauseBusinessInDrawService — 404 unknown enrollment
// ─────────────────────────────────────────────
describe('pauseBusinessInDrawService — 404 on unknown enrollment', () => {
  test('throws 404-tagged error when the draw_entry row does not exist', async () => {
    setupPoolQueries({ rows: [] });  // enrollment check returns nothing

    const err = await pauseBusinessInDrawService(1, 999, true, 99).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { statusCode?: number }).statusCode).toBe(404);
    // No UPDATE should have been issued
    const updated = mockQuery.mock.calls.some(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE draw_entry'),
    );
    expect(updated).toBe(false);
  });
});

// ─────────────────────────────────────────────
// pauseBusinessInDrawService — 400 on closed draw
// ─────────────────────────────────────────────
describe('pauseBusinessInDrawService — 400 on closed draw', () => {
  test('throws 400-tagged error when the draw is Closed', async () => {
    setupPoolQueries({ rows: [{ id: 5, status: 'Closed' }] });

    const err = await pauseBusinessInDrawService(1, 42, true, 99).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/closed campaign/i);
    expect((err as { statusCode?: number }).statusCode).toBe(400);
  });

  test('allows pause on an Open draw', async () => {
    setupPoolQueries(
      { rows: [{ id: 5, status: 'Open' }] },
      { rows: [], rowCount: 1 },
    );
    await expect(pauseBusinessInDrawService(1, 42, true, 99)).resolves.toBeDefined();
  });

  test('allows pause on an Upcoming draw', async () => {
    setupPoolQueries(
      { rows: [{ id: 5, status: 'Upcoming' }] },
      { rows: [], rowCount: 1 },
    );
    await expect(pauseBusinessInDrawService(1, 42, true, 99)).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────
// getDrawBusinessesService — is_paused in SELECT
// ─────────────────────────────────────────────
describe('getDrawBusinessesService — is_paused field', () => {
  test('SELECT includes (de.paused_at IS NOT NULL) AS is_paused', async () => {
    setupPoolQueries(
      { rows: [] },
      { rows: [{ total: 0 }] },
    );

    await getDrawBusinessesService(1);

    const selectCall = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('FROM draw_entry de'),
    );
    expect(selectCall).toBeDefined();
    expect(selectCall![0]).toMatch(/paused_at IS NOT NULL.*AS is_paused/s);
  });
});

// ─────────────────────────────────────────────
// Gate: getNearbyBusinessesService — paused_at IS NULL in EXISTS
// ─────────────────────────────────────────────
describe('getNearbyBusinessesService — paused_at IS NULL gate', () => {
  test('the participating EXISTS subquery requires de.paused_at IS NULL', async () => {
    setupPoolQueries({ rows: [] });

    await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1);

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/d\.status = 'Open'/);
    expect(sql).toMatch(/de\.paused_at IS NULL/);
  });
});

// ─────────────────────────────────────────────
// Gate: searchParticipatingLocationsService — paused_at IS NULL in EXISTS
// ─────────────────────────────────────────────
describe('searchParticipatingLocationsService — paused_at IS NULL gate', () => {
  test('the participating EXISTS subquery requires de.paused_at IS NULL', async () => {
    setupPoolQueries({ rows: [] });

    await searchParticipatingLocationsService('coffee');

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/d\.status = 'Open'/);
    expect(sql).toMatch(/de\.paused_at IS NULL/);
  });
});

// ─────────────────────────────────────────────
// Gate: submitReceiptEntryService biz CTE — paused_at IS NULL
// (tested via SQL inspection on the preflight client query)
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// SQL source contracts — the entry gate, winner pick, and cap check
// ─────────────────────────────────────────────
// These three assertions are STATIC contracts on the SQL text itself. Executing the full
// services here is impractical (tickets.service is partially jest.mocked above for the
// admin.service transitive imports, and the winner pick needs a deep transaction script),
// so we assert directly on the source files - deterministic and immune to mock drift.
import * as fs from 'fs';
import * as path from 'path';

const readSrc = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

describe('SQL source contracts — paused_at placement', () => {
  test('submitReceiptEntryService biz CTE requires de.paused_at IS NULL', () => {
    const src = readSrc('features/tickets/tickets.service.ts');
    // The preflight `biz AS (` CTE block must gate on Open draw AND unpaused enrollment.
    const bizCteStart = src.indexOf('biz AS (');
    expect(bizCteStart).toBeGreaterThan(-1);
    const bizCte = src.slice(bizCteStart, bizCteStart + 1200);
    expect(bizCte).toMatch(/d\.status = 'Open'/);
    expect(bizCte).toMatch(/de\.paused_at IS NULL/);
  });

  test('winner order generation (ORDER BY random()) does NOT reference paused_at', () => {
    const src = readSrc('features/admin/admin.service.ts');
    const randomIdx = src.indexOf('ORDER BY random()');
    expect(randomIdx).toBeGreaterThan(-1);
    // The order-generation INSERT..SELECT is the ~2000 chars preceding the ORDER BY.
    const orderGen = src.slice(Math.max(0, randomIdx - 2000), randomIdx + 40);
    expect(orderGen).not.toMatch(/paused_at/);
  });

  test('winner pick SELECT (ORDER BY dwo.position) does NOT reference paused_at', () => {
    const src = readSrc('features/admin/admin.service.ts');
    const pickIdx = src.indexOf('ORDER BY dwo.position');
    expect(pickIdx).toBeGreaterThan(-1);
    // The winner-selection statement is the ~2000 chars preceding the ORDER BY.
    const winnerSelect = src.slice(Math.max(0, pickIdx - 2000), pickIdx + 40);
    expect(winnerSelect).not.toMatch(/paused_at/);
  });

  test('is_participating: PUBLIC profile gates on pause; OWNER my-business view does NOT (silent pause)', () => {
    const src = readSrc('features/business/business.service.ts');
    // First occurrence = getMyBusinessData (owner's own dashboard): silent pause by design -
    // it must NOT gate on paused_at, or the owner would see themselves as not participating.
    const ownerIdx = src.indexOf('AS is_participating');
    // Last occurrence = fetchLocationProfile (public): must carry the pause gate.
    const publicIdx = src.lastIndexOf('AS is_participating');
    expect(ownerIdx).toBeGreaterThan(-1);
    expect(publicIdx).toBeGreaterThan(ownerIdx);
    const ownerExpr = src.slice(Math.max(0, ownerIdx - 600), ownerIdx);
    const publicExpr = src.slice(Math.max(0, publicIdx - 600), publicIdx);
    expect(ownerExpr).not.toMatch(/paused_at/);
    expect(publicExpr).toMatch(/d\.status = 'Open'/);
    expect(publicExpr).toMatch(/de\.paused_at IS NULL/);
  });

  test('pause/reinstate UPDATEs atomically re-check the draw is not Closed', () => {
    const src = readSrc('features/admin/admin.service.ts');
    const fnStart = src.indexOf('export const pauseBusinessInDrawService');
    expect(fnStart).toBeGreaterThan(-1);
    const fn = src.slice(fnStart, fnStart + 2500);
    // Both guarded UPDATEs join draw and exclude Closed - the TOCTOU-safe form.
    const guarded = fn.match(/UPDATE draw_entry de[\s\S]*?FROM draw d[\s\S]*?status != 'Closed'/g) ?? [];
    expect(guarded.length).toBe(2);
  });

  test('cap COUNT queries do NOT reference paused_at', () => {
    const src = readSrc('features/tickets/tickets.service.ts');
    // Every COUNT(*) ... location_id cap-style query must key off tickets only.
    const capBlocks = src.split('COUNT(*)').slice(1).map((chunk) => chunk.slice(0, 400));
    const capish = capBlocks.filter((c) => c.includes('location_id') && c.includes('draw_id'));
    expect(capish.length).toBeGreaterThan(0);
    for (const block of capish) {
      expect(block).not.toMatch(/paused_at/);
    }
  });
});
