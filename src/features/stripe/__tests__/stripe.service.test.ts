/**
 * Tests — stripe.service.ts: checkout, activation (24th anchor + immediate window charge),
 * cancellation/refunds, the founding transition, and fee resolution.
 *
 * Mock strategy:
 *   - Stripe constructor is mocked at module level (required before import).
 *   - email.service is mocked (transitive import).
 *   - getPool / pool.query is mocked per test.
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
const mockSubscriptionsCancel = jest.fn();
const mockRefundsCreate = jest.fn();
const mockSetupIntentsRetrieve = jest.fn();
const mockCustomersUpdate = jest.fn();
const mockInvoiceItemsCreate = jest.fn();
const mockInvoicesCreate = jest.fn();
const mockInvoicesFinalize = jest.fn();
const mockInvoicesPay = jest.fn();
const mockInvoicesList = jest.fn();
const mockPaymentIntentsRetrieve = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: { create: mockSessionsCreate, retrieve: mockSessionsRetrieve },
    },
    subscriptions: { update: mockSubscriptionsUpdate, create: mockSubscriptionsCreate, retrieve: mockSubscriptionsRetrieve, cancel: mockSubscriptionsCancel },
    refunds: { create: mockRefundsCreate },
    setupIntents: { retrieve: mockSetupIntentsRetrieve },
    customers: { update: mockCustomersUpdate },
    invoiceItems: { create: mockInvoiceItemsCreate },
    invoices: { create: mockInvoicesCreate, finalizeInvoice: mockInvoicesFinalize, pay: mockInvoicesPay, list: mockInvoicesList },
    paymentIntents: { retrieve: mockPaymentIntentsRetrieve },
  }));
});

const mockSendFoundingWelcomeEmail = jest.fn();
jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
  sendDisputeAlertEmail: jest.fn(),
  sendFoundingWelcomeEmail: (...args: unknown[]) => mockSendFoundingWelcomeEmail(...args),
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
process.env.STRIPE_PRICE_ID_1000 = 'price_test_1000';
process.env.STRIPE_PRICE_ID_2500 = 'price_test_2500';
process.env.STRIPE_PRICE_ID_5000 = 'price_test_5000';

import { createCheckoutSession, createFoundingMemberCheckoutSession, cancelSubscription, verifyAndActivateSession, resumeSubscription, resolveMonthlyFee, isFoundingTransitionWindow, updateSubscriptionPlan, invoicePaymentIntentId, createFoundingRenewalCheckoutSession, activateFoundingRenewal, setParticipationPaused, FOUNDING_RENEWAL_TERM_MONTHS, FOUNDING_PRICE_PER_LOCATION } from '../stripe.service';
import { invalidatePlatformSettings } from '../../../shared/cache/cache';
import { CHARGE_DAY_OF_MONTH } from '../../../shared/dates';

// ─────────────────────────────────────────────
// resolveMonthlyFee — fee_at_entry single source of truth (TIER_PRICE_MAP) + drift guard
// ─────────────────────────────────────────────
describe('resolveMonthlyFee', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the TIER_PRICE_MAP value × quantity when no Stripe amount is given', () => {
    // tier 2500 (Growth) → $450/location
    expect(resolveMonthlyFee(2500, 3)).toBe(1350); // 450 × 3
  });

  it('returns the map value and does NOT log when Stripe unit_amount agrees', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // 45000 cents = $450, matches the map
    expect(resolveMonthlyFee(2500, 2, 45000)).toBe(900);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('logs CRITICAL drift but still returns the map value when Stripe disagrees', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Stripe says $500 (50000c), map says $450 → drift
    expect(resolveMonthlyFee(2500, 1, 50000)).toBe(450);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/CRITICAL: fee drift/));
  });

  it('falls back to Stripe unit_amount (and logs) when the tier is unknown', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveMonthlyFee(999, 2, 12300)).toBe(246); // 123 × 2
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/no TIER_PRICE_MAP entry/));
  });

  it('clamps quantity to at least 1', () => {
    expect(resolveMonthlyFee(2500, 0)).toBe(450);
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
// createCheckoutSession — basic setup-mode session
// ─────────────────────────────────────────────
// (The old 7-day onboarding flag is gone: every signup joins the next campaign — before
// the 24th via the regular charge, after it via an immediate charge at activation.)
describe('createCheckoutSession — setup session', () => {
  it('creates a setup-mode session and returns its url', async () => {
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/test' });

    const res = await createCheckoutSession(42, 'owner@test.com', 1000);

    expect(res.url).toBe('https://checkout.stripe.com/test');
    const [params] = mockSessionsCreate.mock.calls[0];
    expect(params.mode).toBe('setup');
  });
});

// ─────────────────────────────────────────────
// cancelSubscription — recurring path never removes from a draw
// ─────────────────────────────────────────────
describe('cancelSubscription — recurring', () => {
  it('default (keep participating): cancel_at_period_end only, nothing removed, no refund', async () => {
    mockSubscriptionsUpdate.mockResolvedValue({});
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // founding check — not a founding member
      .mockResolvedValueOnce({ rows: [{ id: 1, stripe_subscription_id: 'sub_1', status: 'Active', business_id: 42 }] }) // subResult
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE cancel_at_period_end

    const res = await cancelSubscription(7);

    // Stripe told to cancel at period end (keeps access + every paid campaign until then)
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true });

    // The business is NEVER pulled from a draw on cancel.
    const deletedDraw = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE FROM draw_entry'),
    );
    expect(deletedDraw).toBeUndefined();

    // Keep-participating choice: participation stays untouched ($2 = false). The OR form
    // matters - a direct `participation_paused = $2` would wrongly UN-pause on re-cancel.
    const update = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('SET cancel_at_period_end = true'),
    );
    expect(update![0]).toContain('participation_paused = (participation_paused OR $2)');
    expect(update![1]).toEqual([1, false]);

    expect(res).toEqual({ removedFromDraw: false, refundType: 'none', refundAmount: 0, immediateRemoval: false });
  });

  it('immediate removal choice: also sets participation_paused (off map, no enrollment), still no refund and no draw teardown', async () => {
    mockSubscriptionsUpdate.mockResolvedValue({});
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // founding check
      .mockResolvedValueOnce({ rows: [{ id: 1, stripe_subscription_id: 'sub_1', status: 'Active', business_id: 42 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE

    const res = await cancelSubscription(7, true);

    const update = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('SET cancel_at_period_end = true'),
    );
    expect(update![0]).toContain('participation_paused');
    expect(update![1]).toEqual([1, true]);
    // The pause is the whole effect: no refund, no draw_entry removal.
    expect(mockRefundsCreate).not.toHaveBeenCalled();
    const deletedDraw = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE FROM draw_entry'),
    );
    expect(deletedDraw).toBeUndefined();
    expect(res).toEqual({ removedFromDraw: false, refundType: 'none', refundAmount: 0, immediateRemoval: true });
  });
});

// ─────────────────────────────────────────────
// cancelSubscription — FOUNDING member (Special Terms: fixed term, no cancellation)
// ─────────────────────────────────────────────
describe('cancelSubscription — founding (no cancellation per Special Terms)', () => {
  const FOUNDING_ROW = { business_id: 42 };

  it('throws FOUNDING_NO_CANCEL and makes NO changes: no refund, no teardown', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [FOUNDING_ROW] }); // founding check

    await expect(cancelSubscription(7)).rejects.toThrow('FOUNDING_NO_CANCEL');

    // The Special Terms give no early termination and no refund: nothing may move.
    expect(mockRefundsCreate).not.toHaveBeenCalled();
    expect(mockClientQuery).not.toHaveBeenCalled(); // no destructive transaction opened
    // No draw removal, no founding_member delete, no subscription status change.
    const destructive = mockQuery.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && (sql.includes('DELETE') || sql.includes('UPDATE')));
    expect(destructive).toHaveLength(0);
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
    metadata: { business_id: '42', price_id: 'price_x', quantity: '2', entries_per_location: '1000', billing_interval: 'monthly' },
  };

  it('creates a subscription anchored on the platform charge day with no proration', async () => {
    mockClientQuery.mockResolvedValue({ rows: [] }); // BEGIN / INSERT / COMMIT in activateBusinessSubscription
    mockSessionsRetrieve.mockResolvedValue(SETUP_SESSION);
    mockSetupIntentsRetrieve.mockResolvedValue({ payment_method: 'pm_1' });
    mockCustomersUpdate.mockResolvedValue({});
    mockSubscriptionsCreate.mockResolvedValue({
      id: 'sub_new',
      current_period_end: Math.floor(new RealDate('2026-08-24T00:00:00.000Z').getTime() / 1000),
      items: { data: [{ price: { unit_amount: 25000, recurring: { interval: 'month' } }, quantity: 2 }] },
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })                    // business lookup
      .mockResolvedValueOnce({ rows: [] })                              // existing-sub check — none
      .mockResolvedValueOnce({ rows: [{ open_opened_at: new RealDate(), any_draw: true }] }) // Open campaign opened after the last charge → NOT in window
      .mockResolvedValueOnce({ rows: [] });                             // email lookup in activateBusinessSubscription

    await verifyAndActivateSession('cs_1', 7);

    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
    const [params, opts] = mockSubscriptionsCreate.mock.calls[0];
    expect(params.billing_cycle_anchor_config).toEqual({ day_of_month: CHARGE_DAY_OF_MONTH });
    expect(params.proration_behavior).toBe('none');
    expect(params.customer).toBe('cus_1');
    expect(params.items).toEqual([{ price: 'price_x', quantity: 2 }]);
    // Idempotency key derived from the checkout session id
    expect(opts.idempotencyKey).toContain('cs_1');
    // The saved card is made the customer default
    expect(mockCustomersUpdate).toHaveBeenCalledWith('cus_1', { invoice_settings: { default_payment_method: 'pm_1' } });
    // Outside the charged window there is no immediate charge
    expect(mockInvoiceItemsCreate).not.toHaveBeenCalled();
  });

  it('charges the upcoming campaign immediately (full price) when signing up inside the charged window', async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });
    mockSessionsRetrieve.mockResolvedValue(SETUP_SESSION);
    mockSetupIntentsRetrieve.mockResolvedValue({ payment_method: 'pm_1' });
    mockCustomersUpdate.mockResolvedValue({});
    mockSubscriptionsCreate.mockResolvedValue({
      id: 'sub_new',
      current_period_end: Math.floor(new RealDate('2026-08-24T00:00:00.000Z').getTime() / 1000),
      items: { data: [{ price: { unit_amount: 25000, recurring: { interval: 'month' } }, quantity: 2 }] },
    });
    mockInvoiceItemsCreate.mockResolvedValue({});
    mockInvoicesCreate.mockResolvedValue({ id: 'in_first', status: 'draft' });
    mockInvoicesFinalize.mockResolvedValue({ id: 'in_first', status: 'paid' });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })  // business lookup
      .mockResolvedValueOnce({ rows: [] })            // existing-sub check — none
      .mockResolvedValueOnce({ rows: [{ open_opened_at: null, any_draw: true }] }) // no Open campaign since the charge → IN window
      .mockResolvedValueOnce({ rows: [] });           // email lookup

    await verifyAndActivateSession('cs_1', 7);

    // Full campaign price for tier 1000 × 2 locations = $500 → 50000 cents, right now.
    expect(mockInvoiceItemsCreate).toHaveBeenCalledTimes(1);
    expect(mockInvoiceItemsCreate.mock.calls[0][0].amount).toBe(50000);
    // The business activates as Active (charge succeeded).
    const upsert = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO subscription'),
    );
    expect(upsert![1]).toContain('Active');
  });

  it('activates as Incomplete when the immediate window charge fails', async () => {
    mockClientQuery.mockResolvedValue({ rows: [] });
    mockSessionsRetrieve.mockResolvedValue(SETUP_SESSION);
    mockSetupIntentsRetrieve.mockResolvedValue({ payment_method: 'pm_1' });
    mockCustomersUpdate.mockResolvedValue({});
    mockSubscriptionsCreate.mockResolvedValue({
      id: 'sub_new',
      current_period_end: Math.floor(new RealDate('2026-08-24T00:00:00.000Z').getTime() / 1000),
      items: { data: [{ price: { unit_amount: 25000, recurring: { interval: 'month' } }, quantity: 2 }] },
    });
    mockInvoiceItemsCreate.mockResolvedValue({});
    mockInvoicesCreate.mockResolvedValue({ id: 'in_first', status: 'draft' });
    mockInvoicesFinalize.mockResolvedValue({ id: 'in_first', status: 'open' });
    mockInvoicesPay.mockRejectedValue(Object.assign(new Error('Your card was declined.'), { code: 'card_declined' }));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ open_opened_at: null, any_draw: true }] }); // IN window
    // No email lookup queued: an Incomplete activation sends no congrats email.

    await verifyAndActivateSession('cs_1', 7);

    // Incomplete: NOT enrolled at open; Stripe retries flip it Active via webhooks later.
    const upsert = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO subscription'),
    );
    expect(upsert![1]).toContain('Incomplete');
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
    // An immediate-removal cancel also paused participation; resuming means the owner
    // wants back in, so the pause must clear in the same UPDATE.
    const update = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('SET cancel_at_period_end = false'),
    );
    expect(update![0]).toContain('participation_paused = false');
  });
});

// ─────────────────────────────────────────────
// updateSubscriptionPlan — staged plan changes, no prorations, window settlement
// ─────────────────────────────────────────────
describe('updateSubscriptionPlan — staged change with window settlement', () => {
  const SUB_ROW = (tier: number, fee: string) => ({
    stripe_subscription_id: 'sub_1',
    stripe_customer_id: 'cus_1',
    current_entries_per_location: tier,
    fee_at_entry: fee,
    pending_entries_per_location: null,
    pending_fee_at_entry: null,
    status: 'Active',
    business_id: 42,
    next_campaign_location_count: 1,
  });

  const stripeItemMocks = () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      items: { data: [{ id: 'si_1', price: { id: 'price_test_1000' }, quantity: 1 }] },
    });
    mockSubscriptionsUpdate.mockResolvedValue({});
  };

  it('outside the window: updates Stripe with no proration and stages the plan, no money moves', async () => {
    stripeItemMocks();
    mockQuery
      .mockResolvedValueOnce({ rows: [SUB_ROW(1000, '250.00')] })          // sub row
      .mockResolvedValueOnce({ rows: [{ open_opened_at: new RealDate(), any_draw: true }] })   // campaign opened after last charge → NOT in window
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                  // staging UPDATE

    await updateSubscriptionPlan(7, 2500);

    const [subId, params] = mockSubscriptionsUpdate.mock.calls[0];
    expect(subId).toBe('sub_1');
    expect(params.proration_behavior).toBe('none');
    expect(params.items).toEqual([{ id: 'si_1', price: 'price_test_2500', quantity: 1 }]);
    // No settlement outside the window — the next 24th simply bills the new plan.
    expect(mockInvoiceItemsCreate).not.toHaveBeenCalled();
    expect(mockRefundsCreate).not.toHaveBeenCalled();
    // The change is STAGED (pending_*), never written to the live tier.
    const staging = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('pending_entries_per_location = $1'),
    );
    expect(staging).toBeDefined();
    expect(staging![1]).toEqual([2500, 450, 'price_test_2500', 42]);
    // With no settlement invoice, the change is recorded in the change log so the
    // payment history still shows what happened.
    const log = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO subscription_change_log'),
    );
    expect(log).toBeDefined();
    expect(log![1][1]).toMatch(/from 1,000 to 2,500 entries per location/);
  });

  it('inside the window: an upgrade charges the full-campaign difference immediately', async () => {
    stripeItemMocks();
    mockInvoiceItemsCreate.mockResolvedValue({});
    mockInvoicesCreate.mockResolvedValue({ id: 'in_up', status: 'draft' });
    mockInvoicesFinalize.mockResolvedValue({ id: 'in_up', status: 'paid' });
    mockQuery
      .mockResolvedValueOnce({ rows: [SUB_ROW(1000, '250.00')] })
      .mockResolvedValueOnce({ rows: [{ open_opened_at: null, any_draw: true }] }) // no campaign opened since the charge → IN window
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                  // staging UPDATE

    await updateSubscriptionPlan(7, 2500);

    // $450 - $250 = $200 difference charged now.
    expect(mockInvoiceItemsCreate).toHaveBeenCalledTimes(1);
    expect(mockInvoiceItemsCreate.mock.calls[0][0].amount).toBe(20000);
  });

  it('inside the window: a downgrade refunds the full-campaign difference from the paid invoice', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      items: { data: [{ id: 'si_1', price: { id: 'price_test_2500' }, quantity: 1 }] },
    });
    mockSubscriptionsUpdate.mockResolvedValue({});
    mockInvoicesList.mockResolvedValue({ data: [{ id: 'in_cycle', amount_paid: 45000, payment_intent: 'pi_9' }] });
    mockPaymentIntentsRetrieve.mockResolvedValue({ latest_charge: { amount: 45000, amount_refunded: 0 } });
    mockRefundsCreate.mockResolvedValue({ id: 're_1' });
    mockQuery
      .mockResolvedValueOnce({ rows: [SUB_ROW(2500, '450.00')] })
      .mockResolvedValueOnce({ rows: [{ open_opened_at: null, any_draw: true }] }) // IN window
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await updateSubscriptionPlan(7, 1000);

    // $450 - $250 = $200 refunded from the invoice that paid the upcoming campaign.
    expect(mockRefundsCreate).toHaveBeenCalledTimes(1);
    expect(mockRefundsCreate.mock.calls[0][0]).toMatchObject({ payment_intent: 'pi_9', amount: 20000 });
  });

  it('refuses any plan change while payment is broken (Past_Due) — fix the card first', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...SUB_ROW(1000, '250.00'), status: 'Past_Due' }] });

    await expect(updateSubscriptionPlan(7, 2500)).rejects.toThrow('PAYMENT_ISSUE');

    // Nothing was touched at Stripe.
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
  });

  it('rolls Stripe back and throws when the window charge fails — nothing changes anywhere', async () => {
    stripeItemMocks();
    mockInvoiceItemsCreate.mockResolvedValue({});
    mockInvoicesCreate.mockResolvedValue({ id: 'in_fail', status: 'draft' });
    mockInvoicesFinalize.mockResolvedValue({ id: 'in_fail', status: 'open' });
    mockInvoicesPay.mockRejectedValue(Object.assign(new Error('declined'), { code: 'card_declined' }));
    mockQuery
      .mockResolvedValueOnce({ rows: [SUB_ROW(1000, '250.00')] })
      .mockResolvedValueOnce({ rows: [{ open_opened_at: null, any_draw: true }] }); // IN window

    await expect(updateSubscriptionPlan(7, 2500)).rejects.toThrow('CHARGE_FAILED');

    // Second subscriptions.update call restored the original price/quantity.
    expect(mockSubscriptionsUpdate).toHaveBeenCalledTimes(2);
    const [, rollbackParams] = mockSubscriptionsUpdate.mock.calls[1];
    expect(rollbackParams.items).toEqual([{ id: 'si_1', price: 'price_test_1000', quantity: 1 }]);
    // The staging UPDATE never ran.
    const staging = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('pending_entries_per_location = $1'),
    );
    expect(staging).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// isFoundingTransitionWindow — founders are in every campaign that OPENS inside their
// year; they may start a regular plan once the year ends before the NEXT campaign opens
// (final included month or expired).
// ─────────────────────────────────────────────
describe('isFoundingTransitionWindow', () => {
  it('is true in the final included month (year ends before the next campaign opens)', () => {
    mockDateNow(nyDate(2026, 8, 6)); // August → next campaign opens Sep 1, 2026
    expect(isFoundingTransitionWindow(new RealDate('2026-08-10T12:00:00.000Z'))).toBe(true);
  });

  it('is false while the year still covers the next campaign open', () => {
    // July: next campaign opens Aug 1. Year ends Aug 10 — the August campaign is still
    // included (it opens before the expiry), so no transition yet.
    mockDateNow(nyDate(2026, 7, 6));
    expect(isFoundingTransitionWindow(new RealDate('2026-08-10T12:00:00.000Z'))).toBe(false);
  });

  it('is true after the year has fully ended', () => {
    mockDateNow(nyDate(2026, 7, 6));
    expect(isFoundingTransitionWindow(new RealDate('2026-05-31T00:00:00.000Z'))).toBe(true);
  });

  it('handles the December rollover (next campaign opens January 1 next year)', () => {
    mockDateNow(nyDate(2026, 12, 10)); // December → next campaign opens Jan 1, 2027
    expect(isFoundingTransitionWindow(new RealDate('2026-12-20T00:00:00.000Z'))).toBe(true);  // ends before Jan 1
    expect(isFoundingTransitionWindow(new RealDate('2027-01-05T00:00:00.000Z'))).toBe(false); // covers the January open
  });
});

// ─────────────────────────────────────────────
// createCheckoutSession — founding transition guard
// ─────────────────────────────────────────────
describe('createCheckoutSession — founding transition guard', () => {
  const call = () => createCheckoutSession(42, 'biz@test.com', 1000);

  it('allows a founding member in their final included month to start a regular plan', async () => {
    mockDateNow(nyDate(2026, 8, 6)); // August; year ends Aug 10 → September open not covered
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/s/1' });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ stripe_subscription_id: null, current_period_end: new RealDate('2026-08-10T12:00:00.000Z'), is_founding: true }] }) // guard
      .mockResolvedValueOnce({ rows: [{ cnt: '2' }] }); // active location count

    const res = await call();

    expect(res.url).toContain('checkout.stripe.com');
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
  });

  it('allows an EXPIRED founding member (stuck-Active row) to start a regular plan', async () => {
    mockDateNow(nyDate(2026, 7, 6));
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/s/1' });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ stripe_subscription_id: null, current_period_end: new RealDate('2026-03-31T00:00:00.000Z'), is_founding: true }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '1' }] });

    await expect(call()).resolves.toBeDefined();
    expect(mockSessionsCreate).toHaveBeenCalledTimes(1);
  });

  it('still blocks a founding member whose year covers the next campaign open', async () => {
    // July; year ends Aug 10, so the August campaign (opens Aug 1) is still included.
    mockDateNow(nyDate(2026, 7, 6));
    mockQuery.mockResolvedValueOnce({ rows: [{ stripe_subscription_id: null, current_period_end: new RealDate('2026-08-10T12:00:00.000Z'), is_founding: true }] });

    await expect(call()).rejects.toThrow(/already has an active subscription/);
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('still blocks a business with a live regular subscription', async () => {
    mockDateNow(nyDate(2026, 7, 6));
    mockQuery.mockResolvedValueOnce({ rows: [{ stripe_subscription_id: 'sub_live', current_period_end: new RealDate('2026-07-31T00:00:00.000Z'), is_founding: false }] });

    await expect(call()).rejects.toThrow(/already has an active subscription/);
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// verifyAndActivateSession — founding activation guards (duplicate purchase, live sub)
// ─────────────────────────────────────────────
describe('verifyAndActivateSession — founding activation guards', () => {
  const FOUNDING_SESSION = (id: string, pi: string) => ({
    id,
    mode: 'payment',
    payment_status: 'paid',
    payment_intent: pi,
    customer: 'cus_1',
    amount_total: 30000, // per-location pricing: 1 location x the 3-month founding total
    metadata: { business_id: '42', founding: 'true', locations: '1' },
  });

  it('auto-refunds a DUPLICATE founding purchase (seat already held via another session)', async () => {
    mockSessionsRetrieve.mockResolvedValue(FOUNDING_SESSION('cs_NEW', 'pi_dup'));
    mockRefundsCreate.mockResolvedValue({ id: 're_dup' });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })                                     // business lookup
      .mockResolvedValueOnce({ rows: [{ stripe_checkout_session_id: 'cs_OLD' }] })       // guard: seat exists from ANOTHER session
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                                 // ledger insert (refunded)

    await verifyAndActivateSession('cs_NEW', 7);

    // The full charge is refunded automatically; no seat claim transaction ever starts.
    expect(mockRefundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_dup' });
    expect(mockClientQuery).not.toHaveBeenCalled();
    // Recorded on the append-only ledger as fully refunded (amount = what the session
    // actually charged; per-location pricing makes this dynamic, bound as $4).
    const ledger = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO founding_payment'),
    );
    expect(ledger).toBeDefined();
    expect(ledger![0]).toMatch(/\$4,\s*\$4/);
    expect(ledger![1]).toContain(300);
  });

  it('is still idempotent for the SAME session (webhook + verify double call)', async () => {
    mockSessionsRetrieve.mockResolvedValue(FOUNDING_SESSION('cs_SAME', 'pi_same'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })                                     // business lookup
      .mockResolvedValueOnce({ rows: [{ stripe_checkout_session_id: 'cs_SAME' }] });     // guard: THIS session already activated

    await verifyAndActivateSession('cs_SAME', 7);

    expect(mockRefundsCreate).not.toHaveBeenCalled();
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('auto-refunds in full when the seats sold out while the payment was processing', async () => {
    mockSessionsRetrieve.mockResolvedValue(FOUNDING_SESSION('cs_SOLD', 'pi_sold'));
    mockRefundsCreate.mockResolvedValue({ id: 're_sold' });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })   // business lookup
      .mockResolvedValueOnce({ rows: [] })             // guard: no founding rows
      .mockResolvedValueOnce({ rows: [] });            // no live regular sub
    mockClientQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO founding_member')) {
        return Promise.resolve({ rows: [], rowCount: 0 }); // no seat available — cap reached
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(verifyAndActivateSession('cs_SOLD', 7)).rejects.toThrow(/refund has been issued/);

    // The $1,200 goes straight back — full refund, no amount cap.
    expect(mockRefundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_sold' });
  });

  it('cancels a live Stripe subscription before founding activation (no orphan billing)', async () => {
    mockSessionsRetrieve.mockResolvedValue(FOUNDING_SESSION('cs_F', 'pi_F'));
    mockSubscriptionsCancel.mockResolvedValue({});
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })                                     // business lookup
      .mockResolvedValueOnce({ rows: [] })                                               // guard: no founding rows
      .mockResolvedValueOnce({ rows: [{ stripe_subscription_id: 'sub_live' }] })         // live regular sub to supersede
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                                  // change-log insert
      .mockResolvedValueOnce({ rows: [{ name: 'Cafe One', email: 'owner@cafe.com', seat_number: 3, cap: 30, current_period_end: new RealDate('2027-07-06T00:00:00.000Z') }] }); // welcome email lookup
    mockClientQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO founding_member')) {
        return Promise.resolve({ rows: [{ seat_number: 3 }], rowCount: 1 });             // seat claim
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await verifyAndActivateSession('cs_F', 7);

    // The recurring subscription is cancelled at Stripe so the founding upsert (which
    // NULLs stripe_subscription_id) can never orphan a live billing subscription.
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_live');
    // Activation then proceeded normally (seat claimed in the transaction).
    const claim = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO founding_member'),
    );
    expect(claim).toBeDefined();
    // And the founding partner gets a REAL welcome email (not just a log line).
    // Seat number / cap are internal-only and deliberately NOT part of the email contract.
    expect(mockSendFoundingWelcomeEmail).toHaveBeenCalledWith('owner@cafe.com', 'Cafe One',
      expect.objectContaining({ termEnd: expect.any(Date) }));
  });
});

// ─────────────────────────────────────────────
// createFoundingMemberCheckoutSession — per-location pricing (no location limit)
// ─────────────────────────────────────────────
describe('createFoundingMemberCheckoutSession — per-location pricing', () => {
  it('prices the checkout per location ($1,200 x N) with no location limit', async () => {
    invalidatePlatformSettings(); // force the settings read through the mocked pool
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/f/1' });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ founding_phase_active: true, founding_member_cap: 30 }] }) // platform settings
      .mockResolvedValueOnce({ rows: [{ taken: 5 }] })                                             // seats taken
      .mockResolvedValueOnce({ rows: [] })                                                         // no existing subscription
      .mockResolvedValueOnce({ rows: [{ cnt: 4 }] });                                              // 4 locations — allowed now

    const res = await createFoundingMemberCheckoutSession(42, 'owner@test.com');

    expect(res.url).toBe('https://checkout.stripe.com/f/1');
    const sessionArgs = mockSessionsCreate.mock.calls[0][0];
    // quantity = location count, unit price = the single-source constant
    expect(sessionArgs.line_items[0].quantity).toBe(4);
    expect(sessionArgs.line_items[0].price_data.unit_amount).toBe(FOUNDING_PRICE_PER_LOCATION * 100);
    // location count stamped into metadata so activation records what was paid for
    expect(sessionArgs.metadata.locations).toBe('4');
  });
});

// ─────────────────────────────────────────────
// verifyAndActivateSession — founding hand-off (setup session replacing a founding membership)
// ─────────────────────────────────────────────
describe('verifyAndActivateSession — founding hand-off', () => {
  const SETUP_SESSION = {
    id: 'cs_1',
    mode: 'setup',
    status: 'complete',
    customer: 'cus_1',
    setup_intent: 'seti_1',
    metadata: { business_id: '42', price_id: 'price_x', quantity: '2', entries_per_location: '1000', billing_interval: 'monthly' },
  };

  const stripeSetupMocks = () => {
    mockSessionsRetrieve.mockResolvedValue(SETUP_SESSION);
    mockSetupIntentsRetrieve.mockResolvedValue({ payment_method: 'pm_1' });
    mockCustomersUpdate.mockResolvedValue({});
    mockSubscriptionsCreate.mockResolvedValue({
      id: 'sub_new',
      current_period_end: Math.floor(new RealDate('2026-07-31T04:00:00.000Z').getTime() / 1000),
      items: { data: [{ price: { unit_amount: 73000 }, quantity: 2 }] },
    });
  };

  /** clientQuery driven by SQL content: founding row exists; `covered` controls whether the
   *  business is enrolled in the currently Open campaign — i.e. whether its founding
   *  benefits still cover it (deferred vs immediate apply). */
  const setupHandoffClientQueries = (covered: boolean) => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM founding_member') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ id: 5 }], rowCount: 1 });
      }
      if (typeof sql === 'string' && sql.includes('FROM draw_entry') && sql.includes(`d.status = 'Open'`)) {
        return Promise.resolve(covered ? { rows: [{ ok: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  };

  const poolMocks = () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }] })                                                // business lookup
      .mockResolvedValueOnce({ rows: [{ stripe_subscription_id: null, is_founding: true }] })       // existing check → founding, proceed
      .mockResolvedValueOnce({ rows: [{ open_opened_at: new RealDate(), any_draw: true }] })                             // Open campaign after the charge → NOT in window
      .mockResolvedValueOnce({ rows: [] });                                                         // email lookup
  };

  it('proceeds past the idempotency check when the only live row is a founding membership', async () => {
    stripeSetupMocks();
    poolMocks();
    setupHandoffClientQueries(true);

    await verifyAndActivateSession('cs_1', 7);

    expect(mockSubscriptionsCreate).toHaveBeenCalledTimes(1);
  });

  it('stages the new plan in pending_* and ends the founding seat while the open campaign is still covered', async () => {
    stripeSetupMocks();
    poolMocks();
    setupHandoffClientQueries(true);

    await verifyAndActivateSession('cs_1', 7);

    const sqls = mockClientQuery.mock.calls.map(([sql]: [string]) => (typeof sql === 'string' ? sql : ''));
    // Founding seat ends at hand-off (payment history survives in founding_payment).
    expect(sqls.some((s) => s.includes('DELETE FROM founding_member'))).toBe(true);
    // Deferred: the new plan waits in pending_*, live founding tier/fee untouched.
    const staged = mockClientQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('UPDATE subscription') && sql.includes('pending_fee_at_entry'),
    );
    expect(staged).toBeDefined();
    // params: businessId, customer, sub id, price, period end, fee, tier, interval
    expect(staged![1][6]).toBe(1000);
    // The plain upsert (which would overwrite the live tier) must NOT run.
    expect(sqls.some((s) => s.includes('INSERT INTO subscription'))).toBe(false);
  });

  it('applies the new plan immediately when the founding term covers no open campaign (expired)', async () => {
    stripeSetupMocks();
    poolMocks();
    setupHandoffClientQueries(false);

    await verifyAndActivateSession('cs_1', 7);

    const sqls = mockClientQuery.mock.calls.map(([sql]: [string]) => (typeof sql === 'string' ? sql : ''));
    expect(sqls.some((s) => s.includes('DELETE FROM founding_member'))).toBe(true);
    const insert = sqls.find((s) => s.includes('INSERT INTO subscription'));
    expect(insert).toBeDefined();
    // Immediate path also clears any stale staged values.
    expect(insert).toMatch(/pending_fee_at_entry\s*=\s*NULL/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// invoicePaymentIntentId — cross-API-version PaymentIntent resolution
// Basil (2025+) removed invoice.payment_intent and put the payment under
// invoice.payments.data[].payment.payment_intent. The refund path breaks silently if
// this resolver stops handling either shape, so lock every shape down here.
// ─────────────────────────────────────────────────────────────────────────────

describe('invoicePaymentIntentId — Basil + legacy PaymentIntent resolution', () => {
  // Cast helper: the tests model raw Stripe payloads that the SDK types do not fully expose.
  const asInvoice = (o: unknown) => o as Parameters<typeof invoicePaymentIntentId>[0];

  it('reads the Basil shape with a string payment_intent', () => {
    const inv = asInvoice({ payments: { data: [{ payment: { payment_intent: 'pi_basil' } }] } });
    expect(invoicePaymentIntentId(inv)).toBe('pi_basil');
  });

  it('reads the Basil shape with an expanded {id} payment_intent object', () => {
    const inv = asInvoice({ payments: { data: [{ payment: { payment_intent: { id: 'pi_obj' } } }] } });
    expect(invoicePaymentIntentId(inv)).toBe('pi_obj');
  });

  it('skips a null Basil payment entry and takes the next valid one', () => {
    const inv = asInvoice({ payments: { data: [{ payment: { payment_intent: null } }, { payment: { payment_intent: 'pi_second' } }] } });
    expect(invoicePaymentIntentId(inv)).toBe('pi_second');
  });

  it('falls back to the legacy string invoice.payment_intent', () => {
    const inv = asInvoice({ payment_intent: 'pi_legacy' });
    expect(invoicePaymentIntentId(inv)).toBe('pi_legacy');
  });

  it('falls back to the legacy {id} invoice.payment_intent object', () => {
    const inv = asInvoice({ payment_intent: { id: 'pi_legacy_obj' } });
    expect(invoicePaymentIntentId(inv)).toBe('pi_legacy_obj');
  });

  it('prefers the Basil payments shape over the legacy field when both exist', () => {
    const inv = asInvoice({ payments: { data: [{ payment: { payment_intent: 'pi_new' } }] }, payment_intent: 'pi_old' });
    expect(invoicePaymentIntentId(inv)).toBe('pi_new');
  });

  it('returns undefined when neither shape carries a PaymentIntent', () => {
    expect(invoicePaymentIntentId(asInvoice({}))).toBeUndefined();
    expect(invoicePaymentIntentId(asInvoice({ payments: { data: [] } }))).toBeUndefined();
    expect(invoicePaymentIntentId(asInvoice({ payments: { data: [{ payment: {} }] } }))).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// Founding second-year renewal (Special Terms Section 6)
// ─────────────────────────────────────────────
describe('createFoundingRenewalCheckoutSession — window + monthly-rate pricing', () => {
  // 2 locations at $100/location/month: initial 3-month purchase was $600 total,
  // fee_at_entry (monthly rate snapshot) = $200. Renewal = $200 x 12 = $2,400.
  const FOUNDING_SUB_ROW = {
    business_id: 42, email: 'owner@cafe.com', amount_paid: '600.00', fee_at_entry: '200.00',
    current_period_end: new RealDate('2026-08-10T00:00:00.000Z'),
  };

  it('rejects before the final-30-days window opens (RENEWAL_NOT_OPEN)', async () => {
    mockDateNow(new RealDate('2026-06-01T00:00:00.000Z')); // >30 days before term end
    mockQuery.mockResolvedValueOnce({ rows: [FOUNDING_SUB_ROW] });

    await expect(createFoundingRenewalCheckoutSession(7)).rejects.toThrow('RENEWAL_NOT_OPEN');
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('rejects after the term already ended (RENEWAL_EXPIRED)', async () => {
    mockDateNow(new RealDate('2026-08-15T00:00:00.000Z')); // after term end
    mockQuery.mockResolvedValueOnce({ rows: [FOUNDING_SUB_ROW] });

    await expect(createFoundingRenewalCheckoutSession(7)).rejects.toThrow('RENEWAL_EXPIRED');
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('rejects when the ONE-TIME renewal was already used (RENEWAL_ALREADY_USED)', async () => {
    mockDateNow(new RealDate('2026-07-25T00:00:00.000Z')); // within the window
    mockQuery.mockResolvedValueOnce({ rows: [{ ...FOUNDING_SUB_ROW, renewed_at: new RealDate('2026-07-20T00:00:00.000Z') }] });

    await expect(createFoundingRenewalCheckoutSession(7)).rejects.toThrow('RENEWAL_ALREADY_USED');
    expect(mockSessionsCreate).not.toHaveBeenCalled();
  });

  it('creates a checkout at the ORIGINAL MONTHLY RATE x the renewal term inside the window', async () => {
    mockDateNow(new RealDate('2026-07-25T00:00:00.000Z')); // within final 30 days
    mockQuery.mockResolvedValueOnce({ rows: [FOUNDING_SUB_ROW] });
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/r/1' });

    const res = await createFoundingRenewalCheckoutSession(7);

    expect(res.url).toBe('https://checkout.stripe.com/r/1');
    const args = mockSessionsCreate.mock.calls[0][0];
    // Section 6: original monthly rate ($200) x FOUNDING_RENEWAL_TERM_MONTHS = $2,400.
    expect(args.line_items[0].price_data.unit_amount).toBe(200 * 100 * FOUNDING_RENEWAL_TERM_MONTHS);
    expect(args.metadata.founding_renewal).toBe('true');
  });

  it('derives the rate from amount_paid when fee_at_entry is missing (legacy rows)', async () => {
    mockDateNow(new RealDate('2026-07-25T00:00:00.000Z'));
    mockQuery.mockResolvedValueOnce({ rows: [{ ...FOUNDING_SUB_ROW, fee_at_entry: null }] });
    mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/r/2' });

    await createFoundingRenewalCheckoutSession(7);

    const args = mockSessionsCreate.mock.calls[0][0];
    // $600 over the 3-month initial term = $200/month; x 12 = $2,400. Same result.
    expect(args.line_items[0].price_data.unit_amount).toBe(240000);
  });
});

describe('activateFoundingRenewal — term extension + idempotency (transactional)', () => {
  const RENEWAL_SESSION = {
    id: 'cs_renew', payment_intent: 'pi_renew', amount_total: 240000,
    metadata: { business_id: '42', founding_renewal: 'true' },
  } as never;

  it('ledgers the payment and extends current_period_end by the renewal term FROM the term end', async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO founding_payment')) {
        return Promise.resolve({ rows: [], rowCount: 1 }); // ledger claim (fresh payment intent)
      }
      if (typeof sql === 'string' && sql.includes('UPDATE founding_member')) {
        return Promise.resolve({ rows: [{ id: 9 }], rowCount: 1 }); // renewed_at claim won
      }
      if (typeof sql === 'string' && sql.includes('UPDATE subscription')) {
        return Promise.resolve({ rows: [{ current_period_end: new RealDate('2027-08-10T00:00:00.000Z') }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 }); // BEGIN / COMMIT
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Cafe One', email: 'owner@cafe.com', locs: 2 }] }); // email lookup

    const { getPool } = jest.requireMock('../../../shared/db/db.js') as { getPool: () => never };
    await activateFoundingRenewal(getPool(), RENEWAL_SESSION);

    const extend = mockClientQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('current_period_end + make_interval(months => $2)'),
    );
    expect(extend).toBeDefined();
    // The interval param is the single-source renewal-term constant.
    expect(extend![1][1]).toBe(FOUNDING_RENEWAL_TERM_MONTHS);
    // The one-time renewal is claimed at ACTIVATION time (renewed_at IS NULL guard).
    const marked = mockClientQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('SET renewed_at = NOW()') && sql.includes('renewed_at IS NULL'),
    );
    expect(marked).toBeDefined();
    // Everything commits together — money ledgered AND term extended, or neither.
    expect(mockClientQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
    // Renewal confirmation email carries the amount, locations, and RENEWAL copy flag.
    expect(mockSendFoundingWelcomeEmail).toHaveBeenCalledWith('owner@cafe.com', 'Cafe One',
      expect.objectContaining({ amountPaid: 2400, locationCount: 2, termMonths: FOUNDING_RENEWAL_TERM_MONTHS, isRenewal: true }));
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  it('is idempotent: a second call with the SAME payment intent (webhook + verify double fire) is a no-op', async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO founding_payment')) {
        return Promise.resolve({ rows: [], rowCount: 0 }); // ledger claim lost (already processed)
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const { getPool } = jest.requireMock('../../../shared/db/db.js') as { getPool: () => never };
    await activateFoundingRenewal(getPool(), RENEWAL_SESSION);

    const extend = mockClientQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('make_interval'),
    );
    expect(extend).toBeUndefined();
    expect(mockClientQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    expect(mockSendFoundingWelcomeEmail).not.toHaveBeenCalled();
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  it('refunds a DUPLICATE renewal payment (different intent, renewal already used) and never extends twice', async () => {
    // Two tabs both created a renewal checkout while renewed_at was NULL; the second
    // paid session arrives with a DIFFERENT payment intent after the first extended.
    mockRefundsCreate.mockResolvedValue({ id: 're_dup_renew' });
    mockClientQuery.mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO founding_payment')) {
        return Promise.resolve({ rows: [], rowCount: 1 }); // fresh PI — ledger insert succeeds
      }
      if (typeof sql === 'string' && sql.includes('UPDATE founding_member')) {
        return Promise.resolve({ rows: [], rowCount: 0 }); // renewed_at already set — claim LOST
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const { getPool } = jest.requireMock('../../../shared/db/db.js') as { getPool: () => never };
    await activateFoundingRenewal(getPool(), { ...(RENEWAL_SESSION as object), payment_intent: 'pi_renew_2' } as never);

    // The term is NEVER extended a second time.
    const extend = mockClientQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('make_interval'),
    );
    expect(extend).toBeUndefined();
    // The duplicate payment is refunded in full and ledgered as refunded.
    expect(mockRefundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_renew_2' });
    const refundMark = mockClientQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('SET refunded_amount = amount'),
    );
    expect(refundMark).toBeDefined();
    expect(mockClientQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
    expect(mockSendFoundingWelcomeEmail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// setParticipationPaused — founding cancel (permanent opt-out, no refund) + reactivate
// ─────────────────────────────────────────────
describe('setParticipationPaused — founding cancel and reactivate', () => {
  const FUTURE = new RealDate(RealDate.now() + 30 * 24 * 3600 * 1000);
  const PAST = new RealDate(RealDate.now() - 24 * 3600 * 1000);

  it('pauses a founding subscription (no Stripe calls, no draw removal)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, current_period_end: FUTURE, is_founding: true }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE participation_paused

    await setParticipationPaused(7, true);

    const update = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('SET participation_paused'),
    );
    expect(update).toBeDefined();
    expect(update![1]).toEqual([5, true]);
    // Voluntary opt-out only: nothing is refunded, nothing leaves a draw.
    expect(mockRefundsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    const deletedDraw = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM draw_entry'),
    );
    expect(deletedDraw).toBeUndefined();
  });

  it('reactivates while the founding term still runs', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, current_period_end: FUTURE, is_founding: true }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await setParticipationPaused(7, false);

    const update = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('SET participation_paused'),
    );
    expect(update![1]).toEqual([5, false]);
  });

  it('rejects reactivation after the founding term ended', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, current_period_end: PAST, is_founding: true }] });

    await expect(setParticipationPaused(7, false)).rejects.toThrow('FOUNDING_TERM_ENDED');

    const update = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('SET participation_paused'),
    );
    expect(update).toBeUndefined();
  });

  it('rejects non-founding subscriptions (monthly plans use the Stripe cancel flow)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, current_period_end: FUTURE, is_founding: false }] });

    await expect(setParticipationPaused(7, true)).rejects.toThrow('FOUNDING_ONLY');
  });

  it('throws when there is no active subscription', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await expect(setParticipationPaused(7, true)).rejects.toThrow('No active subscription found');
  });
});
