/**
 * Tests - admin business review status (updateBusinessReviewStatusService)
 *
 * Covers:
 *   - happy path: approve/block updates correct columns, returns void
 *   - invalid status rejected with 400
 *   - 404 when business does not exist
 *   - cache invalidation called on success
 *   - push notification fired ONLY when transitioning INTO 'approved'
 *   - SQL-shape: getNearbyBusinessesService / getAllMapLocationsService queries contain
 *     review_status = 'approved'
 *   - SQL-shape: submitReceiptEntryService biz CTE contains review_status = 'approved'
 *   - SQL-shape: joinCurrentCampaignService blocked -> BUSINESS_NOT_APPROVED error
 *   - ENROLLMENT_ELIGIBLE_SQL contains the blocked guard (shared constant)
 *
 * Mock pattern: pool.query(sql, params) -> { rows, rowCount }
 */

// ── DB mock (must be before any imports) ─────────────────────────────────────
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

// ── Cache mock ────────────────────────────────────────────────────────────────
const mockInvalidatePublicBusinessData = jest.fn();
jest.mock('../../../shared/cache/cache.js', () => ({
  getPlatformSettings: jest.fn().mockResolvedValue({ global_entry_cap: 30 }),
  invalidatePlatformSettings: jest.fn(),
  invalidatePublicBusinessData: mockInvalidatePublicBusinessData,
  invalidateUserAuth: jest.fn(),
  publicCache: { get: jest.fn().mockReturnValue(undefined), set: jest.fn(), flushAll: jest.fn(), keys: jest.fn().mockReturnValue([]), getTtl: jest.fn() },
}));

// ── Notifications mock ────────────────────────────────────────────────────────
const mockSendToUser = jest.fn().mockResolvedValue(undefined);
jest.mock('../../notifications/notifications.service.js', () => ({
  sendToUser: (...args: unknown[]) => mockSendToUser(...args),
  sendToAudience: jest.fn().mockResolvedValue(0),
  logNotification: jest.fn().mockResolvedValue(undefined),
  getNotificationHistory: jest.fn().mockResolvedValue([]),
}));

// ── Transitive stubs ──────────────────────────────────────────────────────────
jest.mock('../../tickets/tickets.service.js', () => ({
  generateGlobalUniqueCode: jest.fn().mockResolvedValue('TESTCODE'),
}));
jest.mock('../../risk/risk.service.js', () => ({
  decayAllUserRiskScores: jest.fn().mockResolvedValue({ unquarantinedUserIds: [] }),
  updateUserRiskScore: jest.fn().mockResolvedValue(undefined),
  syncUserQuarantineState: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
  sendFoundingFinalCampaignEmail: jest.fn(),
}));
jest.mock('../growth.service.js', () => ({
  getGrowthAnalyticsService: jest.fn().mockResolvedValue({}),
}));

import { updateBusinessReviewStatusService, ENROLLMENT_ELIGIBLE_SQL_FOR_TEST } from '../admin.service';
import {
  getNearbyBusinessesService,
  getAllMapLocationsService,
  joinCurrentCampaignService,
  searchParticipatingLocationsService,
  getLocationProfileByIdService,
  getParticipatingLocationByIdService,
} from '../../business/business.service';
import { publicCache } from '../../../shared/cache/cache.js';

// tickets.service is stubbed above (transitive dep of admin.service); pull the real module
// for the receipt-entry SQL-shape test. Its own deps (db, cache) stay mocked.
const actualTickets = jest.requireActual('../../tickets/tickets.service') as typeof import('../../tickets/tickets.service');

// Helper: set up sequential pool.query responses
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
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  // Flush the public business cache between tests
  (publicCache as any).flushAll?.();
});

