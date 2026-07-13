/**
 * Tests — reconcileSubscriptionsWithStripe (stripe.service.ts)
 *
 * Lost-webhook self-healing: the job re-reads every Stripe-backed subscription row
 * and heals status / current_period_end / cancel_at_period_end from Stripe's
 * current state. These tests pin:
 *   - a Past_Due row that Stripe shows active goes through the FULL recovery path
 *     (status flip + draw_entry enrollment INSERT), i.e. a missed
 *     invoice.payment_succeeded no longer costs the business its campaign
 *   - a row whose Stripe subscription no longer exists (resource_missing) is Cancelled
 *   - a row already in sync is left completely untouched
 *   - one failing row does not abort the sweep for the others
 */

// ── Module-level mocks (must precede imports) ─────────────────────────────────

const mockRetrieve = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent: jest.fn() },
    subscriptions: { retrieve: mockRetrieve },
  }));
});

jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
  sendFoundingWelcomeEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
  sendDisputeAlertEmail: jest.fn(),
}));

const mockQuery = jest.fn();

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({
    query: mockQuery,
    connect: jest.fn(),
  }),
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dummy';

import { reconcileSubscriptionsWithStripe } from '../stripe.service';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const FUTURE = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000); // ~20 days out
const FUTURE_UNIX = Math.floor(FUTURE.getTime() / 1000);

const localRow = (overrides: Record<string, unknown> = {}) => ({
  business_id: 42,
  stripe_subscription_id: 'sub_42',
  status: 'Active',
  current_period_end: FUTURE,
  cancel_at_period_end: false,
  ...overrides,
});

const stripeSub = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub_42',
  status: 'active',
  cancel_at_period_end: false,
  current_period_end: FUTURE_UNIX,
  items: { data: [{ current_period_end: FUTURE_UNIX }] },
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ─────────────────────────────────────────────

describe('reconcileSubscriptionsWithStripe', () => {
  it('heals a Past_Due row that Stripe shows paid: recovery flip AND enrollment into the Open draw', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [localRow({ status: 'Past_Due' })], rowCount: 1 });
    // recoverBusinessAfterPayment's status flip must report a flipped row so it enrolls
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes("status IN ('Past_Due', 'Incomplete')")) {
        return { rows: [{ business_id: 42 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    mockRetrieve.mockResolvedValue(stripeSub());

    const result = await reconcileSubscriptionsWithStripe();

    expect(result).toEqual({ checked: 1, healed: 1 });
    // Full recovery path: the draw_entry enrollment INSERT ran (idempotent ON CONFLICT)
    const enroll = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    expect(enroll).toBeDefined();
  });

  it('cancels a ghost row whose Stripe subscription no longer exists (resource_missing)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [localRow()], rowCount: 1 });
    mockRetrieve.mockRejectedValue(Object.assign(new Error('No such subscription'), { code: 'resource_missing' }));

    const result = await reconcileSubscriptionsWithStripe();

    expect(result).toEqual({ checked: 1, healed: 1 });
    const cancel = mockQuery.mock.calls.find(
      ([sql, params]: [string, unknown[]]) =>
        typeof sql === 'string' && sql.includes('SET status = $2') && params?.[1] === 'Cancelled',
    );
    expect(cancel).toBeDefined();
    // No period update: resource_missing yields no period data to write
    const periodWrite = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('SET current_period_end'),
    );
    expect(periodWrite).toBeUndefined();
  });

  it('resurrects a Cancelled row that Stripe shows alive (stale-event damage repair)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [localRow({ status: 'Cancelled' })], rowCount: 1 });
    mockRetrieve.mockResolvedValue(stripeSub());

    const result = await reconcileSubscriptionsWithStripe();

    expect(result).toEqual({ checked: 1, healed: 1 });
    const statusWrite = mockQuery.mock.calls.find(
      ([sql, params]: [string, unknown[]]) =>
        typeof sql === 'string' && sql.includes('SET status = $2') && params?.[1] === 'Active',
    );
    expect(statusWrite).toBeDefined();
  });

  it('leaves an in-sync row completely untouched', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [localRow()], rowCount: 1 });
    mockRetrieve.mockResolvedValue(stripeSub());

    const result = await reconcileSubscriptionsWithStripe();

    expect(result).toEqual({ checked: 1, healed: 0 });
    // Only the initial SELECT ran — no UPDATE / INSERT of any kind
    const writes = mockQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && (sql.includes('UPDATE') || sql.includes('INSERT')),
    );
    expect(writes).toHaveLength(0);
  });

  it('one failing row does not abort the sweep for the rest', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        localRow({ business_id: 1, stripe_subscription_id: 'sub_1' }),
        localRow({ business_id: 2, stripe_subscription_id: 'sub_2', status: 'Past_Due' }),
      ],
      rowCount: 2,
    });
    mockRetrieve
      .mockRejectedValueOnce(new Error('stripe 500')) // sub_1 blows up (non-missing error)
      .mockResolvedValueOnce(stripeSub({ id: 'sub_2' }));
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes("status IN ('Past_Due', 'Incomplete')")) {
        return { rows: [{ business_id: 2 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await reconcileSubscriptionsWithStripe();

    // sub_1 failed (not healed, but checked); sub_2 still healed
    expect(result).toEqual({ checked: 2, healed: 1 });
  });
});
