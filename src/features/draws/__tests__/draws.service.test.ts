/**
 * Tests — getDrawHistoryService (draws.service.ts)
 *
 * Verifies:
 *   1. All draw statuses returned (no status filter in SQL)
 *   2. entry_count field present on rows
 *   3. Empty array when no draws exist
 *   4. Winner fields populated when winner data is present
 *   5. The executed SQL does NOT filter by status = 'Closed'
 */

// ── Mock the DB module before importing the service ──────────────────────────

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

import { getDrawHistoryService } from '../draws.service';
import { publicCache } from '../../../shared/cache/cache.js';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const OPEN_DRAW = {
  id: 1,
  name: 'May 2026 Monthly Draw',
  prize_amount: 5000,
  draw_date: '2026-05-31',
  status: 'Open',
  closed_at: null,
  winning_ticket_code: null,
  winner_name: null,
  winner_business_name: null,
  winner_location_name: null,
  entry_count: '12',
};

const CLOSED_DRAW = {
  id: 2,
  name: 'April 2026 Monthly Draw',
  prize_amount: 4000,
  draw_date: '2026-04-30',
  status: 'Closed',
  closed_at: '2026-04-30T20:00:00.000Z',
  winning_ticket_code: 'WIN-ABC123',
  winner_name: 'Jane Doe',
  winner_business_name: 'Coffee Corner',
  winner_location_name: 'Downtown',
  entry_count: '8',
};

const UPCOMING_DRAW = {
  id: 3,
  name: 'June 2026 Monthly Draw',
  prize_amount: 0,
  draw_date: '2026-06-30',
  status: 'Upcoming',
  closed_at: null,
  winning_ticket_code: null,
  winner_name: null,
  winner_business_name: null,
  winner_location_name: null,
  entry_count: '0',
};

beforeEach(() => {
  jest.clearAllMocks();
  // The service caches 'draws:history' in a real node-cache for 300s —
  // flush so each test's mocked rows actually take effect
  publicCache.flushAll();
});

// ─────────────────────────────────────────────
// getDrawHistoryService
// ─────────────────────────────────────────────

describe('getDrawHistoryService', () => {
  it('should return draws of all statuses — Open, Closed, and Upcoming', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CLOSED_DRAW, OPEN_DRAW, UPCOMING_DRAW] });

    const result = await getDrawHistoryService();

    const statuses = result.map((r: any) => r.status);
    expect(statuses).toContain('Open');
    expect(statuses).toContain('Closed');
    expect(statuses).toContain('Upcoming');
  });

  it('should return entry_count on every row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [OPEN_DRAW, CLOSED_DRAW] });

    const result = await getDrawHistoryService();

    expect(result.length).toBeGreaterThan(0);
    for (const row of result) {
      expect(row).toHaveProperty('entry_count');
    }
  });

  it('should return an empty array when no draws exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getDrawHistoryService();

    expect(result).toEqual([]);
  });

  it('should return winner fields populated when a winner exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CLOSED_DRAW] });

    const result = await getDrawHistoryService();
    const draw = result[0];

    expect(draw.winning_ticket_code).toBe('WIN-ABC123');
    expect(draw.winner_name).toBe('Jane Doe');
    expect(draw.winner_business_name).toBe('Coffee Corner');
    expect(draw.winner_location_name).toBe('Downtown');
  });

  it('should return winner fields as null when no winner is set', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [OPEN_DRAW] });

    const result = await getDrawHistoryService();
    const draw = result[0];

    expect(draw.winning_ticket_code).toBeNull();
    expect(draw.winner_name).toBeNull();
    expect(draw.winner_business_name).toBeNull();
    expect(draw.winner_location_name).toBeNull();
  });

  it('returns Open + Closed draws plus ONLY the next upcoming one (deck contract)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getDrawHistoryService();

    // pool.query is called with a single SQL string (no params for this query)
    const [sqlArg] = mockQuery.mock.calls[0];
    expect(typeof sqlArg).toBe('string');
    // Live + past campaigns are always included...
    expect(sqlArg).toMatch(/d\.status IN \('Open', 'Closed'\)/);
    // ...and exactly one Upcoming draw (the soonest) rides along for the hub deck's
    // left neighbour - far-future pre-created campaigns must never leave the server.
    expect(sqlArg).toMatch(/OR d\.id = \(SELECT id FROM draw WHERE status = 'Upcoming' ORDER BY draw_date ASC LIMIT 1\)/);
  });

  it('should call pool.query exactly once per invocation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [OPEN_DRAW] });

    await getDrawHistoryService();

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('should propagate a database error to the caller', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB timeout'));

    await expect(getDrawHistoryService()).rejects.toThrow('DB timeout');
  });
});
