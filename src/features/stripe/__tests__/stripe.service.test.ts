/**
 * Tests — createCheckoutSession: 7-day campaign onboarding cutoff (stripe.service.ts)
 *
 * The service blocks new subscriptions when fewer than CAMPAIGN_ONBOARDING_CUTOFF_DAYS (7)
 * days remain before the 1st of the next month in the America/New_York timezone.
 *
 * Mock strategy:
 *   - Stripe constructor is mocked at module level (required before import).
 *   - email.service is mocked (transitive import).
 *   - getPool / pool.query is mocked: the existing-subscription guard query returns no rows
 *     so execution reaches the date-check logic before any other early-exit.
 *   - Date constructor is spied on to control "now".
 */

// Capture the real Date constructor BEFORE any spy can replace it.
// This reference is used inside mockDateNow so multi-arg `new Date(y,m,d)` calls
// still produce real Date instances even while the spy is active.
const RealDate = Date;

// ── Module-level mocks (must precede imports) ─────────────────────────────────

const mockSessionsCreate = jest.fn();
const mockSessionsRetrieve = jest.fn();
const mockSubscriptionsUpdate = jest.fn();
const mockSubscriptionsCreate = jest.fn();
const mockSubscriptionsRetrieve = jest.fn();
const mockRefundsCreate = jest.fn();
const mockSetupIntentsRetrieve = jest.fn();
const mockCustomersUpdate = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: { create: mockSessionsCreate, retrieve: mockSessionsRetrieve },
    },
    subscriptions: { update: mockSubscriptionsUpdate, create: mockSubscriptionsCreate, retrieve: mockSubscriptionsRetrieve },
    refunds: { create: mockRefundsCreate },
    setupIntents: { retrieve: mockSetupIntentsRetrieve },
    customers: { update: mockCustomersUpdate },
  }));
});

jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
}));

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

// Set required env vars before importing the service
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_PRICE_ID_250 = 'price_test_250';

import { createCheckoutSession, cancelSubscription, verifyAndActivateSession, resumeSubscription, resolveMonthlyFee } from '../stripe.service';

// ─────────────────────────────────────────────
// resolveMonthlyFee — fee_at_entry single source of truth (TIER_PRICE_MAP) + drift guard
// ─────────────────────────────────────────────
describe('resolveMonthlyFee', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the TIER_PRICE_MAP value × quantity when no Stripe amount is given', () => {
    // tier 500 → $490/location
    expect(resolveMonthlyFee(500, 3)).toBe(1470); // 490 × 3
  });

  it('returns the map value and does NOT log when Stripe unit_amount agrees', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // 49000 cents = $490, matches the map
    expect(resolveMonthlyFee(500, 2, 49000)).toBe(980);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('logs CRITICAL drift but still returns the map value when Stripe disagrees', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Stripe says $500 (50000c), map says $490 → drift
    expect(resolveMonthlyFee(500, 1, 50000)).toBe(490);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/CRITICAL: fee drift/));
  });

  it('falls back to Stripe unit_amount (and logs) when the tier is unknown', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveMonthlyFee(999, 2, 12300)).toBe(246); // 123 × 2
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/no TIER_PRICE_MAP entry/));
  });

  it('clamps quantity to at least 1', () => {
    expect(resolveMonthlyFee(500, 0)).toBe(490);
  });
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Mocks Date() (zero-arg constructor) to return a fixed date while leaving
 * multi-arg construction (e.g. new Date(year, month, day)) untouched so that
 * the service's own `new Date(nowNY.getFullYear(), nowNY.getMonth() + 1, 1)`
 * still computes correctly.
 *
 * The service derives nowNY via:
 *   new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
 * so we only need to control the zero-arg `new Date()` call.
 */
function mockDateNow(fixedDate: Date): void {
  // @ts-ignore — spyOn typing doesn't cover the constructor overload
  jest.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
    if (args.length === 0) return new RealDate(fixedDate.getTime());
    // @ts-ignore
    return new RealDate(...args);
  });
  // Preserve static methods so the service can still call new Date(str) etc.
  (global.Date as any).now  = () => fixedDate.getTime();
  (global.Date as any).UTC  = RealDate.UTC.bind(RealDate);
  (global.Date as any).parse = RealDate.parse.bind(RealDate);
}

