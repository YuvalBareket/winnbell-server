/**
 * Tests — handleStripeWebhook idempotency claim lifecycle (stripe.service.ts)
 *
 * The handler claims the event_id BEFORE processing (atomic INSERT ... ON CONFLICT
 * DO NOTHING). These tests pin the recovery behavior:
 *   - duplicate delivery is skipped (claim already exists)
 *   - successful processing keeps the claim (no re-processing on redelivery)
 *   - FAILED processing releases the claim (DELETE) and rethrows, so Stripe's
 *     retry is processed instead of being silently skipped forever
 */

// ── Module-level mocks (must precede imports) ─────────────────────────────────

const mockConstructEvent = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: { constructEvent: mockConstructEvent },
  }));
});

const mockSendPaymentFailedEmail = jest.fn();
const mockSendDisputeAlertEmail = jest.fn();
jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
  sendFoundingWelcomeEmail: jest.fn(),
  sendPaymentFailedEmail: (...args: unknown[]) => mockSendPaymentFailedEmail(...args),
  sendDisputeAlertEmail: (...args: unknown[]) => mockSendDisputeAlertEmail(...args),
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

import { handleStripeWebhook } from '../stripe.service';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const makeEvent = (id: string) => ({
  id,
  type: 'invoice.payment_failed',
  data: { object: { subscription: 'sub_123' } },
});

const claimInsertCall = () =>
  mockQuery.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO stripe_webhook_event'));

const claimDeleteCall = () =>
  mockQuery.mock.calls.find(([sql]: [string]) => sql.includes('DELETE FROM stripe_webhook_event'));

beforeEach(() => {
  jest.clearAllMocks();
  // Default response for follow-up queries (email lookups, recovery enrolls, etc.).
  // Tests override the calls they care about with mockResolvedValueOnce.
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ─────────────────────────────────────────────
// handleStripeWebhook — claim lifecycle
// ─────────────────────────────────────────────

describe('handleStripeWebhook — idempotency claim lifecycle', () => {
  it('skips processing entirely when the event was already claimed (duplicate delivery)', async () => {
    mockConstructEvent.mockReturnValue(makeEvent('evt_dup'));
    // INSERT ... ON CONFLICT DO NOTHING returns no row → already claimed
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    expect(mockQuery).toHaveBeenCalledTimes(1); // only the claim attempt
    expect(claimDeleteCall()).toBeUndefined();
  });

  it('keeps the claim after successful processing (redelivery stays deduplicated)', async () => {
    mockConstructEvent.mockReturnValue(makeEvent('evt_ok'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ event_id: 'evt_ok' }], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                       // UPDATE subscription

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    expect(claimInsertCall()).toBeDefined();
    expect(claimDeleteCall()).toBeUndefined();
  });

  it('releases the claim and rethrows when processing fails, so the Stripe retry is processed', async () => {
    mockConstructEvent.mockReturnValue(makeEvent('evt_fail'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ event_id: 'evt_fail' }], rowCount: 1 }) // claim
      .mockRejectedValueOnce(new Error('DB down'))                              // UPDATE subscription fails
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                        // DELETE claim

    await expect(handleStripeWebhook(Buffer.from('{}'), 'sig')).rejects.toThrow('DB down');

    const del = claimDeleteCall();
    expect(del).toBeDefined();
    expect(del![1]).toEqual(['evt_fail']);
  });

  it('still rethrows the original error even when releasing the claim also fails', async () => {
    mockConstructEvent.mockReturnValue(makeEvent('evt_doublefail'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ event_id: 'evt_doublefail' }], rowCount: 1 }) // claim
      .mockRejectedValueOnce(new Error('processing failed'))                          // processing fails
      .mockRejectedValueOnce(new Error('delete also failed'));                        // DELETE claim fails

    await expect(handleStripeWebhook(Buffer.from('{}'), 'sig')).rejects.toThrow('processing failed');
  });

  it('throws on invalid signature without touching the claim table', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('bad signature'); });

    await expect(handleStripeWebhook(Buffer.from('{}'), 'sig')).rejects.toThrow(
      /signature verification failed/,
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// customer.subscription.deleted — Cancelled, but never removes from a draw
// ─────────────────────────────────────────────
describe('handleStripeWebhook — customer.subscription.deleted', () => {
  it('marks the subscription Cancelled and never deletes a draw_entry', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_del',
      type: 'customer.subscription.deleted',
      data: { object: { metadata: { business_id: '42' } } },
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ event_id: 'evt_del' }], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                       // UPDATE -> Cancelled

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    const cancelled = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("status = 'Cancelled'"),
    );
    expect(cancelled).toBeDefined();

    // The business keeps the paid draw it's in — the deleted event must not delete entries.
    const deletedDraw = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('DELETE FROM draw_entry'),
    );
    expect(deletedDraw).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// invoice.payment_succeeded — clears Past_Due, recovers + enrolls, never resurrects Cancelled
