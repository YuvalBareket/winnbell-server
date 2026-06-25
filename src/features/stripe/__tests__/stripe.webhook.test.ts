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

jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
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
// invoice.payment_succeeded — clears Past_Due (status only), never resurrects Cancelled
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
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                        // UPDATE -> Active

    await handleStripeWebhook(Buffer.from('{}'), 'sig');

    const activated = mockQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes("status = 'Active'"),
    );
    expect(activated).toBeDefined();
    // Best-practice guards: never resurrect a Cancelled sub; scope to this subscription.
    expect(activated![0]).toMatch(/status <> 'Cancelled'/);
    expect(activated![0]).toMatch(/WHERE stripe_subscription_id = \$1/);
    // Proration invoices fire this event too — period must NOT be written here.
    expect(activated![0]).not.toMatch(/current_period_end/);
    expect(activated![1]).toEqual(['sub_123']);
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
