/**
 * QA Tests — activity.service.ts (Campaign Dashboard entries feed)
 *
 * Covers:
 *   getCampaignEntriesForScope — quarantined entries surface as "under review" for
 *                                12 hours only; the SQL window keys off quarantined_at
 *                                (created_at fallback) and never hides active entries
 *
 * Mock pattern: pool.query(sql, params) → { rows, rowCount }
 */

// ── Mock the DB module before any imports ────────────────────────────────────
const mockQuery = jest.fn();

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockQuery }),
}));

import { getCampaignEntriesForScope } from '../activity.service';

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

describe('getCampaignEntriesForScope — 12-hour under-review window', () => {
  const ENTRY_ROW = {
    ticket_id: 7,
    location_name: 'Test Cafe',
    receipt_identifier: 'R-123',
    transaction_amount: '25.00',
    entry_source: 'receipt',
    is_quarantined: true,
    created_at: new Date('2026-09-01T10:00:00Z'),
    entry_count: 1,
  };

  const feedSql = (): string => {
    // First query resolves the draw, second is the feed itself.
    const feedCall = mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM ticket t'));
    expect(feedCall).toBeDefined();
    return String(feedCall![0]);
  };

  it('filters quarantined entries older than 12 hours in the SQL itself', async () => {
    setupPoolQueries({ rows: [{ id: 21 }] }, { rows: [ENTRY_ROW] });

    await getCampaignEntriesForScope(1, null);

    const sql = feedSql();
    expect(sql).toContain('t.is_quarantined = FALSE');
    expect(sql).toContain(`COALESCE(t.quarantined_at, t.created_at) >= NOW() - INTERVAL '12 hours'`);
  });

  it('the window is an OR against is_quarantined = FALSE, so active entries are never age-filtered', async () => {
    setupPoolQueries({ rows: [{ id: 21 }] }, { rows: [ENTRY_ROW] });

    await getCampaignEntriesForScope(1, null);

    expect(feedSql()).toMatch(
      /\(t\.is_quarantined = FALSE OR COALESCE\(t\.quarantined_at, t\.created_at\) >= NOW\(\) - INTERVAL '12 hours'\)/,
    );
  });

  it('still maps quarantined rows inside the window to under_review', async () => {
    setupPoolQueries({ rows: [{ id: 21 }] }, { rows: [ENTRY_ROW] });

    const result = await getCampaignEntriesForScope(1, null);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].status).toBe('under_review');
  });
});