// ─────────────────────────────────────────────
// updateBusinessReviewStatusService
// ─────────────────────────────────────────────
describe('updateBusinessReviewStatusService', () => {
  test('approve: updates review_status and calls invalidatePublicBusinessData', async () => {
    setupPoolQueries(
      { rows: [{ review_status: 'under_review', user_id: 7 }] }, // SELECT before row
      { rows: [], rowCount: 1 },                                   // UPDATE
    );

    await updateBusinessReviewStatusService(1, 'approved', 99);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const updateCall = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(updateCall[0]).toMatch(/UPDATE business/);
    expect(updateCall[0]).toMatch(/review_status = \$1/);
    expect(updateCall[1]).toContain('approved');
    expect(mockInvalidatePublicBusinessData).toHaveBeenCalledTimes(1);
  });

  test('block: updates review_status, no push notification fired', async () => {
    setupPoolQueries(
      { rows: [{ review_status: 'approved', user_id: 7 }] },
      { rows: [], rowCount: 1 },
    );

    await updateBusinessReviewStatusService(1, 'blocked', 99);

    // Wait for any fire-and-forget promises to settle
    await Promise.resolve();
    expect(mockSendToUser).not.toHaveBeenCalled();
    expect(mockInvalidatePublicBusinessData).toHaveBeenCalledTimes(1);
  });

  test('push notification is fired when transitioning INTO approved from under_review', async () => {
    setupPoolQueries(
      { rows: [{ review_status: 'under_review', user_id: 42 }] },
      { rows: [], rowCount: 1 },
    );

    await updateBusinessReviewStatusService(5, 'approved', 99);
    // Allow the fire-and-forget promise to execute
    await Promise.resolve();

    expect(mockSendToUser).toHaveBeenCalledTimes(1);
    const [userId, payload] = mockSendToUser.mock.calls[0] as [number, { title: string; body: string; url: string }];
    expect(userId).toBe(42);
    expect(payload.title).toBe('Your business is live on Winnbell');
    expect(payload.url).toBe('/business');
  });

  test('push notification NOT fired when already approved -> approved (re-approve is a no-op path)', async () => {
    setupPoolQueries(
      { rows: [{ review_status: 'approved', user_id: 42 }] },
      { rows: [], rowCount: 1 },
    );

    await updateBusinessReviewStatusService(5, 'approved', 99);
    await Promise.resolve();

    expect(mockSendToUser).not.toHaveBeenCalled();
  });

  test('invalid status throws 400', async () => {
    await expect(updateBusinessReviewStatusService(1, 'banned', 99)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('404 when no business row found in the pre-check', async () => {
    setupPoolQueries({ rows: [] }); // pre-check returns nothing

    await expect(updateBusinessReviewStatusService(999, 'approved', 99)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

// ─────────────────────────────────────────────
// SQL-shape: consumer-facing queries contain review_status = 'approved'
// ─────────────────────────────────────────────
describe('SQL-shape: review_status = approved guard in consumer queries', () => {
  it('getNearbyBusinessesService includes review_status guard', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getNearbyBusinessesService(25.7, 25.8, -80.3, -80.1);
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/b\.review_status = 'approved'/);
  });

  it('getAllMapLocationsService includes review_status guard', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getAllMapLocationsService(25.7, 25.8, -80.3, -80.1);
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/b\.review_status = 'approved'/);
  });

  it('searchParticipatingLocationsService includes review_status guard', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await searchParticipatingLocationsService('coffee');
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/b\.review_status = 'approved'/);
  });

  it('location profile (unconditional variant) 404s non-approved businesses via the WHERE gate', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getLocationProfileByIdService(5);
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/b\.review_status = 'approved'/);
  });

  it('location profile (participatingOnly variant) includes review_status guard', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getParticipatingLocationByIdService(5);
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).toMatch(/b\.review_status = 'approved'/);
  });

  it('submitReceiptEntryService biz CTE includes review_status guard', async () => {
    // Default mockClientQuery resolves { rows: [] } for every step; the preflight then
    // resolves no business and the service throws. We only care that the preflight SQL
    // it issued carries the approved gate.
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await actualTickets
      .submitReceiptEntryService(1, { locationId: 5, amount: 25 } as never)
      .catch(() => undefined);
    const preflight = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('biz AS'),
    );
    expect(preflight).toBeDefined();
    expect(preflight![0]).toMatch(/b\.review_status = 'approved'/);
  });
});

// ─────────────────────────────────────────────
// ENROLLMENT_ELIGIBLE_SQL blocked guard
// ─────────────────────────────────────────────
describe('ENROLLMENT_ELIGIBLE_SQL blocked guard', () => {
  it('contains the blocked status guard', () => {
    // The constant is shared between the enrollment INSERT and the preview CTE.
    // We export it for testing only to verify both consumers use the same predicate.
    expect(ENROLLMENT_ELIGIBLE_SQL_FOR_TEST).toMatch(/b\.review_status <> 'blocked'/);
  });
});

// ─────────────────────────────────────────────
// joinCurrentCampaignService blocked -> BUSINESS_NOT_APPROVED
// ─────────────────────────────────────────────
describe('joinCurrentCampaignService - blocked business', () => {
  it('throws BUSINESS_NOT_APPROVED when the business is blocked', async () => {
    setupPoolQueries(
      // bizRes: business found, has active location
      { rows: [{ id: 10, has_active_location: true }] },
      // drawRes: open draw available
      { rows: [{ id: 1, name: 'Sept Draw', status: 'Open' }] },
      // INSERT returns 0 rows (blocked filtered it out)
      { rows: [], rowCount: 0 },
      // existing: no draw_entry row
      { rows: [] },
      // review_status check: blocked
      { rows: [{ review_status: 'blocked' }] },
    );

    await expect(joinCurrentCampaignService(99)).rejects.toThrow('BUSINESS_NOT_APPROVED');
  });

  it('throws PARTICIPATION_PAUSED (not BUSINESS_NOT_APPROVED) when business is under_review but not blocked', async () => {
    setupPoolQueries(
      { rows: [{ id: 10, has_active_location: true }] },
      { rows: [{ id: 1, name: 'Sept Draw', status: 'Open' }] },
      { rows: [], rowCount: 0 },
      { rows: [] },
      // review_status = under_review, not blocked
      { rows: [{ review_status: 'under_review' }] },
    );

    // under_review is NOT blocked, so join proceeds (INSERT filtered by participation_paused)
    // This path throws PARTICIPATION_PAUSED since participation_paused filtered it
    await expect(joinCurrentCampaignService(99)).rejects.toThrow('PARTICIPATION_PAUSED');
  });
});
