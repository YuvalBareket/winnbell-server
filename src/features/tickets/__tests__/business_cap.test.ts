/**
 * QA Tests — getBusinessTicketsService (tickets.service.ts)
 *
 * Covers:
 *   cap calculation:
 *     - no locationId  → cap = perLocationCap × activeLocationCount
 *     - with locationId → cap = perLocationCap (per-location only)
 *     - perLocationCap = null → cap = null, no multiplication
 *     - 0 active locations → cap = 0 (not a division, just 0×perLocationCap)
 *   totalCount:
 *     - no locationId  → aggregate across all locations (excludes quarantined)
 *     - with locationId → scoped to that location (excludes quarantined)
 *   quarantine exclusion verified via SQL WHERE clause
 *
 * Mock pattern: pool.query(sql, params) → { rows, rowCount }
 */

// ── Mock DB before any imports ────────────────────────────────────────────────
const mockQuery = jest.fn();

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockQuery }),
}));

import { getBusinessTicketsService } from '../tickets.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Set up sequential pool.query responses.
 * getBusinessTicketsService fires three queries in order:
 *   1. bizRes  — returns { business_id, per_location_cap, active_location_count }
 *   2. countRes — returns { total_count }
 *   3. ticketRows — returns the ticket list
 */
const setupPoolQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

