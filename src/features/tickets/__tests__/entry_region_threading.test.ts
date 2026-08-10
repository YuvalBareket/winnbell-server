/**
 * Tests — entry-region threading into the FREE and PROMO entry paths.
 *
 * The requireEntryRegion middleware records the IP-derived state on res.locals; the
 * controllers thread it into activateFreeTicket / activatePromotionalEntry. These tests
 * pin that the services:
 *   - write submitter_state onto the ticket INSERT (audit trail parity with receipts)
 *   - apply the +2 out_of_region_entry risk signal and sync quarantine when out-of-region
 *   - do neither when no region was detected (middleware failed open)
 */

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockClient = { query: mockClientQuery, release: mockRelease };

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({
    query: mockPoolQuery,
    connect: jest.fn().mockResolvedValue(mockClient),
  }),
}));

const mockUpdateUserRiskScore = jest.fn();
const mockSyncUserQuarantineState = jest.fn();
jest.mock('../../risk/risk.service.js', () => ({
  evaluateUserRisk: jest.fn(),
  updateUserRiskScore: (...args: unknown[]) => mockUpdateUserRiskScore(...args),
  checkDuplicateReceiptIdentifier: jest.fn(),
  countsAgainstCap: jest.fn(),
  syncUserQuarantineState: (...args: unknown[]) => mockSyncUserQuarantineState(...args),
}));

import { activateFreeTicket, activatePromotionalEntry } from '../tickets.service';

/** Content-keyed client.query mock — resilient to query insertions, unlike positional mocks. */
const setupFreeTicketQueries = () => {
  mockClientQuery.mockImplementation((sql: string) => {
    if (sql.includes('used_this_week')) {
      return Promise.resolve({ rows: [{ activated_at: null, is_email_verified: true, is_phone_verified: true, used_this_week: false }] });
    }
    if (sql.includes(`FROM draw WHERE status = 'Open'`)) return Promise.resolve({ rows: [{ id: 7, name: 'August Draw' }] });
    if (sql.includes('AS total_count FROM ticket')) return Promise.resolve({ rows: [{ total_count: 0 }] });
    if (sql.includes('COUNT(*) as count FROM ticket WHERE code')) return Promise.resolve({ rows: [{ count: '0' }] });
    if (sql.includes('INSERT INTO ticket')) return Promise.resolve({ rows: [{ id: 123 }] });
    return Promise.resolve({ rows: [] });
  });
};

const setupPromoQueries = () => {
  mockClientQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM promotional_code')) return Promise.resolve({ rows: [{ id: 1, max_uses: null, use_count: 0 }] });
    if (sql.includes(`FROM draw WHERE status = 'Open'`)) return Promise.resolve({ rows: [{ id: 9, name: 'August Draw' }] });
    if (sql.includes('FROM promotional_entry WHERE user_id')) return Promise.resolve({ rows: [{ count: 0 }] });
    if (sql.includes('AS total_count FROM ticket')) return Promise.resolve({ rows: [{ total_count: 0 }] });
    if (sql.includes('COUNT(*) as count FROM ticket WHERE code')) return Promise.resolve({ rows: [{ count: '0' }] });
    if (sql.includes('INSERT INTO promotional_entry')) return Promise.resolve({ rows: [{ id: 55 }] });
    if (sql.includes('INSERT INTO ticket')) return Promise.resolve({ rows: [{ id: 321 }] });
    return Promise.resolve({ rows: [] });
  });
};

const ticketInsertCall = () =>
  mockClientQuery.mock.calls.find(([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO ticket'));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('activateFreeTicket — region threading', () => {
  it('records submitter_state and applies the out-of-region risk signal', async () => {
    setupFreeTicketQueries();

    const res = await activateFreeTicket(1, '198.51.100.7', { state: 'GA', outOfRegion: true });
    expect(res.success).toBe(true);

    const insert = ticketInsertCall();
    expect(insert![1]).toContain('GA'); // submitter_state param present on the free ticket row

    expect(mockUpdateUserRiskScore).toHaveBeenCalledWith(1, 2, mockClient, ['out_of_region_entry']);
    expect(mockSyncUserQuarantineState).toHaveBeenCalledWith(1, 7, mockClient);
  });

  it('writes NULL state and no risk calls when no region was detected (fail open)', async () => {
    setupFreeTicketQueries();

    const res = await activateFreeTicket(1, '198.51.100.7');
    expect(res.success).toBe(true);

    const insert = ticketInsertCall();
    expect(insert![1]).toContain(null);
    expect(mockUpdateUserRiskScore).not.toHaveBeenCalled();
    expect(mockSyncUserQuarantineState).not.toHaveBeenCalled();
  });

  it('in-region state is recorded but adds no risk', async () => {
    setupFreeTicketQueries();

    await activateFreeTicket(1, '198.51.100.7', { state: 'FL', outOfRegion: false });

    const insert = ticketInsertCall();
    expect(insert![1]).toContain('FL');
    expect(mockUpdateUserRiskScore).not.toHaveBeenCalled();
  });
});

describe('activatePromotionalEntry — region threading', () => {
  it('records submitter_state and applies the out-of-region risk signal', async () => {
    setupPromoQueries();

    const res = await activatePromotionalEntry(2, 'SUMMER25', { state: 'GA', outOfRegion: true });
    expect(res.ticketId).toBe(321);

    const insert = ticketInsertCall();
    expect(insert![1]).toContain('GA');

    expect(mockUpdateUserRiskScore).toHaveBeenCalledWith(2, 2, mockClient, ['out_of_region_entry']);
    expect(mockSyncUserQuarantineState).toHaveBeenCalledWith(2, 9, mockClient);
  });

  it('writes NULL state and no risk calls when no region was detected', async () => {
    setupPromoQueries();

    await activatePromotionalEntry(2, 'SUMMER25');

    const insert = ticketInsertCall();
    expect(insert![1]).toContain(null);
    expect(mockUpdateUserRiskScore).not.toHaveBeenCalled();
  });
});