// ─────────────────────────────────────────────
describe('handleStripeWebhook — invoice.payment_succeeded', () => {
  it("flips the subscription to Active with a 'status <> Cancelled' guard, and does NOT touch current_period_end", async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_paid',
      type: 'invoice.payment_succeeded',
      data: { object: { subscription: 'sub_123' } },
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ event_id: 'evt_paid' }], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                        // SELECT prior — no row

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    const activated = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("status = 'Active'") && sql.includes('stripe_subscription_id'),
    );
    expect(activated).toBeDefined();
    // Best-practice guards: never resurrect a Cancelled sub; scope to this subscription.
    expect(activated![0]).toMatch(/status <> 'Cancelled'/);
    expect(activated![0]).toMatch(/WHERE stripe_subscription_id = \$1/);
    // Settlement/one-off invoices fire this event too — period must NOT be written here.
    expect(activated![0]).not.toMatch(/current_period_end/);
    expect(activated![1]).toEqual(['sub_123']);
  });

  it('RECOVERS a Past_Due business: flips Active and enrolls it into the Open campaign it paid for', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_recover',
      type: 'invoice.payment_succeeded',
      data: { object: { subscription: 'sub_123' } },
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ event_id: 'evt_recover' }], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [{ business_id: 42 }], rowCount: 1 })         // SELECT prior
      .mockResolvedValueOnce({ rows: [{ business_id: 42 }], rowCount: 1 });        // recovery flip RETURNING → was Past_Due/Incomplete

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    const enroll = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    expect(enroll).toBeDefined();
    expect(enroll![0]).toMatch(/d\.status = 'Open'/);
    expect(enroll![0]).toMatch(/current_period_end >= NOW\(\)/);
    // Recovery must respect an opt-out: a business that skipped this campaign is not
    // re-enrolled just because its late payment cleared.
    expect(enroll![0]).toMatch(/skip_next_campaign = FALSE/);
    expect(enroll![1]).toEqual([42]);
  });

  it('does NOT enroll when the business was fine all along (no recovery)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_normal',
      type: 'invoice.payment_succeeded',
      data: { object: { subscription: 'sub_123' } },
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ event_id: 'evt_normal' }], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [{ business_id: 42 }], rowCount: 1 })        // SELECT prior
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                          // recovery flip → no Past_Due/Incomplete row

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    const enroll = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO draw_entry'),
    );
    expect(enroll).toBeUndefined();
  });

  it('ignores settlement invoices entirely (change differences, not campaign payments)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_settle_ok',
      type: 'invoice.payment_succeeded',
      data: { object: { subscription: 'sub_123', metadata: { winnbell_kind: 'settlement' } } },
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ event_id: 'evt_settle_ok' }], rowCount: 1 }); // claim only

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    expect(mockQuery).toHaveBeenCalledTimes(1); // only the claim
  });

  it('ignores invoices with no subscription (one-time / founding payments)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_onetime',
      type: 'invoice.payment_succeeded',
      data: { object: {} }, // no subscription field
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ event_id: 'evt_onetime' }], rowCount: 1 }); // claim only

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    const activated = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("status = 'Active'"),
    );
    expect(activated).toBeUndefined(); // no UPDATE issued
    expect(mockQuery).toHaveBeenCalledTimes(1); // only the claim
  });
});