/**
 * Builds a Date whose toLocaleString in America/New_York lands on the given
 * calendar date at noon (avoids DST midnight edge-cases).
 *
 * NY is UTC-5 (EST) or UTC-4 (EDT). Anchoring at 17:00 UTC means the
 * NY wall-clock reads noon regardless of DST.
 */
function nyDate(year: number, month: number /* 1-based */, day: number): Date {
  return new RealDate(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T17:00:00.000Z`,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();

  // Default: no existing subscription — passes the guard before the date check
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ─────────────────────────────────────────────
// createCheckoutSession — campaign cutoff tests
// ─────────────────────────────────────────────

// The service no longer BLOCKS signups inside the 7-day window — it allows the
// subscription and returns joinsNextCampaign so the client can tell the business
// they will join the NEXT campaign instead of the current one.
describe('createCheckoutSession — 7-day campaign onboarding flag', () => {
  beforeEach(() => {
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/test' });
  });

  it('flags joinsNextCampaign when only 2 days remain before next month', async () => {
    // January 29 — 2 days before Feb 1 → within 7-day window
    mockDateNow(nyDate(2026, 1, 29));

    const res = await createCheckoutSession(42, 'owner@test.com', 250);
    expect(res.joinsNextCampaign).toBe(true);
    expect(res.url).toBe('https://checkout.stripe.com/test');
  });

  it('flags joinsNextCampaign exactly on the cutoff day (7 days before)', async () => {
    // January 25 — exactly 7 days before Feb 1 (daysUntilNext ≈ 7.0, which is <= 7)
    mockDateNow(nyDate(2026, 1, 25));

    const res = await createCheckoutSession(42, 'owner@test.com', 250);
    expect(res.joinsNextCampaign).toBe(true);
  });

  it('does NOT flag joinsNextCampaign when 10 days remain before next month', async () => {
    // January 22 — 10 days before Feb 1 → outside 7-day window
    mockDateNow(nyDate(2026, 1, 22));

    const res = await createCheckoutSession(42, 'owner@test.com', 250);
    expect(res.joinsNextCampaign).toBe(false);
    expect(res.nextCampaignDate).toBeNull();
  });

  it('includes the month-after-next in nextCampaignDate when flagged', async () => {
    // January 29 — flagged; the business joins the campaign starting March 1
    mockDateNow(nyDate(2026, 1, 29));

    const res = await createCheckoutSession(42, 'owner@test.com', 250);
    expect(res.joinsNextCampaign).toBe(true);
    expect(res.nextCampaignDate).toMatch(/March/);
  });

  it('flags joinsNextCampaign when 1 day remains (last day of month)', async () => {
    // January 31 — 1 day before Feb 1
    mockDateNow(nyDate(2026, 1, 31));

    const res = await createCheckoutSession(42, 'owner@test.com', 250);
    expect(res.joinsNextCampaign).toBe(true);
  });

  it('does NOT flag at the start of a month (30+ days to go)', async () => {
    // January 1 — 31 days before Feb 1 → well outside the 7-day window
    mockDateNow(nyDate(2026, 1, 1));

    const res = await createCheckoutSession(42, 'owner@test.com', 250);
    expect(res.joinsNextCampaign).toBe(false);
  });

  it('respects the window for shorter months (Feb 22 — 6 days before Mar 1)', async () => {
    // February 22, 2026 — 6 days before March 1 → within 7-day window
    mockDateNow(nyDate(2026, 2, 22));

    const res = await createCheckoutSession(42, 'owner@test.com', 250);
    expect(res.joinsNextCampaign).toBe(true);
    expect(res.nextCampaignDate).toMatch(/April/);
  });
});

// ─────────────────────────────────────────────
// cancelSubscription — recurring path never removes from a draw
// ─────────────────────────────────────────────
describe('cancelSubscription — recurring', () => {
  it('sets cancel_at_period_end, removes NOTHING from draws, issues no refund', async () => {
    mockSubscriptionsUpdate.mockResolvedValue({});
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // founding check — not a founding member
      .mockResolvedValueOnce({ rows: [{ id: 1, stripe_subscription_id: 'sub_1', business_id: 42 }] }) // subResult
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE cancel_at_period_end

    const res = await cancelSubscription(7);

    // Stripe told to cancel at period end (keeps access + paid draw until then)
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });

    // The business is NEVER pulled from a draw on cancel.
    const deletedDraw = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE FROM draw_entry'),
    );
    expect(deletedDraw).toBeUndefined();

    expect(res).toEqual({ removedFromDraw: false, refundType: 'none', refundAmount: 0 });
  });
});

// ─────────────────────────────────────────────
// cancelSubscription — FOUNDING member refund flow (the refund path)
// ─────────────────────────────────────────────
describe('cancelSubscription — founding refund', () => {
  const FOUNDING_ROW = { stripe_payment_intent_id: 'pi_1', business_id: 42 };

  it('issues a prorated 50%-of-remaining-time refund, then tears down the membership', async () => {
    const createdAt = new RealDate('2026-01-01T00:00:00.000Z');
    const periodEnd = new RealDate('2027-01-01T00:00:00.000Z');
    const now = new RealDate('2026-07-02T00:00:00.000Z');
    mockDateNow(now);
    mockRefundsCreate.mockResolvedValue({ id: 're_1' });

    mockQuery
      .mockResolvedValueOnce({ rows: [FOUNDING_ROW] })                                              // founding check
      .mockResolvedValueOnce({ rows: [{ created_at: createdAt, current_period_end: periodEnd }] }); // membership period
    // Destructive writes (ledger + deletes + cancel) now run in a client transaction.
    mockClientQuery.mockImplementation((sql: string) =>
      Promise.resolve(
        typeof sql === 'string' && sql.includes('DELETE FROM draw_entry')
          ? { rows: [{ draw_id: 9 }], rowCount: 1 }
          : { rows: [], rowCount: 1 },
      ),
    );

    const res = await cancelSubscription(7);

    const totalMs = periodEnd.getTime() - createdAt.getTime();
    const remainingMs = periodEnd.getTime() - now.getTime();
    const expectedCents = Math.round(120000 * (remainingMs / totalMs) * 0.5);

    expect(mockRefundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_1', amount: expectedCents });
    expect(res.refundType).toBe('prorated');
    expect(res.refundAmount).toBeCloseTo(expectedCents / 100, 2);
    expect(res.removedFromDraw).toBe(true);
  });

  it('aborts with REFUND_FAILED and makes NO destructive change when the Stripe refund fails', async () => {
    mockDateNow(new RealDate('2026-07-02T00:00:00.000Z'));
    mockRefundsCreate.mockRejectedValue(new Error('charge_already_refunded'));

    mockQuery
      .mockResolvedValueOnce({ rows: [FOUNDING_ROW] })
      .mockResolvedValueOnce({ rows: [{ created_at: new RealDate('2026-01-01T00:00:00.000Z'), current_period_end: new RealDate('2027-01-01T00:00:00.000Z') }] });

    await expect(cancelSubscription(7)).rejects.toThrow('REFUND_FAILED');

    // Membership must remain intact — the refund fails BEFORE the DB transaction opens,
    // so the client (which now runs all destructive writes) is never even acquired.
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('no refund when the membership year has already ended, but still tears down', async () => {
    mockDateNow(new RealDate('2026-06-01T00:00:00.000Z'));
    mockQuery
      .mockResolvedValueOnce({ rows: [FOUNDING_ROW] })
      .mockResolvedValueOnce({ rows: [{ created_at: new RealDate('2025-01-01T00:00:00.000Z'), current_period_end: new RealDate('2026-01-01T00:00:00.000Z') }] });
    // No refund, but the teardown still runs in a transaction; DELETE draw_entry finds none.
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await cancelSubscription(7);

    expect(mockRefundsCreate).not.toHaveBeenCalled();
    expect(res.refundType).toBe('none');
    expect(res.refundAmount).toBe(0);
    expect(res.removedFromDraw).toBe(false);
  });

  it('refund never exceeds 50% of the $1,200 fee, even cancelling on day one', async () => {
    mockDateNow(new RealDate('2026-01-01T00:01:00.000Z')); // ~1 minute into the year
    mockRefundsCreate.mockResolvedValue({ id: 're_1' });
    mockQuery
      .mockResolvedValueOnce({ rows: [FOUNDING_ROW] })
      .mockResolvedValueOnce({ rows: [{ created_at: new RealDate('2026-01-01T00:00:00.000Z'), current_period_end: new RealDate('2027-01-01T00:00:00.000Z') }] });
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await cancelSubscription(7);

    const amount = mockRefundsCreate.mock.calls[0][0].amount;
    expect(amount).toBeLessThanOrEqual(60000); // never more than $600 (50% of $1,200)
    expect(amount).toBeGreaterThan(59900);     // ~$600 on day one
  });
});

// ─────────────────────────────────────────────
// verifyAndActivateSession — setup-mode subscription creation (month-end anchor)
// ─────────────────────────────────────────────
describe('verifyAndActivateSession — setup-mode subscription creation', () => {
  const SETUP_SESSION = {
    id: 'cs_1',
    mode: 'setup',
    status: 'complete',
    customer: 'cus_1',
    setup_intent: 'seti_1',
    metadata: { business_id: '42', price_id: 'price_x', quantity: '2', entries_per_location: '750', billing_interval: 'monthly' },
  };

  it('creates a month-end-anchored subscription with no first-month proration', async () => {
    mockClientQuery.mockResolvedValue({ rows: [] }); // BEGIN / INSERT / COMMIT in activateBusinessSubscription
    mockSessionsRetrieve.mockResolvedValue(SETUP_SESSION);
    mockSetupIntentsRetrieve.mockResolvedValue({ payment_method: 'pm_1' });
    mockCustomersUpdate.mockResolvedValue({});
    mockSubscriptionsCreate.mockResolvedValue({
      id: 'sub_new',
      current_period_end: Math.floor(new RealDate('2026-08-31T00:00:00.000Z').getTime() / 1000),
      items: { data: [{ price: { unit_amount: 94000, recurring: { interval: 'month' } }, quantity: 2 }] },
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // business lookup
      .mockResolvedValueOnce({ rows: [] })           // existing-sub check — none
      .mockResolvedValueOnce({ rows: [] });          // email lookup in activateBusinessSubscription

    await verifyAndActivateSession('cs_1', 7);

    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    const [params, opts] = mockSubscriptionsCreate.mock.calls[0];
    expect(params.billing_cycle_anchor_config).toEqual({ day_of_month: 31 });
    expect(params.proration_behavior).toBe('none');
    expect(params.customer).toBe('cus_1');
    expect(params.items).toEqual([{ price: 'price_x', quantity: 2 }]);
    // Idempotency key derived from the checkout session id
    expect(opts.idempotencyKey).toContain('cs_1');
    // The saved card is made the customer default
    expect(mockCustomersUpdate).toHaveBeenCalledWith('cus_1', { invoice_settings: { default_payment_method: 'pm_1' } });
  });

  it('is idempotent — does not create a second subscription if one already exists', async () => {
    mockSessionsRetrieve.mockResolvedValue(SETUP_SESSION);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }) // business lookup
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }); // existing sub EXISTS

    await verifyAndActivateSession('cs_1', 7);

    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('rejects a session that belongs to a different business', async () => {
    mockSessionsRetrieve.mockResolvedValue({ ...SETUP_SESSION, metadata: { ...SETUP_SESSION.metadata, business_id: '999' } });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] }); // business lookup

    await expect(verifyAndActivateSession('cs_1', 7)).rejects.toThrow(/does not belong/);
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// resumeSubscription — clears the cancel flag, no draw work
// ─────────────────────────────────────────────
describe('resumeSubscription', () => {
  it('clears cancel_at_period_end and does no draw enrollment or extra Stripe reads', async () => {
    mockSubscriptionsUpdate.mockResolvedValue({});
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // founding check — not founding
      .mockResolvedValueOnce({ rows: [{ id: 1, stripe_subscription_id: 'sub_1', business_id: 42 }] }) // pending-cancel sub
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE cancel_at_period_end = false

    await resumeSubscription(7);

    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: false });
    // Re-participation was removed — the next campaign open re-enrolls it.
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    const enroll = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    expect(enroll).toBeUndefined();
  });
});