/** Build a standard biz row. */
const bizRow = (
  perLocationCap: number | null,
  activeLocationCount: number,
  businessId = 7,
) => ({
  business_id: businessId,
  per_location_cap: perLocationCap,
  active_location_count: activeLocationCount,
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. cap calculation — all locations (no locationId filter)
// ─────────────────────────────────────────────────────────────────────────────
describe('getBusinessTicketsService — cap calculation (all locations)', () => {
  it('should set cap = perLocationCap × activeLocationCount when no locationId given', async () => {
    setupPoolQueries(
      { rows: [bizRow(1000, 4)] },    // bizRes
      { rows: [{ total_count: 250 }] }, // countRes
      { rows: [] },                    // ticket rows
    );

    const result = await getBusinessTicketsService(1, 10);

    expect(result.perLocationCap).toBe(1000);
    expect(result.activeLocationCount).toBe(4);
    expect(result.cap).toBe(4000); // 1000 × 4
  });

  it('should set cap = perLocationCap × 1 when only one active location', async () => {
    setupPoolQueries(
      { rows: [bizRow(500, 1)] },
      { rows: [{ total_count: 50 }] },
      { rows: [] },
    );

    const result = await getBusinessTicketsService(1, 10);

    expect(result.cap).toBe(500); // 500 × 1
  });

  it('should set cap = 0 when activeLocationCount is 0 (not a divide-by-zero error)', async () => {
    setupPoolQueries(
      { rows: [bizRow(1000, 0)] },
      { rows: [{ total_count: 0 }] },
      { rows: [] },
    );

    // Must not throw — 1000 × 0 = 0 is valid arithmetic
    const result = await getBusinessTicketsService(1, 10);

    expect(result.cap).toBe(0); // 1000 × 0
    expect(result.activeLocationCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. cap calculation — single location filter
// ─────────────────────────────────────────────────────────────────────────────
describe('getBusinessTicketsService — cap calculation (location filter)', () => {
  it('should set cap = perLocationCap (only) when locationId is provided', async () => {
    setupPoolQueries(
      { rows: [bizRow(1000, 4)] },
      { rows: [{ total_count: 80 }] },
      { rows: [] },
    );

    const result = await getBusinessTicketsService(1, 10, 3); // locationId = 3

    expect(result.perLocationCap).toBe(1000);
    expect(result.cap).toBe(1000); // NOT 1000 × 4
  });

  it('should not multiply perLocationCap by activeLocationCount when locationId is set', async () => {
    setupPoolQueries(
      { rows: [bizRow(500, 6)] },
      { rows: [{ total_count: 200 }] },
      { rows: [] },
    );

    const result = await getBusinessTicketsService(1, 10, 2); // locationId = 2

    // cap must equal perLocationCap, NOT perLocationCap × activeLocationCount (3000)
    expect(result.cap).toBe(500);
    expect(result.cap).not.toBe(3000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. cap = null when perLocationCap is null
// ─────────────────────────────────────────────────────────────────────────────
describe('getBusinessTicketsService — null perLocationCap', () => {
  it('should set cap = null when perLocationCap is null (no location filter)', async () => {
    setupPoolQueries(
      { rows: [bizRow(null, 4)] },
      { rows: [{ total_count: 0 }] },
      { rows: [] },
    );

    const result = await getBusinessTicketsService(1, 10);

    expect(result.perLocationCap).toBeNull();
    expect(result.cap).toBeNull();
  });

  it('should set cap = null when perLocationCap is null (with location filter)', async () => {
    setupPoolQueries(
      { rows: [bizRow(null, 3)] },
      { rows: [{ total_count: 0 }] },
      { rows: [] },
    );

    const result = await getBusinessTicketsService(1, 10, 5);

    expect(result.cap).toBeNull();
  });

  it('should never perform multiplication when perLocationCap is null', async () => {
    // If the code accidentally does null * 4 it produces NaN, not null
    setupPoolQueries(
      { rows: [bizRow(null, 4)] },
      { rows: [{ total_count: 0 }] },
      { rows: [] },
    );

    const result = await getBusinessTicketsService(1, 10);

    expect(result.cap).not.toBeNaN();
    expect(result.cap).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. totalCount — all locations (no filter) excludes quarantined
// ─────────────────────────────────────────────────────────────────────────────
describe('getBusinessTicketsService — totalCount (no location filter)', () => {
  it('should return totalCount from the COUNT query (all locations)', async () => {
    setupPoolQueries(
      { rows: [bizRow(1000, 2)] },
      { rows: [{ total_count: 320 }] }, // 320 non-quarantined across all locations
      { rows: [] },
    );

    const result = await getBusinessTicketsService(1, 10);

    expect(result.totalCount).toBe(320);
  });

  it('should include is_quarantined = FALSE in the COUNT SQL when no locationId', async () => {
    setupPoolQueries(
      { rows: [bizRow(1000, 2)] },
      { rows: [{ total_count: 0 }] },
      { rows: [] },
    );

    await getBusinessTicketsService(1, 10);

    // Find the COUNT query (second call, index 1)
    const countSql = mockQuery.mock.calls[1]?.[0] as string;
    expect(countSql).toBeDefined();
    expect(countSql).toMatch(/is_quarantined\s*=\s*FALSE/i);
  });

  it('should NOT include a location_id clause in COUNT SQL when no locationId', async () => {
    setupPoolQueries(
      { rows: [bizRow(1000, 2)] },
      { rows: [{ total_count: 0 }] },
      { rows: [] },
    );

    await getBusinessTicketsService(1, 10);

    const countSql = mockQuery.mock.calls[1]?.[0] as string;
    // Without a locationId the query must not filter by location
    expect(countSql).not.toMatch(/location_id\s*=\s*\$3/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. totalCount — with location filter, scoped and quarantine-excluded
// ─────────────────────────────────────────────────────────────────────────────
describe('getBusinessTicketsService — totalCount (with location filter)', () => {
  it('should return totalCount scoped to the given location', async () => {
    setupPoolQueries(
      { rows: [bizRow(1000, 4)] },
      { rows: [{ total_count: 75 }] }, // only 75 at this specific location
      { rows: [] },
    );

    const result = await getBusinessTicketsService(1, 10, 3);

    expect(result.totalCount).toBe(75);
  });

  it('should include a location_id = $3 clause in the COUNT SQL when locationId is provided', async () => {
    setupPoolQueries(
      { rows: [bizRow(1000, 4)] },
      { rows: [{ total_count: 75 }] },
      { rows: [] },
    );

    await getBusinessTicketsService(1, 10, 3);

    const countSql = mockQuery.mock.calls[1]?.[0] as string;
    const countParams = mockQuery.mock.calls[1]?.[1] as unknown[];
    expect(countSql).toMatch(/location_id\s*=\s*\$3/);
    expect(countParams[2]).toBe(3); // third param is the locationId
  });

  it('should still include is_quarantined = FALSE in COUNT SQL with location filter', async () => {
    setupPoolQueries(
      { rows: [bizRow(1000, 4)] },
      { rows: [{ total_count: 0 }] },
      { rows: [] },
    );

    await getBusinessTicketsService(1, 10, 3);

    const countSql = mockQuery.mock.calls[1]?.[0] as string;
    expect(countSql).toMatch(/is_quarantined\s*=\s*FALSE/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Return shape
// ─────────────────────────────────────────────────────────────────────────────
describe('getBusinessTicketsService — return shape', () => {
  it('should return tickets, totalCount, cap, perLocationCap, activeLocationCount', async () => {
    const fakeTicket = { id: 1, code: 'ABCD1234', status: 'Activated', is_quarantined: false };
    setupPoolQueries(
      { rows: [bizRow(2000, 3)] },
      { rows: [{ total_count: 5 }] },
      { rows: [fakeTicket] },
    );

    const result = await getBusinessTicketsService(1, 10);

    expect(result).toHaveProperty('tickets');
    expect(result).toHaveProperty('totalCount');
    expect(result).toHaveProperty('cap');
    expect(result).toHaveProperty('perLocationCap');
    expect(result).toHaveProperty('activeLocationCount');
    expect(result.tickets).toEqual([fakeTicket]);
  });

  it('should throw "Business not found" when bizRes returns no rows', async () => {
    setupPoolQueries({ rows: [] }); // no business row

    await expect(getBusinessTicketsService(999, 10)).rejects.toThrow('Business not found');
  });
});