// ─────────────────────────────────────────────
// customer.subscription.updated — stale/out-of-order event guards
// ─────────────────────────────────────────────
describe('handleStripeWebhook — customer.subscription.updated', () => {
  it('scopes the write to the matching subscription id and never resurrects a Cancelled row', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_upd',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_123',
          status: 'active',
          cancel_at_period_end: false,
          current_period_end: 1790000000,
          metadata: { business_id: '42' },
        },
      },
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ event_id: 'evt_upd' }], rowCount: 1 }); // claim

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    const upd = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('SET status = $1'),
    );
    expect(upd).toBeDefined();
    // A stale event from an old, replaced subscription must not touch the new row...
    expect(upd![0]).toMatch(/stripe_subscription_id = \$5/);
    // ...and a late "updated" must never resurrect a subscription the "deleted" event killed.
    expect(upd![0]).toMatch(/status <> 'Cancelled'/);
    expect(upd![1]).toEqual(['Active', expect.any(Date), false, 42, 'sub_123']);
  });
});

// ─────────────────────────────────────────────
// charge.dispute.created — notify only, never act
// ─────────────────────────────────────────────
describe('handleStripeWebhook — charge.dispute.created', () => {
  it('identifies the business and sends an alert without changing any data', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_disp',
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', amount: 120000, reason: 'fraudulent', payment_intent: 'pi_founding' } },
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ event_id: 'evt_disp' }], rowCount: 1 })  // claim
      .mockResolvedValueOnce({ rows: [{ id: 42, name: 'Cafe One' }] });          // founding_payment lookup

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    expect(mockSendDisputeAlertEmail).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 42,
      businessName: 'Cafe One',
      amountDollars: 1200,
      disputeId: 'dp_1',
      reason: 'fraudulent',
    }));
    // Notify ONLY: no subscription/draw mutation of any kind.
    const mutation = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && (sql.includes('UPDATE subscription') || sql.includes('DELETE FROM draw_entry')),
    );
    expect(mutation).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// invoice.payment_failed — Past_Due + first-attempt email, settlements ignored
// ─────────────────────────────────────────────
describe('handleStripeWebhook — invoice.payment_failed', () => {
  it('marks Past_Due and emails the business on the FIRST failed attempt', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_fail1',
      type: 'invoice.payment_failed',
      data: { object: { subscription: 'sub_123', attempt_count: 1, amount_due: 92000 } },
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ event_id: 'evt_fail1' }], rowCount: 1 })          // claim
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                                    // UPDATE -> Past_Due
      .mockResolvedValueOnce({ rows: [{ name: 'Cafe One', email: 'owner@cafe.com' }] });   // email lookup

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    const pastDue = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("status = 'Past_Due'"),
    );
    expect(pastDue).toBeDefined();
    expect(mockSendPaymentFailedEmail).toHaveBeenCalledWith('owner@cafe.com', 'Cafe One', 920);
  });

  it('does NOT re-email on later retry attempts (banner persists in-app)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_fail3',
      type: 'invoice.payment_failed',
      data: { object: { subscription: 'sub_123', attempt_count: 3, amount_due: 92000 } },
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ event_id: 'evt_fail3' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    expect(mockSendPaymentFailedEmail).not.toHaveBeenCalled();
  });

  it('keeps a failed SIGNUP charge as Incomplete (no Past_Due) but still emails the first attempt', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_signupfail',
      type: 'invoice.payment_failed',
      data: { object: { subscription: 'sub_123', attempt_count: 1, amount_due: 146000, metadata: { winnbell_kind: 'signup_charge' } } },
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ event_id: 'evt_signupfail' }], rowCount: 1 })         // claim
      .mockResolvedValueOnce({ rows: [{ name: 'New Cafe', email: 'new@cafe.com' }] });        // email lookup

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    // Signup failures stay Incomplete (set at activation) — Past_Due is for established subs.
    const pastDue = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("status = 'Past_Due'"),
    );
    expect(pastDue).toBeUndefined();
    // But the business is still told to fix its card.
    expect(mockSendPaymentFailedEmail).toHaveBeenCalledWith('new@cafe.com', 'New Cafe', 1460);
  });

  it('ignores failed SETTLEMENT invoices — the change was rolled back, the campaign payment is fine', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_settle_fail',
      type: 'invoice.payment_failed',
      data: { object: { subscription: 'sub_123', attempt_count: 1, metadata: { winnbell_kind: 'settlement' } } },
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ event_id: 'evt_settle_fail' }], rowCount: 1 }); // claim only

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    const pastDue = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("status = 'Past_Due'"),
    );
    expect(pastDue).toBeUndefined();
    expect(mockSendPaymentFailedEmail).not.toHaveBeenCalled();
  });
});
