import Stripe from 'stripe';
import { Pool } from 'pg';
import { getPool } from '../../shared/db/db.js';
import { safeRollback } from '../../shared/db/txn.js';
import { sendSubscriptionConfirmationEmail, sendPaymentFailedEmail, sendFoundingWelcomeEmail, sendDisputeAlertEmail } from '../../shared/email/email.service.js';
import { getPlatformSettings, publicCache, invalidatePublicBusinessData } from '../../shared/cache/cache.js';
import { nextCampaignOpensNy, lastChargeAtNy, CHARGE_DAY_OF_MONTH } from '../../shared/dates.js';
import { FOUNDING_TERM_MONTHS, FOUNDING_RENEWAL_TERM_MONTHS, FOUNDING_MONTHLY_PRICE_PER_LOCATION, FOUNDING_PRICE_PER_LOCATION, FOUNDING_ENTRIES_PER_LOCATION } from '../../shared/founding.js';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is not configured — refusing to start the Stripe client.');
// Pin the API version explicitly (matches the SDK v21 default the code is typed against and
// the version live-tested against) so a future SDK bump can't silently move field shapes.
// Changing this is now a deliberate, reviewable edit - not a side effect of `npm install`.
const stripe = new Stripe(stripeSecretKey, { apiVersion: '2026-03-25.dahlia' });

// ─── Get Business For Checkout ────────────────────────────────────────────────

export const getBusinessForCheckout = async (userId: number): Promise<{ id: number; email: string } | null> => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT b.id, u.email FROM business b JOIN "user" u ON u.id = b.user_id WHERE b.user_id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
};

// ─── Tier Price Map (SINGLE SOURCE OF TRUTH for tier prices) ──────────────────
// One place for both the Stripe price id (envKey) AND the dollar amount per
// location per month. Regular subscriptions are monthly only (there is no yearly
// recurring checkout). IMPORTANT: each `price` MUST match its Stripe price object
// (Stripe is what actually charges the card). When a price changes, update the
// Stripe price object AND this map together — this is the only place the app
// stores prices, so the change propagates to fees and the client display.
export const TIER_PRICE_MAP: Record<number, { envKey: string; price: number; name: string }> = {
  1000: { envKey: 'STRIPE_PRICE_ID_1000', price: 250, name: 'Starter' },
  2500: { envKey: 'STRIPE_PRICE_ID_2500', price: 450, name: 'Growth' },  // most popular
  5000: { envKey: 'STRIPE_PRICE_ID_5000', price: 750, name: 'Pro' },
};

/**
 * Resolve a subscription's monthly fee (dollars) — the value stored as
 * `fee_at_entry`, which feeds prize-pool accounting. SINGLE SOURCE OF TRUTH is
 * TIER_PRICE_MAP, so every write-path (initial activation, plan change, location
 * sync) derives the fee the same way and they can never diverge.
 *
 * When the caller already has Stripe's live `unit_amount` in hand (no extra fetch),
 * we cross-check it against the map and log a CRITICAL alert on drift — the Stripe
 * price object and TIER_PRICE_MAP are supposed to stay aligned, so a mismatch is a
 * config bug ops must reconcile. We still return the map value (not throw): the
 * payment context already exists, and tearing it down over an internal pricing
 * discrepancy would be worse than recording the canonical value and alerting.
 */
export function resolveMonthlyFee(
  entriesPerLocation: number,
  quantity: number,
  stripeUnitAmountCents?: number | null,
): number {
  const qty = Math.max(1, quantity);
  const tier = TIER_PRICE_MAP[entriesPerLocation];
  if (!tier) {
    console.error(
      `[Stripe] CRITICAL: no TIER_PRICE_MAP entry for entries_per_location=${entriesPerLocation}; ` +
      `falling back to Stripe unit_amount for fee_at_entry.`,
    );
    return Math.round((stripeUnitAmountCents ?? 0) * qty) / 100;
  }
  const mapFee = tier.price * qty;
  if (stripeUnitAmountCents != null) {
    const stripeFee = Math.round(stripeUnitAmountCents * qty) / 100;
    if (Math.abs(stripeFee - mapFee) > 0.01) {
      console.error(
        `[Stripe] CRITICAL: fee drift for entries_per_location=${entriesPerLocation} qty=${qty} — ` +
        `TIER_PRICE_MAP=$${mapFee} but Stripe unit_amount implies $${stripeFee}. ` +
        `Align the Stripe price object with TIER_PRICE_MAP; recording the map value.`,
      );
    }
  }
  return mapFee;
}

// ─── Charged-But-Not-Opened Window ────────────────────────────────────────────
// Subscriptions bill on the 24th; each charge pays for the NEXT campaign, which opens on
// the 1st. Between the charge and that open there is a window where the upcoming campaign
// is already paid for. Inside it, any config change (tier, locations, a late signup) must
// settle money immediately - charge the difference or refund it - because the 24th already
// billed the old configuration. Outside it, no money moves: the next 24th simply bills the
// new configuration. Detected as "the most recent charge moment is later than the moment
// the current Open campaign opened" (also true if no campaign is open at all).
export async function isChargedNotOpenedWindow(pool: Pool): Promise<boolean> {
  const res = await pool.query(`
    SELECT
      (SELECT opened_at FROM draw WHERE status = 'Open' ORDER BY opened_at DESC NULLS LAST LIMIT 1) AS open_opened_at,
      EXISTS(SELECT 1 FROM draw) AS any_draw
  `);
  const openedAt: Date | null = res.rows[0]?.open_opened_at ?? null;
  const anyDraw: boolean = res.rows[0]?.any_draw ?? false;
  // No campaigns exist at all (platform's first month, nothing created yet): there is no
  // "already-paid upcoming campaign" to settle against, so this is NOT the window — the
  // normal 24th cycle and open-time enrollment handle the business.
  if (!anyDraw) return false;
  // A draw exists but none is Open (between a close and the next open): the last charge
  // paid for the campaign about to open, so we are inside the window.
  if (!openedAt) return true;
  // A campaign is Open: in-window only if the most recent charge is newer than that open.
  return lastChargeAtNy().getTime() > new Date(openedAt).getTime();
}

// ─── Money Settlement Helpers (24th-to-open window) ───────────────────────────

// Charge `amountDollars` right now against the customer's default card, attached to the
// subscription so renewal webhooks (payment_succeeded / payment_failed) map it back to the
// business. Returns true if paid. Idempotency keys make the webhook + verify-page double
// call safe: Stripe returns the same invoice instead of charging twice.
//
// `kind` is stamped on the invoice metadata and drives the failure semantics:
//  - 'signup_charge' (voidOnFailure=false): the invoice stays open and Stripe retries it;
//    invoice.payment_succeeded later flips the business Active (recovery path).
//  - 'settlement' (voidOnFailure=true): a failed plan/location change is aborted entirely,
//    so the invoice is VOIDED - no retries, and invoice.payment_failed ignores it (the
//    business's campaign payment is fine; only the change was rejected).
async function chargeNow(
  customerId: string,
  subscriptionId: string,
  amountDollars: number,
  description: string,
  idempotencyTag: string,
  kind: 'signup_charge' | 'settlement',
): Promise<boolean> {
  const voidOnFailure = kind === 'settlement';
  // A customer-level pending invoice item. If the invoice.create below fails (network,
  // 5xx), this item is left pending and Stripe would sweep it into the NEXT renewal invoice
  // — a silent overcharge. So we track its id and delete it if the invoice never forms.
  const item = await stripe.invoiceItems.create(
    { customer: customerId, amount: Math.round(amountDollars * 100), currency: 'usd', description },
    { idempotencyKey: `winnbell_item_${idempotencyTag}` },
  );
  let draft: Stripe.Invoice;
  try {
    draft = await stripe.invoices.create(
      { customer: customerId, subscription: subscriptionId, description, auto_advance: !voidOnFailure, metadata: { winnbell_kind: kind } },
      { idempotencyKey: `winnbell_inv_${idempotencyTag}` },
    );
  } catch (createErr: unknown) {
    if (item.id) {
      try { await stripe.invoiceItems.del(item.id); }
      catch (delErr: unknown) {
        console.error(`[Stripe] CRITICAL: orphaned invoice item ${item.id} could not be deleted after invoice.create failed — it may be swept into the next renewal:`, delErr instanceof Error ? delErr.message : delErr);
      }
    }
    throw createErr;
  }
  if (!draft.id) throw new Error('Stripe did not return an invoice id');
  let invoice = draft;
  if (invoice.status === 'draft') {
    try {
      invoice = await stripe.invoices.finalizeInvoice(draft.id);
    } catch (finalizeErr: unknown) {
      // A retried idempotent create can return a draft that was meanwhile voided/finalized
      // out-of-band (e.g. manually in the dashboard after a crash). Treat "no longer
      // editable" as a failed charge instead of corrupting the caller's billing state.
      const code = (finalizeErr as { code?: string })?.code;
      if (code === 'invoice_no_longer_editable' || code === 'invoice_not_editable') {
        console.error(`[Stripe] invoice ${draft.id} not finalizable (voided out-of-band?) — treating charge as failed`);
        return false;
      }
      throw finalizeErr;
    }
  }
  if (invoice.status === 'paid') return true;
  if (invoice.status === 'open') {
    try {
      const paid = await stripe.invoices.pay(draft.id);
      return paid.status === 'paid';
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'invoice_already_paid') return true;
      console.error(`[Stripe] immediate charge not paid (${description}):`, err instanceof Error ? err.message : err);
      if (voidOnFailure) {
        try {
          await stripe.invoices.voidInvoice(draft.id);
        } catch (voidErr: unknown) {
          console.error(`[Stripe] failed to void settlement invoice ${draft.id}:`, voidErr instanceof Error ? voidErr.message : voidErr);
        }
      }
      return false;
    }
  }
  return false;
}

// Refund `amountDollars` of what was already paid for the upcoming campaign, drawing from
// the subscription's most recent paid invoices (newest first). Money rule: never refund
// more than was ACTUALLY paid. If the shortfall exists because nothing was truly paid
// ($0 invoices from credits/coupons), proceed without the missing part — no refund is
// owed. But if paid invoices exist whose payments we could not access (structural / API
// shape issue), throw so the change aborts instead of silently skipping an owed refund.
// Resolve an invoice's PaymentIntent id across Stripe API versions. Pre-2025 ("acacia")
// exposed `invoice.payment_intent`; the 2025 "Basil" API removed it and moved the payment
// under `invoice.payments.data[].payment.payment_intent`. Read the new shape first, fall
// back to the legacy field, so refunds keep working on either.
export function invoicePaymentIntentId(invoice: Stripe.Invoice): string | undefined {
  const payments = (invoice as unknown as {
    payments?: { data?: Array<{ payment?: { payment_intent?: string | { id?: string } | null } }> };
  }).payments;
  const fromPayments = payments?.data
    ?.map((p) => p.payment?.payment_intent)
    .map((pi) => (typeof pi === 'string' ? pi : pi?.id))
    .find(Boolean);
  if (fromPayments) return fromPayments;
  const legacy = (invoice as unknown as { payment_intent?: string | { id?: string } | null }).payment_intent;
  return typeof legacy === 'string' ? legacy : legacy?.id;
}

async function refundUpcomingCampaignDelta(subscriptionId: string, amountDollars: number, reason: string): Promise<void> {
  let remainingCents = Math.round(amountDollars * 100);
  let inaccessiblePaidInvoice = false;
  // Expand payments so the PaymentIntent is available under the Basil API shape (the top-level
  // invoice.payment_intent field no longer exists).
  const invoices = await stripe.invoices.list({ subscription: subscriptionId, status: 'paid', limit: 10, expand: ['data.payments'] });
  for (const invoice of invoices.data) {
    if (remainingCents <= 0) break;
    if ((invoice.amount_paid ?? 0) <= 0) continue; // nothing was paid — nothing to refund
    const paymentIntentId = invoicePaymentIntentId(invoice);
    if (!paymentIntentId) { inaccessiblePaidInvoice = true; continue; }
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const charge = pi.latest_charge as Stripe.Charge | null;
    if (!charge || typeof charge === 'string') { inaccessiblePaidInvoice = true; continue; }
    const available = charge.amount - charge.amount_refunded;
    if (available <= 0) continue;
    const refundCents = Math.min(available, remainingCents);
    // Deterministic idempotency key: a retry / double-submit of the same location-removal or
    // plan-downgrade refunds the same amount against the same PaymentIntent, so Stripe dedupes
    // it instead of issuing a second refund (real money loss). Keyed on (PI, amount) so distinct
    // legitimate refunds still go through.
    await stripe.refunds.create(
      { payment_intent: paymentIntentId, amount: refundCents, metadata: { reason } },
      { idempotencyKey: `winnbell_refund_${paymentIntentId}_${refundCents}` },
    );
    remainingCents -= refundCents;
  }
  if (remainingCents > 0 && !inaccessiblePaidInvoice) {
    // Genuine shortfall: the business never paid this much for the upcoming campaign, so
    // the un-refundable part is not owed. Proceed with the change.
    console.warn(`[Stripe] refund shortfall for ${reason}: $${(remainingCents / 100).toFixed(2)} was never actually paid — nothing further to refund.`);
    remainingCents = 0;
  }
  if (remainingCents > 0) {
    throw new Error(`REFUND_INCOMPLETE: could not refund remaining $${(remainingCents / 100).toFixed(2)} for ${reason}`);
  }
}

// ─── Founding Member: Transition Window ───────────────────────────────────────
// A founding membership is a one-time payment with no Stripe subscription behind it, so
// nothing ever flips its status off 'Active' — the term "ends" purely as a date. Founders
// are in EVERY campaign that OPENS before their term ends, so their final included campaign
// is the last one to open inside the term. From that month onward (term ends before the
// next campaign opens — and forever after expiry) they may start a regular plan. Subscribing
// inside this window puts them in that next campaign with no gap: the new subscription bills
// on the last day of this month, which pays for next month's campaign.
export function isFoundingTransitionWindow(currentPeriodEnd: Date): boolean {
  return currentPeriodEnd.getTime() < nextCampaignOpensNy().getTime();
}

// Founding term lengths AND the per-location price live in shared/founding.ts
// (single source of truth, shared with email.service without a circular import).
// Re-exported here so existing importers keep working.
// The location set is FIXED at purchase: founding members can edit their locations but
// not add or remove them (deliberate simplification over prorated mid-term billing).
export { FOUNDING_TERM_MONTHS, FOUNDING_RENEWAL_TERM_MONTHS, FOUNDING_MONTHLY_PRICE_PER_LOCATION, FOUNDING_PRICE_PER_LOCATION, FOUNDING_ENTRIES_PER_LOCATION };

export const FOUNDING_PRICE_PER_LOCATION_CENTS = FOUNDING_PRICE_PER_LOCATION * 100;

// ─── Founding Member: Checkout Session ────────────────────────────────────────

export const createFoundingMemberCheckoutSession = async (
  businessId: number,
  userEmail: string,
): Promise<{ url: string }> => {
  const pool = getPool();

  const settings = await getPlatformSettings();
  if (!settings?.founding_phase_active) throw new Error('Founding partner program is not currently active');

  const cap = settings.founding_member_cap as number;
  const countResult = await pool.query(`SELECT COUNT(*)::int AS taken FROM founding_member`);
  const taken = countResult.rows[0]?.taken ?? 0;
  if (taken >= cap) throw new Error('All founding partner spots have been claimed');

  const existing = await pool.query(
    `SELECT id FROM subscription WHERE business_id = $1 AND status != 'Cancelled'`,
    [businessId],
  );
  if (existing.rows.length > 0) throw new Error('This business already has an active subscription');

  // Founding is priced PER LOCATION (FOUNDING_PRICE_PER_LOCATION x N for the whole term,
  // no location limit). The location count is the same next-campaign count the regular
  // plans bill by; it is stamped into the session metadata so activation records exactly
  // what was paid for.
  const locCount = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM business_location
     WHERE business_id = $1
       AND ((is_active = TRUE AND deactivate_at_open = FALSE) OR activate_at_open = TRUE)`,
    [businessId],
  );
  const locationCount = Math.max(1, Number(locCount.rows[0]?.cnt ?? 0));

  const priceCents = FOUNDING_PRICE_PER_LOCATION_CENTS;
  const priceLabel = `$${FOUNDING_PRICE_PER_LOCATION.toLocaleString('en-US')}`;

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:8081';

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: userEmail,
    customer_creation: 'always',
    line_items: [{
      quantity: locationCount,
      price_data: {
        currency: 'usd',
        unit_amount: priceCents,
        product_data: {
          name: 'Founding Partner - Winnbell',
          description: `One-time membership for the full founding term. ${priceLabel} per location. 2,500 entries per location per month.`,
        },
      },
    }],
    metadata: { business_id: String(businessId), founding: 'true', locations: String(locationCount) },
    // Stamp the PaymentIntent too so the one-time charge is findable in the Stripe
    // dashboard by business_id (Checkout metadata does not propagate to the PI).
    payment_intent_data: { metadata: { business_id: String(businessId), founding: 'true' } },
    success_url: `${baseUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/subscribe`,
  });

  return { url: session.url as string };
};

// ─── Founding: Second-Year Renewal (Special Terms Section 6) ──────────────────
// In the FINAL 30 days of the founding term the partner may renew for ONE additional
// FOUNDING_RENEWAL_TERM_MONTHS term at the ORIGINAL MONTHLY RATE (rate x 12 months).
// Renewal is a separate explicit checkout (never auto-charged, per the Special Terms)
// and extends current_period_end by 12 months FROM the existing term end, so renewing
// early loses no time.

export const FOUNDING_RENEWAL_WINDOW_DAYS = 30;

// Shared by the renewal checkout guard AND getSubscriptionDetails (which serves
// founding_renewal_open to the client banner) so the banner and the server guard
// can never disagree - same pattern as founding_transition_available.
export function foundingRenewalWindowState(periodEnd: Date, now: Date = new Date()): 'not_open' | 'open' | 'expired' {
  // Millisecond arithmetic on purpose (do NOT "simplify" to setDate/getDate: those
  // operate in the host timezone and would shift the window across DST boundaries).
  const windowOpenMs = periodEnd.getTime() - FOUNDING_RENEWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (now.getTime() < windowOpenMs) return 'not_open';
  if (now.getTime() > periodEnd.getTime()) return 'expired';
  return 'open';
}

// Renewal price = the member's ORIGINAL MONTHLY RATE x the renewal term length.
// The founding offer is a monthly rate ($100/location/month); the initial purchase
// charges rate x FOUNDING_TERM_MONTHS, the renewal charges rate x
// FOUNDING_RENEWAL_TERM_MONTHS (e.g. $300/location for 3 months, then $1,200/location
// for the 12-month renewal). The rate snapshot is subscription.fee_at_entry (set at
// activation as amount_paid / term months); fall back to deriving it from amount_paid
// for any row missing fee_at_entry. Shared by the renewal checkout AND
// getSubscriptionDetails (founding_renewal_price) so display and charge never disagree.
export function foundingRenewalAmountCents(feeAtEntry: number | string | null, amountPaid: number | string): number {
  const monthlyCents = feeAtEntry != null && Number(feeAtEntry) > 0
    ? Math.round(Number(feeAtEntry) * 100)
    : Math.round((Number(amountPaid) * 100) / FOUNDING_TERM_MONTHS);
  return monthlyCents * FOUNDING_RENEWAL_TERM_MONTHS;
}

export const createFoundingRenewalCheckoutSession = async (userId: number): Promise<{ url: string }> => {
  const pool = getPool();

  const res = await pool.query(`
    SELECT b.id AS business_id, u.email, fm.amount_paid, fm.renewed_at, s.current_period_end, s.fee_at_entry
    FROM business b
    JOIN "user" u ON u.id = b.user_id
    JOIN founding_member fm ON fm.business_id = b.id
    JOIN subscription s ON s.business_id = b.id
    WHERE b.user_id = $1 AND s.status = 'Active'
  `, [userId]);
  const row = res.rows[0];
  if (!row) throw new Error('No active founding membership found');

  // ONE-TIME option: after the single renewal is used, the founding price is gone -
  // when the renewed term ends the business subscribes through the regular plans.
  if (row.renewed_at) throw new Error('RENEWAL_ALREADY_USED');

  const windowState = foundingRenewalWindowState(new Date(row.current_period_end));
  if (windowState === 'not_open') throw new Error('RENEWAL_NOT_OPEN');
  if (windowState === 'expired') throw new Error('RENEWAL_EXPIRED');

  // Monthly rate snapshot x the 12-month renewal term (NOT the 3-month initial total).
  const amountCents = foundingRenewalAmountCents(row.fee_at_entry, row.amount_paid);
  if (amountCents < 50) throw new Error('RENEWAL_AMOUNT_INVALID');

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:8081';
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: row.email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: amountCents,
        product_data: {
          name: 'Founding Partner Renewal - Winnbell',
          description: `One additional ${FOUNDING_RENEWAL_TERM_MONTHS}-month term at your original Founding Partner monthly rate.`,
        },
      },
    }],
    metadata: { business_id: String(row.business_id), founding_renewal: 'true' },
    payment_intent_data: { metadata: { business_id: String(row.business_id), founding_renewal: 'true' } },
    success_url: `${baseUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}&purpose=frenew`,
    cancel_url: `${baseUrl}/subscription/manage`,
  });

  return { url: session.url as string };
};

// Payment landed (verify or webhook): ledger the renewal and extend the term.
export const activateFoundingRenewal = async (pool: Pool, session: Stripe.Checkout.Session): Promise<void> => {
  const businessId = Number(session.metadata?.business_id);
  const paymentIntentId = session.payment_intent as string;
  if (!businessId || !paymentIntentId) throw new Error('founding_renewal session missing metadata');
  // A paid payment-mode session always carries amount_total. Failing loudly (webhook
  // retries) beats ledgering $0 for money that was actually collected.
  if (session.amount_total == null || session.amount_total < 50) throw new Error('founding_renewal session has invalid amount_total');
  const amountDollars = session.amount_total / 100;

  // All three writes commit or roll back TOGETHER. Without the transaction, a crash
  // after the ledger insert would consume the idempotency slot with the term never
  // extended - money collected, no retry able to recover it.
  const client = await pool.connect();
  let duplicate = false;
  let newEnd: Date | null = null;
  try {
    await client.query('BEGIN');

    // Idempotency (webhook + verify double call): the ledger's unique payment intent
    // is the claim - only the first caller proceeds.
    const ledger = await client.query(
      `INSERT INTO founding_payment (business_id, stripe_payment_intent_id, stripe_checkout_session_id, amount)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
      [businessId, paymentIntentId, session.id, amountDollars],
    );
    if ((ledger.rowCount ?? 0) === 0) {
      await safeRollback(client);
      return;
    }

    // ONE-TIME guard at ACTIVATION time, not just session creation: two renewal
    // checkouts can both be created while renewed_at is still NULL (two tabs, or a
    // stale Stripe page paid after the first renewal). The WHERE renewed_at IS NULL
    // claim is atomic - only ONE distinct payment ever extends the term; any other
    // paid renewal session is ledgered as refunded here and refunded after commit.
    // Also covers a founding row that vanished (0 rows -> refund, never extend).
    const claim = await client.query(
      `UPDATE founding_member SET renewed_at = NOW(), updated_at = NOW()
       WHERE business_id = $1 AND renewed_at IS NULL
       RETURNING id`,
      [businessId],
    );
    if ((claim.rowCount ?? 0) === 0) {
      await client.query(
        `UPDATE founding_payment SET refunded_amount = amount WHERE stripe_payment_intent_id = $1`,
        [paymentIntentId],
      );
      await client.query('COMMIT');
      duplicate = true;
    } else {
      // participation_paused resets too: paying for a renewal is an explicit
      // recommitment to participate - a pre-renewal cancel no longer reflects intent.
      const upd = await client.query(
        `UPDATE subscription
         SET current_period_end = current_period_end + make_interval(months => $2),
             status = 'Active',
             cancel_at_period_end = false,
             participation_paused = false,
             updated_at = NOW()
         WHERE business_id = $1
         RETURNING current_period_end`,
        [businessId, FOUNDING_RENEWAL_TERM_MONTHS],
      );
      newEnd = upd.rows[0]?.current_period_end ?? null;
      await client.query('COMMIT');
    }
  } catch (err: unknown) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }

  if (duplicate) {
    // Stripe call stays OUTSIDE the transaction (never hold a DB tx open across a
    // network call). If the refund fails, the ledger slot is already committed so a
    // webhook retry cannot reach this branch again - the CRITICAL log is the signal
    // to refund manually in the Stripe dashboard.
    try {
      await stripe.refunds.create({ payment_intent: paymentIntentId });
      console.warn(`[Founding] Duplicate renewal payment for business ${businessId} (pi ${paymentIntentId}) - refunded in full`);
    } catch (refundErr: unknown) {
      const code = (refundErr as { code?: string })?.code;
      if (code !== 'charge_already_refunded') {
        console.error(`[Founding] CRITICAL: duplicate renewal refund FAILED for business ${businessId} (pi ${paymentIntentId}) - refund manually:`, refundErr instanceof Error ? refundErr.message : refundErr);
      }
    }
    return;
  }

  console.log(`[Founding] Business ${businessId} renewed for another term ($${amountDollars}); term now ends ${newEnd?.toISOString?.() ?? newEnd}`);
  invalidatePublicBusinessData();

  // Confirmation email with the new term end - non-fatal (renewal is already committed).
  try {
    const biz = await pool.query(`
      SELECT b.name, u.email,
             (SELECT COUNT(*)::int FROM business_location bl WHERE bl.business_id = b.id AND bl.is_active = TRUE) AS locs
      FROM business b JOIN "user" u ON u.id = b.user_id WHERE b.id = $1
    `, [businessId]);
    if (biz.rows[0]?.email && newEnd) {
      await sendFoundingWelcomeEmail(biz.rows[0].email, biz.rows[0].name, {
        termEnd: new Date(newEnd),
        amountPaid: amountDollars,
        locationCount: Math.max(1, Number(biz.rows[0].locs ?? 1)),
        termMonths: FOUNDING_RENEWAL_TERM_MONTHS,
        isRenewal: true,
      });
    }
  } catch (err: unknown) {
    console.error(`[Founding] Renewal email failed for business ${businessId} (non-fatal):`, err instanceof Error ? err.message : err);
  }
};

// ─── Founding Member: Count / Availability ────────────────────────────────────

interface FoundingAvailability {
  taken: number; remaining: number; cap: number; active: boolean;
  price: number; monthlyPrice: number; termMonths: number; renewalTermMonths: number;
  entriesPerLocation: number;
}

export const getFoundingMemberCount = async (): Promise<FoundingAvailability> => {
  const CACHE_KEY = 'founding:availability';
  const cached = publicCache.get<FoundingAvailability>(CACHE_KEY);
  if (cached !== undefined) return cached;

  const pool = getPool();
  const [settings, countResult] = await Promise.all([
    getPlatformSettings(),
    pool.query(`SELECT COUNT(*)::int AS taken FROM founding_member`),
  ]);
  const taken = countResult.rows[0]?.taken ?? 0;
  const cap = settings.founding_member_cap ?? 30;
  const active = settings.founding_phase_active ?? true;
  // Price + term lengths ride along so ALL founding copy/math on the client derives
  // from one source (the shared/founding.ts constants).
  const value: FoundingAvailability = {
    taken, remaining: Math.max(0, cap - taken), cap, active,
    price: FOUNDING_PRICE_PER_LOCATION,
    monthlyPrice: FOUNDING_MONTHLY_PRICE_PER_LOCATION,
    termMonths: FOUNDING_TERM_MONTHS,
    renewalTermMonths: FOUNDING_RENEWAL_TERM_MONTHS,
    entriesPerLocation: FOUNDING_ENTRIES_PER_LOCATION,
  };
  publicCache.set(CACHE_KEY, value, 60);
  return value;
};

// ─── Create Checkout Session ──────────────────────────────────────────────────

export const createCheckoutSession = async (
  businessId: number,
  userEmail: string,
  entriesPerLocation: number,
): Promise<{ url: string }> => {
  const tier = TIER_PRICE_MAP[entriesPerLocation];
  if (!tier) throw new Error('Invalid entries_per_location value');

  const priceId = process.env[tier.envKey];
  if (!priceId) throw new Error(`${tier.envKey} is not configured`);

  const pool = getPool();
  // Block a second subscription — EXCEPT for a founding member inside the transition
  // window (their prepaid term no longer covers the next campaign, or already ended).
  // Their row stays 'Active' forever because no Stripe subscription backs it, so a plain
  // status check would lock them out of ever subscribing again.
  const existing = await pool.query(
    `SELECT s.stripe_subscription_id, s.current_period_end,
            EXISTS(SELECT 1 FROM founding_member fm WHERE fm.business_id = s.business_id) AS is_founding
     FROM subscription s
     WHERE s.business_id = $1 AND s.status != 'Cancelled'`,
    [businessId],
  );
  const existingSub = existing.rows[0];
  if (existingSub) {
    const foundingInTransition =
      existingSub.is_founding &&
      !existingSub.stripe_subscription_id &&
      existingSub.current_period_end &&
      isFoundingTransitionWindow(new Date(existingSub.current_period_end));
    if (!foundingInTransition) throw new Error('This business already has an active subscription');
  }

  // Next-campaign location count (live minus scheduled removals plus staged adds) — the
  // same formula every other billing site uses. A founding member transitioning to a
  // regular plan may have staged-add locations; counting only is_active would undercount
  // the quantity billed and the fee staged for their first regular campaign.
  const locResult = await pool.query(
    `SELECT COUNT(*) AS cnt FROM business_location
     WHERE business_id = $1
       AND ((is_active = true AND deactivate_at_open = false) OR activate_at_open = true)`,
    [businessId],
  );
  const locationCount = Math.max(1, Number(locResult.rows[0]?.cnt ?? 1));

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:8081';

  // Setup mode: collect + save a card without charging at checkout. The subscription
  // itself is created server-side (createSubscriptionForSetupSession) so we can anchor
  // billing to the 24th of the month and, for signups after the 24th, charge the upcoming
  // campaign immediately — neither of which Checkout's subscription mode allows.
  const planMetadata = {
    business_id: String(businessId),
    entries_per_location: String(entriesPerLocation),
    billing_interval: 'monthly',
    price_id: priceId,
    quantity: String(locationCount),
  };

  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    payment_method_types: ['card'],
    customer_email: userEmail,
    customer_creation: 'always',
    setup_intent_data: { metadata: planMetadata },
    metadata: planMetadata,
    success_url: `${baseUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/subscribe`,
  });

  return { url: session.url as string };
};

// ─── Verify Session ───────────────────────────────────────────────────────────

// Returns the resulting subscription status so the success page can tell the truth when the
// in-window signup charge was DECLINED (business stored Incomplete, NOT enrolled at open).
// null = branches with no recurring subscription involved (founding payment, card update).
export const verifyAndActivateSession = async (
  sessionId: string,
  userId: number,
): Promise<{ subscriptionStatus: 'Active' | 'Incomplete' | null }> => {
  const pool = getPool();

  const bizResult = await pool.query(`SELECT id FROM business WHERE user_id = $1`, [userId]);
  const businessId = bizResult.rows[0]?.id;
  if (!businessId) throw new Error('Business not found');

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.metadata?.business_id !== String(businessId)) throw new Error('Session does not belong to this business');

  // ── Founding member one-time payment branch ────────────────────────────────
  if (session.mode === 'payment' && session.metadata?.founding === 'true') {
    if (session.payment_status !== 'paid') throw new Error('Payment not completed');
    const paymentIntentId = session.payment_intent as string;
    const customerId = (session.customer as string | null) ?? null;
    // Per-location pricing: amount + location count come off the session itself. A paid
    // session always has amount_total; failing loudly beats snapshotting a wrong amount
    // (the snapshot drives the member's renewal price).
    if (session.amount_total == null || session.amount_total < 50) throw new Error('founding session has invalid amount_total');
    const amountPaidDollars = session.amount_total / 100;
    const locationCount = Math.max(1, Number(session.metadata?.locations ?? 1));
    await activateFoundingMember(pool, businessId, paymentIntentId, sessionId, customerId, amountPaidDollars, locationCount);
    invalidatePublicBusinessData();
    return { subscriptionStatus: null };
  }

  // ── Founding second-year renewal branch ─────────────────────────────────────
  if (session.mode === 'payment' && session.metadata?.founding_renewal === 'true') {
    if (session.payment_status !== 'paid') throw new Error('Payment not completed');
    await activateFoundingRenewal(pool, session);
    return { subscriptionStatus: null };
  }

  // ── Update payment method branch (setup mode with an existing customer) ─────
  if (session.mode === 'setup' && session.metadata?.purpose === 'update_payment_method') {
    if (session.status !== 'complete') throw new Error('Setup not completed');
    await handleUpdatePaymentMethodSession(pool, session);
    return { subscriptionStatus: null };
  }

  // ── Recurring subscription branch (setup mode → server-created sub) ─────────
  if (session.mode === 'setup') {
    if (session.status !== 'complete') throw new Error('Setup not completed');
    const subscriptionStatus = await createSubscriptionForSetupSession(pool, session);
    return { subscriptionStatus };
  }

  throw new Error('Unrecognized checkout session');
};

// ─── Update Payment Method ────────────────────────────────────────────────────
// Self-serve card fix: a setup-mode Checkout on the EXISTING customer. On completion the
// new card becomes the default everywhere and any outstanding invoices are retried with
// it immediately — recovering a Past_Due/Incomplete business on the spot.

export const createUpdatePaymentMethodSession = async (userId: number): Promise<{ url: string }> => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT b.id AS business_id, s.stripe_customer_id, s.status
    FROM business b
    JOIN subscription s ON s.business_id = b.id
    WHERE b.user_id = $1
  `, [userId]);
  const sub = result.rows[0];
  if (!sub?.stripe_customer_id) throw new Error('No billing account found');
  if (sub.status === 'Cancelled') throw new Error('SUBSCRIPTION_CANCELLED');

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:8081';
  const meta = { business_id: String(sub.business_id), purpose: 'update_payment_method' };
  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    payment_method_types: ['card'],
    customer: sub.stripe_customer_id,
    metadata: meta,
    setup_intent_data: { metadata: meta },
    success_url: `${baseUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}&purpose=upm`,
    cancel_url: `${baseUrl}/subscription/manage`,
  });
  return { url: session.url as string };
};

// If a payment just recovered this business (Past_Due/Incomplete -> paid), flip it Active
// and enroll it into the currently Open campaign it paid for. Shared by the
// invoice.payment_succeeded webhook and the update-payment-method verify path (dev
// environments without webhook forwarding still recover instantly).
async function recoverBusinessAfterPayment(pool: Pool, businessId: number): Promise<void> {
  const flipped = await pool.query(
    `UPDATE subscription SET status = 'Active', updated_at = NOW()
     WHERE business_id = $1 AND status IN ('Past_Due', 'Incomplete')
     RETURNING business_id`,
    [businessId],
  );
  if ((flipped.rowCount ?? 0) === 0) return;
  await pool.query(`
    INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, cap_at_entry, min_transaction_at_entry)
    SELECT d.id, b.id, COALESCE(s.fee_at_entry, 0), s.entries_per_location, b.min_transaction_amount
    FROM draw d
    JOIN subscription s ON s.business_id = $1
    JOIN business b ON b.id = s.business_id
    WHERE d.status = 'Open'
      AND s.current_period_end >= NOW()
      AND s.skip_next_campaign = FALSE
      AND s.participation_paused = FALSE
    ON CONFLICT (draw_id, business_id) DO NOTHING
  `, [businessId]);
  invalidatePublicBusinessData();
  console.log(`[Stripe] Business ${businessId} recovered after payment method update`);
}

// Called by BOTH the webhook and the success-page verify; every step is idempotent.
async function handleUpdatePaymentMethodSession(pool: Pool, session: Stripe.Checkout.Session): Promise<void> {
  const businessId = Number(session.metadata?.business_id);
  if (!businessId) throw new Error('Update-payment session missing business_id');
  const customerId = session.customer as string;

  const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent as string);
  const paymentMethodId = (setupIntent.payment_method as string | null) ?? null;
  if (!paymentMethodId) throw new Error('Update-payment session has no payment method');

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  const subRow = await pool.query(
    `SELECT stripe_subscription_id FROM subscription WHERE business_id = $1`,
    [businessId],
  );
  const subscriptionId: string | null = subRow.rows[0]?.stripe_subscription_id ?? null;
  let anyPaid = false;
  if (subscriptionId) {
    try {
      await stripe.subscriptions.update(subscriptionId, { default_payment_method: paymentMethodId });
    } catch (err: unknown) {
      console.error('[Stripe] could not set subscription default payment method (non-fatal):', err instanceof Error ? err.message : err);
    }
    // Retry every outstanding invoice with the new card right now.
    const open = await stripe.invoices.list({ subscription: subscriptionId, status: 'open', limit: 10 });
    for (const inv of open.data) {
      if (!inv.id) continue;
      try {
        const paid = await stripe.invoices.pay(inv.id);
        if (paid.status === 'paid') anyPaid = true;
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'invoice_already_paid') { anyPaid = true; continue; }
        console.error(`[Stripe] retry of invoice ${inv.id} with new card failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
  if (anyPaid) {
    await recoverBusinessAfterPayment(pool, businessId);
  }
  console.log(`[Stripe] Business ${businessId} updated its payment method${anyPaid ? ' and settled outstanding invoices' : ''}`);
}

// ─── Create Subscription From a Completed Setup Session ───────────────────────
// After a setup-mode Checkout completes (card saved, no charge), create the
// recurring subscription billed on the LAST DAY of each month. Called by BOTH
// the webhook and the success-page verify; idempotent so it can never create two.
// Returns the status the subscription ends up in ('Incomplete' = in-window signup charge
// declined, business NOT enrolled at open) so the verify path can surface it to the client.
async function createSubscriptionForSetupSession(pool: Pool, session: Stripe.Checkout.Session): Promise<'Active' | 'Incomplete'> {
  const businessId = Number(session.metadata?.business_id);
  if (!businessId) throw new Error('Setup session missing business_id');

  // DB-level idempotency: a live subscription already exists for this business.
  // A founding membership (no Stripe subscription behind it) does NOT count — the
  // checkout guard only lets founding members reach setup mode inside their transition
  // window, and this new subscription is what replaces the founding one. After the
  // replacement the row has a stripe_subscription_id, so a duplicate webhook/verify
  // call still returns here.
  const existing = await pool.query(
    `SELECT s.stripe_subscription_id, s.status,
            EXISTS(SELECT 1 FROM founding_member fm WHERE fm.business_id = s.business_id) AS is_founding
     FROM subscription s
     WHERE s.business_id = $1 AND s.status != 'Cancelled'`,
    [businessId],
  );
  const existingSub = existing.rows[0];
  if (existingSub && !(existingSub.is_founding && !existingSub.stripe_subscription_id)) {
    // Duplicate webhook/verify call: report the already-stored outcome (the other caller
    // may have created it as Incomplete when the signup charge was declined).
    return existingSub.status === 'Incomplete' ? 'Incomplete' : 'Active';
  }

  const customerId = session.customer as string;
  const priceId = session.metadata?.price_id ?? '';
  const quantity = Math.max(1, Number(session.metadata?.quantity ?? 1));
  const entriesPerLocation = Number(session.metadata?.entries_per_location ?? 0);
  if (!customerId || !priceId) throw new Error('Setup session missing customer or price');

  // Payment method saved by the SetupIntent → make it the customer default.
  const setupIntent = await stripe.setupIntents.retrieve(session.setup_intent as string);
  const paymentMethodId = (setupIntent.payment_method as string | null) ?? null;
  if (paymentMethodId) {
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }

  // Anchor on the 24th (the platform charge day). proration_behavior 'none' → Stripe
  // itself charges nothing until the first 24th, and each charge pays for the NEXT
  // month's campaign.
  const subscription = await stripe.subscriptions.create(
    {
      customer: customerId,
      items: [{ price: priceId, quantity }],
      default_payment_method: paymentMethodId ?? undefined,
      billing_cycle_anchor_config: { day_of_month: CHARGE_DAY_OF_MONTH },
      proration_behavior: 'none',
      metadata: {
        business_id: String(businessId),
        entries_per_location: String(entriesPerLocation),
        billing_interval: 'monthly',
      },
    },
    { idempotencyKey: `winnbell_sub_${session.id}` },
  );

  const item = subscription.items.data[0];
  // fee_at_entry from TIER_PRICE_MAP (single source of truth), cross-checked against
  // the unit_amount Stripe just returned on the created subscription (no extra fetch).
  const monthlyFee = resolveMonthlyFee(entriesPerLocation, item?.quantity ?? quantity, item?.price.unit_amount);
  const currentPeriodEnd = extractPeriodEnd(subscription);

  // Signup between the 24th and the campaign open: the 24th charge already ran without
  // them, so their upcoming campaign is paid RIGHT NOW at full price (a campaign is
  // all-or-nothing — same product, same price, regardless of signup day). Their first
  // recurring charge on the next 24th then pays for the campaign after. If the immediate
  // charge fails, the business activates as Incomplete: it is NOT enrolled at open, and
  // Stripe's retries (or a later manual payment) flip it Active via invoice webhooks.
  let initialStatus: 'Active' | 'Incomplete' = 'Active';
  let chargedToday = false;
  if (await isChargedNotOpenedWindow(pool)) {
    const paid = await chargeNow(
      customerId,
      subscription.id,
      monthlyFee,
      'Payment for the upcoming campaign',
      session.id,
      'signup_charge',
    );
    if (!paid) initialStatus = 'Incomplete';
    else chargedToday = true;
  }

  await activateBusinessSubscription(pool, businessId, subscription.id, customerId, priceId, currentPeriodEnd, monthlyFee, entriesPerLocation, initialStatus, chargedToday);
  invalidatePublicBusinessData();
  return initialStatus;
}

// ─── Handle Webhook ───────────────────────────────────────────────────────────

export const handleStripeWebhook = async (rawBody: Buffer, signature: string): Promise<void> => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured — cannot verify webhook signatures.');

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err: unknown) {
    throw new Error(`Webhook signature verification failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  const pool = getPool();

  // Idempotency: atomic INSERT before processing — prevents race conditions
  // on concurrent webhook delivery. If the row already exists, skip.
  const claimed = await pool.query(
    'INSERT INTO stripe_webhook_event (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
    [event.id, event.type],
  );
  if (claimed.rowCount === 0) return;

  try {
    await processStripeEvent(event, pool);
  } catch (err) {
    // Release the idempotency claim so Stripe's retry can re-process this event.
    // Without this, a transient failure would leave the claim row behind and the
    // retry would be skipped — the event (e.g. a paid checkout) lost forever.
    try {
      await pool.query('DELETE FROM stripe_webhook_event WHERE event_id = $1', [event.id]);
    } catch (releaseErr: unknown) {
      console.error(
        `[Stripe] CRITICAL: failed to release webhook claim for ${event.id} (${event.type}) — retries will be skipped, manual replay needed:`,
        releaseErr instanceof Error ? releaseErr.message : releaseErr,
      );
    }
    throw err;
  }
};

// Retention: idempotency claims only need to outlive Stripe's retry window (~3 days;
// manual replays up to 30). Purge older rows so the table never grows unbounded.
// Wired into the 6-hourly cleanup interval in server.ts alongside refresh tokens.
export const cleanupOldWebhookEvents = async (): Promise<void> => {
  const pool = getPool();
  await pool.query(`DELETE FROM stripe_webhook_event WHERE processed_at < NOW() - INTERVAL '30 days'`);
};

// ─── Reconcile local subscriptions against Stripe (lost-webhook self-healing) ──
//
// Webhooks are the primary sync mechanism, but a delivery can be lost for good when the
// server is down past Stripe's retry window (it has happened). Without healing, a business
// whose invoice.payment_succeeded was lost stays Past_Due locally forever and silently
// misses every campaign open even though Stripe collected the money. This job re-reads
// every Stripe-backed subscription row and heals status / current_period_end /
// cancel_at_period_end from Stripe's current state:
//   - Past_Due/Incomplete row that Stripe shows paid -> same recovery path as the webhook
//     (recoverBusinessAfterPayment: flip Active + enroll into the currently Open campaign).
//   - Row whose Stripe subscription is gone (resource_missing) -> Cancelled.
//   - Cancelled row that Stripe shows alive -> resurrected (the retrieve is by OUR stored
//     subscription id, so this only ever restores state a stale event wrongly destroyed).
// Founding rows (stripe_subscription_id IS NULL) have no Stripe object and are skipped.
// Runs sequentially - the subscription table holds one row per business, so volume is low.
let reconcileInFlight = false;
export const reconcileSubscriptionsWithStripe = async (): Promise<{ checked: number; healed: number }> => {
  if (reconcileInFlight) return { checked: 0, healed: 0 };
  reconcileInFlight = true;
  try {
    const pool = getPool();
    const local = await pool.query(
      `SELECT business_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end
       FROM subscription
       WHERE stripe_subscription_id IS NOT NULL`,
    );

    let healed = 0;
    for (const row of local.rows) {
      try {
        let stripeStatus: string;
        let periodEnd: Date | null = null;
        let cancelAtPeriodEnd: boolean = row.cancel_at_period_end;
        try {
          const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
          stripeStatus = mapStripeStatus(sub.status);
          periodEnd = extractPeriodEnd(sub);
          cancelAtPeriodEnd = sub.cancel_at_period_end;
        } catch (err: unknown) {
          if ((err as { code?: string })?.code === 'resource_missing') {
            // Deleted at Stripe and we never saw the event - the local row is a ghost.
            stripeStatus = 'Cancelled';
          } else {
            throw err;
          }
        }

        const periodDrift = periodEnd !== null && (
          row.current_period_end == null ||
          Math.abs(periodEnd.getTime() - new Date(row.current_period_end).getTime()) > 1000 ||
          cancelAtPeriodEnd !== row.cancel_at_period_end
        );
        if (stripeStatus === row.status && !periodDrift) continue;

        healed++;
        console.warn(
          `[Stripe reconcile] business ${row.business_id}: healing local ` +
          `(${row.status}) from Stripe (${stripeStatus})`,
        );

        // Period fields first, so the recovery enrollment guard below sees the paid period.
        // When the cancel flips true -> false here (dashboard un-cancel, or a resume whose
        // DB write was lost), an immediate-removal pause no longer reflects intent - clear
        // it in the same statement or the business would PAY while stuck off the map.
        // The CASE reads the OLD row value, so an independently set pause is untouched.
        if (periodEnd !== null) {
          await pool.query(
            `UPDATE subscription
             SET current_period_end = $2,
                 participation_paused = CASE WHEN cancel_at_period_end = true AND $3 = false THEN false ELSE participation_paused END,
                 cancel_at_period_end = $3,
                 updated_at = NOW()
             WHERE business_id = $1 AND stripe_subscription_id = $4`,
            [row.business_id, periodEnd, cancelAtPeriodEnd, row.stripe_subscription_id],
          );
        }

        if (stripeStatus === 'Active' && (row.status === 'Past_Due' || row.status === 'Incomplete')) {
          // Missed invoice.payment_succeeded: full recovery, including enrollment into the
          // currently Open campaign the payment was for (idempotent ON CONFLICT inside).
          await recoverBusinessAfterPayment(pool, row.business_id);
        } else if (stripeStatus !== row.status) {
          await pool.query(
            `UPDATE subscription SET status = $2, updated_at = NOW()
             WHERE business_id = $1 AND stripe_subscription_id = $3`,
            [row.business_id, stripeStatus, row.stripe_subscription_id],
          );
        }
      } catch (err: unknown) {
        // One broken row must not stop the sweep for everyone else.
        console.error(
          `[Stripe reconcile] business ${row.business_id} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (healed > 0) invalidatePublicBusinessData();
    console.log(`[Stripe reconcile] checked ${local.rows.length} subscriptions, healed ${healed}`);
    return { checked: local.rows.length, healed };
  } finally {
    reconcileInFlight = false;
  }
};

async function processStripeEvent(event: Stripe.Event, pool: Pool): Promise<void> {
  switch (event.type) {

    case 'checkout.session.completed': {
      try {
        const session = event.data.object as Stripe.Checkout.Session;
        const businessId = Number(session.metadata?.business_id);
        if (!businessId) { console.error('[Stripe] checkout.session.completed: missing business_id', session.id); break; }

        // ── Founding member one-time payment ────────────────────────────────
        if (session.mode === 'payment' && session.metadata?.founding === 'true') {
          const paymentIntentId = session.payment_intent as string;
          const customerId = (session.customer as string | null) ?? null;
          // Per-location pricing: amount + location count come off the session itself. A paid
          // session always has amount_total; failing loudly beats snapshotting a wrong amount.
          if (session.amount_total == null || session.amount_total < 50) throw new Error('founding session has invalid amount_total');
          const amountPaidDollars = session.amount_total / 100;
          const locationCount = Math.max(1, Number(session.metadata?.locations ?? 1));
          await activateFoundingMember(pool, businessId, paymentIntentId, session.id, customerId, amountPaidDollars, locationCount);
          invalidatePublicBusinessData();
          console.log(`[Stripe] Webhook activated founding member for business ${businessId}`);
          break;
        }

        // ── Founding second-year renewal ─────────────────────────────────────
        if (session.mode === 'payment' && session.metadata?.founding_renewal === 'true') {
          await activateFoundingRenewal(pool, session);
          break;
        }

        // ── Update payment method (setup mode on an existing customer) ────────
        if (session.mode === 'setup' && session.metadata?.purpose === 'update_payment_method') {
          await handleUpdatePaymentMethodSession(pool, session);
          break;
        }

        // ── Recurring subscription (created from the setup-mode session) ──────
        if (session.mode === 'setup') {
          await createSubscriptionForSetupSession(pool, session);
          console.log(`[Stripe] Webhook created subscription for business ${businessId}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        // Sold-out founding payment: the refund is ALREADY issued and the outcome is
        // final. Swallow (keep the claim) so Stripe stops redelivering - a rethrow would
        // release the claim and retry a refund that already happened, forever. The
        // success-page verify path still throws this to show the refunded message.
        if (msg.includes('A full refund has been issued')) {
          console.log('[Stripe] checkout.session.completed: sold-out founding payment refunded - event settled, no retry.');
          break;
        }
        console.error('[Stripe] ERROR in checkout.session.completed:', err instanceof Error ? err.message : err);
        throw err;
      }
      break;
    }

    case 'customer.subscription.updated': {
      try {
        const subscription = event.data.object as Stripe.Subscription;
        const businessId = Number(subscription.metadata?.business_id);
        if (!businessId) break;

        const status = mapStripeStatus(subscription.status);
        const currentPeriodEnd = extractPeriodEnd(subscription);
        const cancelAtPeriodEnd = subscription.cancel_at_period_end;

        // Two guards against out-of-order/stale events (Stripe does not guarantee order):
        //  - stripe_subscription_id must MATCH the row: a leftover event from an old,
        //    replaced subscription must never overwrite the business's new one.
        //  - status <> 'Cancelled': a stale "updated" arriving after the "deleted" event
        //    must never resurrect a dead subscription (same guard the invoice handlers use).
        // participation_paused clears when the cancel flips true -> false (dashboard
        // un-cancel, or a resume whose DB write was lost): an immediate-removal pause
        // no longer reflects intent, and leaving it would keep a PAYING business off
        // the map with no recovery path. The CASE reads the OLD row value, so a pause
        // set independently of a cancel is untouched.
        await pool.query(`
          UPDATE subscription
          SET status = $1, current_period_end = $2,
              participation_paused = CASE WHEN cancel_at_period_end = true AND $3 = false THEN false ELSE participation_paused END,
              cancel_at_period_end = $3,
              updated_at = NOW()
          WHERE business_id = $4
            AND stripe_subscription_id = $5
            AND status <> 'Cancelled'
        `, [status, currentPeriodEnd, cancelAtPeriodEnd, businessId, subscription.id]);

        // No draw enrollment here. Enrollment happens only when a campaign is
        // opened; this handler just keeps our subscription row in sync with Stripe.
        invalidatePublicBusinessData();
      } catch (err: unknown) {
        console.error('[Stripe] ERROR in customer.subscription.updated:', err instanceof Error ? err.message : err);
        throw err;
      }
      break;
    }

    case 'customer.subscription.deleted': {
      try {
        const subscription = event.data.object as Stripe.Subscription;
        const businessId = Number(subscription.metadata?.business_id);
        if (!businessId) break;

        // Same stale-event guards as customer.subscription.updated: the row must belong to
        // THIS Stripe subscription. A deleted event that failed delivery and is retried days
        // later (after the business re-subscribed and the row carries a NEW subscription id)
        // must never cancel the replacement subscription.
        await pool.query(
          `UPDATE subscription SET status = 'Cancelled', updated_at = NOW()
           WHERE business_id = $1
             AND stripe_subscription_id = $2
             AND status <> 'Cancelled'`,
          [businessId, subscription.id],
        );
        // No draw removal: with open-time enrollment a business is only ever in the
        // Open draw it already paid for (it keeps it), and won't be enrolled in the
        // next campaign because it's Cancelled by the time that opens.
        invalidatePublicBusinessData();
        console.log(`[Stripe] Business ${businessId} deactivated`);
      } catch (err: unknown) {
        console.error('[Stripe] ERROR in customer.subscription.deleted:', err instanceof Error ? err.message : err);
        throw err;
      }
      break;
    }

    case 'charge.dispute.created': {
      try {
        // A chargeback: the bank clawed the money back. Policy: NOTIFY ONLY - a human
        // reviews it in Stripe and decides what happens to the account. Identify the
        // business by payment intent: founding payments are on our ledger; recurring
        // payments resolve through Stripe (payment intent -> invoice -> subscription).
        const dispute = event.data.object as Stripe.Dispute;
        const piId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id ?? null;

        let businessId: number | null = null;
        let businessName = 'Unknown business';
        if (piId) {
          const founding = await pool.query(
            `SELECT b.id, b.name FROM founding_payment fp JOIN business b ON b.id = fp.business_id
             WHERE fp.stripe_payment_intent_id = $1`,
            [piId],
          );
          if (founding.rows[0]) {
            businessId = founding.rows[0].id;
            businessName = founding.rows[0].name;
          } else {
            try {
              const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['invoice'] });
              const invoice = (pi as unknown as { invoice?: Stripe.Invoice | string | null }).invoice;
              const subId = invoice && typeof invoice !== 'string' ? getInvoiceSubscriptionId(invoice) : null;
              if (subId) {
                const row = await pool.query(
                  `SELECT b.id, b.name FROM subscription s JOIN business b ON b.id = s.business_id
                   WHERE s.stripe_subscription_id = $1`,
                  [subId],
                );
                if (row.rows[0]) { businessId = row.rows[0].id; businessName = row.rows[0].name; }
              }
            } catch (lookupErr: unknown) {
              console.error('[Stripe] dispute business lookup via Stripe failed:', lookupErr instanceof Error ? lookupErr.message : lookupErr);
            }
          }
        }

        console.error(
          `[Stripe] DISPUTE OPENED: $${(dispute.amount / 100).toFixed(2)} by "${businessName}" (business ${businessId ?? '?'}), ` +
          `dispute ${dispute.id}, reason: ${dispute.reason}. NO automatic action taken - review in Stripe.`,
        );
        try {
          await sendDisputeAlertEmail({
            businessName,
            businessId,
            amountDollars: dispute.amount / 100,
            disputeId: dispute.id,
            reason: dispute.reason ?? 'unknown',
          });
        } catch (mailErr: unknown) {
          console.error('[Stripe] dispute alert email failed (non-fatal):', mailErr instanceof Error ? mailErr.message : mailErr);
        }
      } catch (err: unknown) {
        console.error('[Stripe] ERROR in charge.dispute.created:', err instanceof Error ? err.message : err);
        throw err;
      }
      break;
    }

    case 'invoice.payment_failed': {
      try {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = getInvoiceSubscriptionId(invoice);
        if (!subscriptionId) break;
        // Settlement invoices (plan/location change differences) are voided when their
        // charge fails and the change is rolled back — the business's campaign payment
        // is untouched, so this failure must NOT mark them Past_Due.
        if (invoice.metadata?.winnbell_kind === 'settlement') break;

        // A failed signup charge keeps the business Incomplete (set at activation), NOT
        // Past_Due — Past_Due is for an established subscription that missed a renewal. Both
        // states recover via invoice.payment_succeeded, so the business is not stuck; we
        // just preserve the correct state. Guard on business_id NULL-check via the row
        // status: only demote a currently-Active/Trialing/Past_Due row to Past_Due.
        const isSignupCharge = invoice.metadata?.winnbell_kind === 'signup_charge';
        if (!isSignupCharge) {
          await pool.query(
            `UPDATE subscription SET status = 'Past_Due', updated_at = NOW()
             WHERE stripe_subscription_id = $1 AND status <> 'Cancelled'`,
            [subscriptionId],
          );
          invalidatePublicBusinessData();
        }

        // Tell the business on the FIRST failed attempt (Stripe keeps retrying on its
        // own schedule; the in-app banner persists either way). Non-fatal: a mail hiccup
        // must not make Stripe redeliver this event.
        const attemptCount = (invoice as unknown as { attempt_count?: number }).attempt_count ?? 1;
        if (attemptCount <= 1) {
          try {
            const biz = await pool.query(
              `SELECT b.name, u.email
               FROM subscription s
               JOIN business b ON b.id = s.business_id
               JOIN "user" u ON u.id = b.user_id
               WHERE s.stripe_subscription_id = $1`,
              [subscriptionId],
            );
            if (biz.rows[0]?.email) {
              await sendPaymentFailedEmail(biz.rows[0].email, biz.rows[0].name, invoice.amount_due / 100, isSignupCharge);
            }
          } catch (mailErr: unknown) {
            console.error('[Stripe] payment-failed email error (non-fatal):', mailErr instanceof Error ? mailErr.message : mailErr);
          }
        }
      } catch (err: unknown) {
        console.error('[Stripe] ERROR in invoice.payment_failed:', err instanceof Error ? err.message : err);
        throw err;
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      try {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = getInvoiceSubscriptionId(invoice);
        if (!subscriptionId) break; // one-time / founding payments have no subscription — ignore
        // Settlement invoices only exist for businesses that already paid their campaign
        // (change guards require it) — nothing to flip or enroll.
        if (invoice.metadata?.winnbell_kind === 'settlement') break;

        // A paid invoice means the subscription is current. If the business was in a
        // payment-failed state (Past_Due from a failed 24th renewal, Incomplete from a
        // failed signup charge), this payment RECOVERS it: flip Active AND enroll it into
        // the currently Open campaign - unpaid businesses are no longer enrolled at open,
        // and this payment is precisely for the campaign that is running. ON CONFLICT
        // makes it a no-op for businesses that were enrolled all along.
        //
        // STATUS ONLY on the subscription row - current_period_end stays owned by
        // customer.subscription.updated. The `status <> 'Cancelled'` guard prevents
        // resurrecting a cancelled subscription, and a missing row (event ordering vs
        // checkout) is a safe no-op.
        const prior = await pool.query(
          `SELECT business_id FROM subscription WHERE stripe_subscription_id = $1`,
          [subscriptionId],
        );
        if (prior.rows[0]) {
          // Recovery path: flips Past_Due/Incomplete to Active AND enrolls into the
          // running campaign (a no-op for businesses that were fine all along).
          await recoverBusinessAfterPayment(pool, prior.rows[0].business_id);
        }
        await pool.query(
          `UPDATE subscription SET status = 'Active', updated_at = NOW()
           WHERE stripe_subscription_id = $1 AND status <> 'Cancelled'`,
          [subscriptionId],
        );
        invalidatePublicBusinessData();
      } catch (err: unknown) {
        console.error('[Stripe] ERROR in invoice.payment_succeeded:', err instanceof Error ? err.message : err);
        throw err;
      }
      break;
    }
  }
}

// ─── Founding Member: Activate ────────────────────────────────────────────────

async function activateFoundingMember(
  pool: Pool,
  businessId: number,
  paymentIntentId: string,
  checkoutSessionId: string,
  customerId: string | null,
  // Per-location pricing: what THIS session actually charged (price x locations at
  // purchase) and for how many locations - both read off the checkout session. No
  // defaults on purpose: every caller must pass the real
  // charged amount - a silent fallback here would corrupt amount_paid (and with it
  // the member's exact-price renewal).
  amountPaidDollars: number,
  locationCount: number,
): Promise<void> {
  // Idempotency + duplicate-purchase guard. One query answers both questions: was THIS
  // session already activated (webhook + verify double call), and does this business
  // already hold a seat from a DIFFERENT session (two checkout tabs both paid)?
  const existing = await pool.query(
    `SELECT stripe_checkout_session_id FROM founding_member
     WHERE business_id = $1 OR stripe_checkout_session_id = $2`,
    [businessId, checkoutSessionId],
  );
  if (existing.rows.some((r) => r.stripe_checkout_session_id === checkoutSessionId)) {
    console.log(`[Founding] Session ${checkoutSessionId} already activated — skipping`);
    return;
  }
  if (existing.rows.length > 0) {
    // Duplicate purchase: the business already has a founding seat paid through another
    // session. Auto-refund this second payment in full and record it on the ledger as
    // refunded. Returning (not throwing) keeps the webhook claim so Stripe stops
    // redelivering; if the refund itself fails we DO throw so the retry re-attempts it.
    console.error(`[Founding] Business ${businessId} paid founding twice (session ${checkoutSessionId}) — auto-refunding the duplicate`);
    try {
      await stripe.refunds.create({ payment_intent: paymentIntentId });
    } catch (refundErr: unknown) {
      const code = (refundErr as { code?: string })?.code;
      if (code !== 'charge_already_refunded') {
        console.error(`[Founding] CRITICAL: duplicate-purchase refund failed for business ${businessId}:`, refundErr instanceof Error ? refundErr.message : refundErr);
        throw refundErr;
      }
    }
    await pool.query(`
      INSERT INTO founding_payment (business_id, stripe_payment_intent_id, stripe_checkout_session_id, amount, refunded_amount)
      VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET refunded_amount = EXCLUDED.refunded_amount
    `, [businessId, paymentIntentId, checkoutSessionId, amountPaidDollars]);
    return;
  }

  // A live recurring subscription must not be silently orphaned: the founding upsert
  // below sets stripe_subscription_id to NULL, and an unlinked Stripe subscription would
  // keep charging monthly with no record on our side. Founding supersedes it - cancel it
  // at Stripe first (idempotent: an already-cancelled sub is treated as done).
  const liveSub = await pool.query(
    `SELECT stripe_subscription_id FROM subscription
     WHERE business_id = $1 AND status != 'Cancelled' AND stripe_subscription_id IS NOT NULL`,
    [businessId],
  );
  const liveSubId: string | null = liveSub.rows[0]?.stripe_subscription_id ?? null;
  if (liveSubId) {
    console.log(`[Founding] Business ${businessId} has live subscription ${liveSubId} — cancelling it before founding activation`);
    try {
      await stripe.subscriptions.cancel(liveSubId);
    } catch (cancelErr: unknown) {
      const code = (cancelErr as { code?: string })?.code;
      const msg = cancelErr instanceof Error ? cancelErr.message : '';
      if (code !== 'resource_missing' && !/canceled subscription/i.test(msg)) {
        console.error(`[Founding] CRITICAL: could not cancel subscription ${liveSubId} before founding activation:`, msg);
        throw cancelErr;
      }
    }
    try {
      await pool.query(
        `INSERT INTO subscription_change_log (business_id, description) VALUES ($1, $2)`,
        [businessId, 'Founding Partner purchase replaced your monthly plan. Monthly billing has stopped.'],
      );
    } catch (logErr: unknown) {
      console.error('[Founding] change-log write failed (non-fatal):', logErr instanceof Error ? logErr.message : logErr);
    }
  }

  const client = await pool.connect();
  let seatNumber: number;
  try {
    await client.query('BEGIN');

    // Atomically claim the lowest available seat within the current cap
    const seatResult = await client.query(`
      WITH available_seat AS (
        SELECT s AS seat_number
        FROM generate_series(1, (SELECT founding_member_cap FROM platform_settings WHERE id = 1)) s
        WHERE s NOT IN (SELECT seat_number FROM founding_member)
        ORDER BY s ASC
        LIMIT 1
      )
      INSERT INTO founding_member (business_id, seat_number, stripe_payment_intent_id, stripe_checkout_session_id, amount_paid)
      SELECT $1, seat_number, $2, $3, $4
      FROM available_seat
      RETURNING seat_number
    `, [businessId, paymentIntentId, checkoutSessionId, amountPaidDollars]);

    if ((seatResult.rowCount ?? 0) === 0) {
      await safeRollback(client);
      console.error(`[Founding] No seats available for business ${businessId} — issuing auto-refund`);
      // Ledger the payment+refund BEFORE calling Stripe so the money trail exists even if
      // the process dies mid-refund. Idempotent on the payment intent, so a retry can't
      // double-record; Stripe itself rejects refunding an already-refunded payment.
      await pool.query(
        `INSERT INTO founding_payment (business_id, stripe_payment_intent_id, stripe_checkout_session_id, amount, refunded_amount)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET refunded_amount = EXCLUDED.amount`,
        [businessId, paymentIntentId, checkoutSessionId, amountPaidDollars],
      );
      try {
        await stripe.refunds.create({ payment_intent: paymentIntentId });
      } catch (refundErr: unknown) {
        console.error(`[Founding] Auto-refund failed: ${refundErr instanceof Error ? refundErr.message : refundErr}`);
      }
      throw new Error('All founding partner spots were claimed while your payment was processing. A full refund has been issued.');
    }

    seatNumber = seatResult.rows[0].seat_number as number;
    console.log(`[Founding] Business ${businessId} claimed seat #${seatNumber}`);

    // One-time payment: no stripe_subscription_id; period runs FOUNDING_TERM_MONTHS
    // computed in SQL (make_interval handles month-end dates; JS setMonth would roll
    // Mar 31 + 3 months into Jul 1). Entry allowance = FOUNDING_ENTRIES_PER_LOCATION.
    // fee_at_entry = the member's MONTHLY RATE snapshot ((amount paid) / term months) -
    // this is what the one-time renewal multiplies by its own term length.
    const monthlyEquivalent = Math.round((amountPaidDollars * 100) / FOUNDING_TERM_MONTHS) / 100;

    await client.query(`
      INSERT INTO subscription
        (business_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
         status, current_period_end, cancel_at_period_end, fee_at_entry, entries_per_location, billing_interval)
      VALUES ($1, $4, NULL, NULL, 'Active', NOW() + make_interval(months => $2), false, $3, $5, 'yearly')
      ON CONFLICT (business_id) DO UPDATE
        SET status               = 'Active',
            stripe_customer_id   = COALESCE(EXCLUDED.stripe_customer_id, subscription.stripe_customer_id),
            stripe_subscription_id = NULL,
            current_period_end   = EXCLUDED.current_period_end,
            cancel_at_period_end = false,
            fee_at_entry         = EXCLUDED.fee_at_entry,
            entries_per_location = EXCLUDED.entries_per_location,
            participation_paused = false,
            billing_interval     = 'yearly',
            updated_at           = NOW()
    `, [businessId, FOUNDING_TERM_MONTHS, monthlyEquivalent, customerId, FOUNDING_ENTRIES_PER_LOCATION]);

    // Append to the durable payment ledger. Unlike founding_member (one row per
    // business, deleted on cancel), this is append-only so the plan page can show
    // full history across cancel→repurchase cycles. ON CONFLICT keeps it idempotent.
    await client.query(`
      INSERT INTO founding_payment (business_id, stripe_payment_intent_id, stripe_checkout_session_id, amount)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (stripe_payment_intent_id) DO NOTHING
    `, [businessId, paymentIntentId, checkoutSessionId, amountPaidDollars]);

    await client.query('COMMIT');
    console.log(`[Founding] subscription row upserted for business ${businessId} (seat #${seatNumber})`);
  } catch (err) {
    await safeRollback(client);
    // Two concurrent activations both pass the pre-check; the loser hits the
    // UNIQUE(business_id) seat constraint. Two distinct cases (audit P2-5):
    //  - SAME PaymentIntent (webhook + verify double call of one session): the winner
    //    already fully activated this exact payment - idempotent no-op.
    //  - DIFFERENT PaymentIntent (two checkout tabs both PAID): the loser is a real,
    //    separate charge that would otherwise be silently swallowed - refund it in
    //    full and ledger it, exactly like the sequential duplicate-purchase path.
    if ((err as { code?: string })?.code === '23505') {
      const winner = await pool.query(
        `SELECT stripe_payment_intent_id FROM founding_member WHERE business_id = $1`,
        [businessId],
      );
      const winnerPi: string | null = winner.rows[0]?.stripe_payment_intent_id ?? null;
      if (winnerPi && winnerPi !== paymentIntentId) {
        console.error(`[Founding] Business ${businessId} raced two PAID founding sessions - auto-refunding the loser (${paymentIntentId})`);
        try {
          await stripe.refunds.create({ payment_intent: paymentIntentId });
        } catch (refundErr: unknown) {
          const code = (refundErr as { code?: string })?.code;
          if (code !== 'charge_already_refunded') {
            console.error(`[Founding] CRITICAL: race-loser refund failed for business ${businessId}:`, refundErr instanceof Error ? refundErr.message : refundErr);
            throw refundErr; // webhook retry re-attempts the refund
          }
        }
        await pool.query(`
          INSERT INTO founding_payment (business_id, stripe_payment_intent_id, stripe_checkout_session_id, amount, refunded_amount)
          VALUES ($1, $2, $3, $4, $4)
          ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET refunded_amount = EXCLUDED.refunded_amount
        `, [businessId, paymentIntentId, checkoutSessionId, amountPaidDollars]);
        return;
      }
      console.log(`[Founding] Concurrent activation for business ${businessId} - already claimed, skipping`);
      return;
    }
    throw err;
  } finally {
    client.release();
  }

  // Enrollment happens when the admin opens the next campaign — founding members
  // are Active and within their prepaid term, so they get enrolled like anyone else.

  // Welcome email — non-fatal (activation is already committed)
  try {
    const bizResult = await pool.query(`
      SELECT b.name, u.email, s.current_period_end
      FROM business b
      JOIN "user" u ON u.id = b.user_id
      JOIN subscription s ON s.business_id = b.id
      WHERE b.id = $1
    `, [businessId]);
    const biz = bizResult.rows[0];
    if (biz?.email) {
      // Seat number / founding cap intentionally not passed: internal data, never shown to partners.
      await sendFoundingWelcomeEmail(biz.email, biz.name, {
        termEnd: new Date(biz.current_period_end),
        amountPaid: amountPaidDollars,
        locationCount,
        termMonths: FOUNDING_TERM_MONTHS,
      });
    }
  } catch (err: unknown) {
    console.error(`[Founding] Welcome email failed for business ${businessId} (non-fatal):`, err instanceof Error ? err.message : err);
  }
}

// ─── Shared Activation Logic ──────────────────────────────────────────────────

async function activateBusinessSubscription(
  pool: Pool,
  businessId: number,
  subscriptionId: string,
  customerId: string,
  priceId: string,
  currentPeriodEnd: Date,
  monthlyFee: number,
  entriesPerLocation: number,
  initialStatus: 'Active' | 'Incomplete' = 'Active',
  chargedToday = false,
): Promise<void> {
  console.log(`[Stripe] Activating business ${businessId} — entries/location: ${entriesPerLocation}...`);

  // Both the business UPDATE and subscription INSERT must succeed or both must roll back.
  // If the subscription row fails to insert after the business is marked subscribed,
  // the business would appear active with no subscription record — money taken, no subscription.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Founding hand-off ─────────────────────────────────────────────────────
    // If this business is a founding member, this activation is the transition to a
    // regular plan. The founding seat ends here (row deleted; the one-time payment stays in the
    // append-only founding_payment ledger). When the founding term still covers the
    // currently OPEN campaign, the new tier/fee must NOT shrink benefits already paid
    // for — they are staged in pending_* and applied by openDrawInTx when the next
    // campaign opens. When nothing covered remains (expired), the new plan applies now.
    const fmRes = await client.query(
      `SELECT id FROM founding_member WHERE business_id = $1 FOR UPDATE`,
      [businessId],
    );
    const wasFounding = (fmRes.rowCount ?? 0) > 0;
    let deferToNextCampaign = false;
    if (wasFounding) {
      // The founding benefits cover the currently OPEN campaign iff the business is
      // enrolled in it — enrollment at open is the single source of truth, and a founder
      // is in every campaign that opened inside their term (even one that draws after
      // the expiry date). An expired founder has no Open-draw entry, so the new plan
      // applies immediately.
      const covered = await client.query(
        `SELECT 1
         FROM draw_entry de
         JOIN draw d ON d.id = de.draw_id
         WHERE de.business_id = $1 AND d.status = 'Open'`,
        [businessId],
      );
      deferToNextCampaign = (covered.rowCount ?? 0) > 0;
      await client.query(`DELETE FROM founding_member WHERE business_id = $1`, [businessId]);
      console.log(`[Stripe] Business ${businessId} founding hand-off (${deferToNextCampaign ? 'new plan staged for next campaign' : 'new plan applies immediately'})`);
    }

    if (deferToNextCampaign) {
      // Keep the founding tier/fee live for the campaign that is still covered; park
      // the new plan in pending_*. The row must already exist (they are founding).
      await client.query(`
        UPDATE subscription
        SET stripe_customer_id           = $2,
            stripe_subscription_id       = $3,
            stripe_price_id              = $4,
            status                       = $9,
            current_period_end           = $5,
            cancel_at_period_end         = false,
            pending_fee_at_entry         = $6,
            pending_entries_per_location = $7,
            skip_next_campaign           = false,
            participation_paused         = false,
            billing_interval             = $8,
            updated_at                   = NOW()
        WHERE business_id = $1
      `, [businessId, customerId, subscriptionId, priceId, currentPeriodEnd, monthlyFee, entriesPerLocation || null, 'monthly', initialStatus]);
    } else {
      await client.query(`
        INSERT INTO subscription
          (business_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, status, current_period_end, cancel_at_period_end, fee_at_entry, entries_per_location, billing_interval)
        VALUES ($1, $2, $3, $4, $9, $5, false, $6, $7, $8)
        ON CONFLICT (business_id) DO UPDATE
          SET stripe_customer_id     = EXCLUDED.stripe_customer_id,
              stripe_subscription_id = EXCLUDED.stripe_subscription_id,
              stripe_price_id        = EXCLUDED.stripe_price_id,
              status                 = EXCLUDED.status,
              current_period_end     = EXCLUDED.current_period_end,
              cancel_at_period_end   = false,
              fee_at_entry           = EXCLUDED.fee_at_entry,
              entries_per_location   = EXCLUDED.entries_per_location,
              pending_fee_at_entry         = NULL,
              pending_entries_per_location = NULL,
              skip_next_campaign     = false,
              participation_paused   = false,
              billing_interval       = EXCLUDED.billing_interval,
              updated_at             = NOW()
      `, [businessId, customerId, subscriptionId, priceId, currentPeriodEnd, monthlyFee, entriesPerLocation || null, 'monthly', initialStatus]);
    }

    await client.query('COMMIT');
    console.log(`[Stripe] subscription row upserted for business ${businessId}`);
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }

  // No draw enrollment here. A new subscriber joins the next campaign when the
  // admin opens it — open is the single enrollment point.

  // Send confirmation email — non-fatal. Plan values come from THIS activation's
  // parameters, not a re-read of the subscription row: during a founding hand-off the
  // row still carries the founding tier/fee (the new plan is staged in pending_*), and
  // the email must describe the plan the business just chose.
  // Incomplete activations (window signup whose immediate charge failed) get no congrats
  // email: the business is not enrolled yet, and the payment-failed flow messages them.
  if (initialStatus !== 'Active') return;
  try {
    const bizResult = await pool.query(
      `SELECT b.name, u.email,
              (SELECT COUNT(*) FROM business_location WHERE business_id = b.id AND is_active = true) AS location_count
       FROM business b
       JOIN "user" u ON u.id = b.user_id
       WHERE b.id = $1`,
      [businessId],
    );
    const biz = bizResult.rows[0];
    if (biz?.email) {
      await sendSubscriptionConfirmationEmail(biz.email, biz.name, {
        planName: TIER_PRICE_MAP[entriesPerLocation]?.name ?? 'Winnbell',
        entriesPerLocation,
        monthlyFee,
        locationCount: Math.max(1, Number(biz.location_count)),
        chargedToday,
      });
    }
  } catch (err: unknown) {
    console.error(`[Stripe] Confirmation email failed for business ${businessId} (non-fatal):`, err instanceof Error ? err.message : err);
  }
}

// ─── Draw enrollment ──────────────────────────────────────────────────────────
// Enrollment lives solely in openDrawService (when the admin opens a campaign).
// The old handleDrawParticipation / handleYearlyDrawParticipation — which
// pre-created draws and enrolled on signup/renew — were removed: they conflicted
// with the admin-opens-one-campaign-per-month model and could enroll businesses
// in draws they hadn't paid for.

// ─── Sync Subscription Quantity ───────────────────────────────────────────────
// ─── Per-business billing lock ────────────────────────────────────────────────
// Serializes ALL subscription-billing mutations for one business (userId is 1:1 with a
// business) so concurrent location adds/removes and plan changes cannot race the
// read-baseline -> Stripe-update -> DB-write sequence and leave Stripe and the DB (or two
// Stripe fields) mismatched. SESSION-level advisory lock on a dedicated connection, held
// across the external Stripe calls (which cannot sit inside a DB transaction). Lock family 8
// is unused elsewhere (2/3/4/10 are the per-user/receipt xact locks). MUST NOT nest: only the
// outermost mutators (addLocation, deleteLocation, updateSubscriptionPlan) take it;
// syncSubscriptionQuantity is always called from within one of those and never re-locks.
export const withBusinessBillingLock = async <T>(userId: number, fn: () => Promise<T>): Promise<T> => {
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock(8, hashtext($1))', [`bizbill:${userId}`]);
    return await fn();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(8, hashtext($1))', [`bizbill:${userId}`]);
    } catch { /* connection dead; the advisory lock is freed automatically on release */ }
    client.release();
  }
};

// Called after scheduling a location add/remove. `newNextCampaignCount` is the location
// count the NEXT campaign will run with (active minus scheduled removals plus scheduled
// adds). Money model: no prorations ever. Stripe items update immediately so the next
// 24th bills the new count; the fee is staged in pending_* and goes live at the next
// campaign open. Inside the charged-but-not-opened window the difference for the already
// paid campaign is settled on the spot (charged or refunded).
// Skips silently for founding members (no stripe_subscription_id — flat price).
export const syncSubscriptionQuantity = async (userId: number, newNextCampaignCount: number, reason: 'location_added' | 'location_removed' = 'location_added'): Promise<void> => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT
      s.stripe_subscription_id,
      s.stripe_customer_id,
      s.entries_per_location,
      s.fee_at_entry,
      s.pending_entries_per_location,
      s.pending_fee_at_entry,
      s.status,
      b.id AS business_id
    FROM business b
    JOIN subscription s ON s.business_id = b.id
    WHERE b.user_id = $1
  `, [userId]);

  const sub = result.rows[0];
  if (!sub) return; // no subscription yet — nothing to sync
  if (!sub.stripe_subscription_id) return; // founding member, no Stripe sub — skip
  // A broken payment must be fixed before any billing change — otherwise settlements
  // and baselines run against money that was never collected.
  if (['Past_Due', 'Incomplete'].includes(sub.status)) throw new Error('PAYMENT_ISSUE');

  // The next campaign's tier: a staged plan change (or founding hand-off) takes precedence
  // over the live tier — it is what Stripe bills and what the next campaign runs with.
  const effectiveTier = (sub.pending_entries_per_location ?? sub.entries_per_location) as number;

  const tierConfig = TIER_PRICE_MAP[effectiveTier];
  if (!tierConfig) throw new Error('Unknown tier');

  const priceId = process.env[tierConfig.envKey];
  if (!priceId) throw new Error(`Stripe price ID not configured for tier ${effectiveTier}`);

  const quantity = Math.max(1, newNextCampaignCount);
  const newTotalFee = resolveMonthlyFee(effectiveTier, quantity);
  // What the business is currently set to pay for the next campaign (already settled or
  // queued for the next 24th). Every change settles its own delta against this baseline.
  const baselineFee = Number(sub.pending_fee_at_entry ?? sub.fee_at_entry ?? 0);
  const deltaDollars = newTotalFee - baselineFee;

  const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['items'] });
  const item = stripeSub.items.data[0];
  if (!item) throw new Error('Stripe subscription item not found');
  const originalQuantity = item.quantity ?? 1;
  const originalPriceId = item.price.id;

  // Step 1 — point Stripe at the new configuration, no proration: the next 24th simply
  // bills the new count.
  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    items: [{ id: item.id, price: priceId, quantity }],
    proration_behavior: 'none',
  });

  // Step 2 — inside the charged window, settle the difference for the already-paid
  // campaign now. Any failure rolls Stripe back so nothing changed anywhere.
  let settled = false;
  try {
    if (deltaDollars !== 0 && await isChargedNotOpenedWindow(pool)) {
      const label = reason === 'location_added'
        ? `Added a location for the upcoming campaign (${quantity} location${quantity !== 1 ? 's' : ''} total)`
        : `Removed a location for the upcoming campaign (${quantity} location${quantity !== 1 ? 's' : ''} total)`;
      if (deltaDollars > 0) {
        // Deterministic idempotency tag (target config + delta), NOT a timestamp: a retry
        // of the SAME change, or a concurrent double-submit, dedupes to one charge.
        const tag = `${sub.stripe_subscription_id}_settle_${effectiveTier}_${quantity}_${Math.round(deltaDollars * 100)}`;
        const paid = await chargeNow(sub.stripe_customer_id, sub.stripe_subscription_id, deltaDollars, label, tag, 'settlement');
        if (!paid) throw new Error('CHARGE_FAILED');
      } else {
        await refundUpcomingCampaignDelta(sub.stripe_subscription_id, -deltaDollars, label);
      }
      settled = true;
    }
  } catch (settleErr) {
    try {
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        items: [{ id: item.id, price: originalPriceId, quantity: originalQuantity }],
        proration_behavior: 'none',
      });
    } catch (rollbackErr: unknown) {
      console.error(
        `[Stripe] CRITICAL: settlement rolled back but the Stripe revert ALSO failed for business ${sub.business_id} ` +
        `(sub ${sub.stripe_subscription_id}). Stripe may hold the new price while the DB keeps the old fee — reconcile manually.`,
        rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
      );
    }
    throw settleErr;
  }

  // Step 3 — stage the new fee (and tier, unchanged here) to go live at the next open.
  // Actively changing locations means the business intends to PARTICIPATE - a previously
  // set skip-campaign opt-out no longer reflects their intent, so clear it.
  // participation_paused is deliberately NOT touched here: the only businesses that can
  // be paused on this path are immediate-removal cancels (founding cannot add/remove
  // locations), and a location edit must never silently undo the owner's cancel choice.
  await pool.query(
    `UPDATE subscription
     SET pending_entries_per_location = $1, pending_fee_at_entry = $2, skip_next_campaign = false, updated_at = NOW()
     WHERE business_id = $3`,
    [effectiveTier, newTotalFee, sub.business_id],
  );

  // No money moved (pre-24th change): record it in the change log so the payment history
  // still shows what happened. Settled changes skip this - their invoice tells the story.
  if (!settled) {
    try {
      const logText = reason === 'location_added'
        ? `Added a location. Your plan covers ${quantity} location${quantity !== 1 ? 's' : ''} from the next campaign.`
        : `Removed a location. Your plan covers ${quantity} location${quantity !== 1 ? 's' : ''} from the next campaign.`;
      await pool.query(
        `INSERT INTO subscription_change_log (business_id, description) VALUES ($1, $2)`,
        [sub.business_id, logText],
      );
    } catch (err: unknown) {
      console.error('[Stripe] change-log write failed (non-fatal):', err instanceof Error ? err.message : err);
    }
  }
};

// ─── Update Subscription Plan ─────────────────────────────────────────────────

export const updateSubscriptionPlan = async (userId: number, newEntriesPerLocation: number): Promise<void> =>
  withBusinessBillingLock(userId, async () => {
  const pool = getPool();

  // Validate tier exists
  const tierConfig = TIER_PRICE_MAP[newEntriesPerLocation];
  if (!tierConfig) throw new Error('Invalid tier');

  // Get current subscription + business + location count
  const result = await pool.query(`
    SELECT
      s.stripe_subscription_id,
      s.stripe_customer_id,
      s.entries_per_location AS current_entries_per_location,
      s.fee_at_entry,
      s.pending_entries_per_location,
      s.pending_fee_at_entry,
      s.status,
      s.cancel_at_period_end,
      b.id AS business_id,
      (SELECT COUNT(*)::int FROM business_location
       WHERE business_id = b.id
         AND ((is_active = TRUE AND deactivate_at_open = FALSE) OR activate_at_open = TRUE)
      ) AS next_campaign_location_count
    FROM business b
    JOIN subscription s ON s.business_id = b.id
    WHERE b.user_id = $1
  `, [userId]);

  const sub = result.rows[0];
  if (!sub) throw new Error('No subscription found');
  if (sub.status === 'Cancelled') throw new Error('Cannot update a cancelled subscription');
  // A subscription set to cancel is on its way out - a staged plan change would strand
  // pending_* state that no future campaign will ever apply. Block it; the owner must
  // resume the plan first. (The client also disables Edit Plan, but the API must enforce it.)
  if (sub.cancel_at_period_end) throw new Error('SUBSCRIPTION_CANCELLING');
  if (!sub.stripe_subscription_id) throw new Error('No Stripe subscription on record');
  // A broken payment must be fixed before any billing change — otherwise settlements
  // and baselines run against money that was never collected.
  if (['Past_Due', 'Incomplete'].includes(sub.status)) throw new Error('PAYMENT_ISSUE');

  // Baseline = what the next campaign is currently set to run with (a staged change wins
  // over the live tier). Changes never touch the RUNNING campaign; they retarget the next
  // one, so comparing against the staged value keeps repeat changes settling correctly.
  const baselineTier = (sub.pending_entries_per_location ?? sub.current_entries_per_location) as number;
  if (baselineTier === newEntriesPerLocation) throw new Error('Already on this tier');

  const priceId = process.env[tierConfig.envKey];
  if (!priceId) throw new Error(`Stripe price ID not configured for tier ${newEntriesPerLocation}`);

  const locationCount = Math.max(1, Number(sub.next_campaign_location_count));
  const newTotalFee = resolveMonthlyFee(newEntriesPerLocation, locationCount);
  const baselineFee = Number(sub.pending_fee_at_entry ?? sub.fee_at_entry ?? 0);
  const deltaDollars = newTotalFee - baselineFee;

  const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['items'] });
  const item = stripeSub.items.data[0];
  if (!item) throw new Error('Stripe subscription item not found');
  const originalPriceId = item.price.id;
  const originalQuantity = item.quantity ?? 1;

  // Step 1 — point Stripe at the new plan, no proration: the next 24th bills it.
  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    items: [{ id: item.id, price: priceId, quantity: locationCount }],
    proration_behavior: 'none',
  });

  // Step 2 — inside the charged window (24th paid the old plan, campaign not open yet)
  // settle the full-campaign difference now: upgrades charge it, downgrades refund it.
  let settled = false;
  try {
    if (deltaDollars !== 0 && await isChargedNotOpenedWindow(pool)) {
      const direction = newEntriesPerLocation > baselineTier ? 'upgraded' : 'downgraded';
      const label = `Plan ${direction} for the upcoming campaign: ${baselineTier.toLocaleString()} to ${newEntriesPerLocation.toLocaleString()} entries per location`;
      if (deltaDollars > 0) {
        // Deterministic idempotency tag (target plan + delta), NOT a timestamp: a retry of
        // the SAME change, or a concurrent double-submit, dedupes to one charge.
        const tag = `${sub.stripe_subscription_id}_settle_${newEntriesPerLocation}_${locationCount}_${Math.round(deltaDollars * 100)}`;
        const paid = await chargeNow(sub.stripe_customer_id, sub.stripe_subscription_id, deltaDollars, label, tag, 'settlement');
        if (!paid) throw new Error('CHARGE_FAILED');
      } else {
        await refundUpcomingCampaignDelta(sub.stripe_subscription_id, -deltaDollars, label);
      }
      settled = true;
    }
  } catch (settleErr) {
    try {
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        items: [{ id: item.id, price: originalPriceId, quantity: originalQuantity }],
        proration_behavior: 'none',
      });
    } catch (rollbackErr: unknown) {
      console.error(
        `[Stripe] CRITICAL: settlement rolled back but the Stripe revert ALSO failed for business ${sub.business_id} ` +
        `(sub ${sub.stripe_subscription_id}). Stripe may hold the new price while the DB keeps the old fee — reconcile manually.`,
        rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
      );
    }
    throw settleErr;
  }

  // Step 3 — stage the plan to go live at the next campaign open. The running campaign
  // keeps its tier; stripe_price_id tracks the live Stripe price (just changed).
  // Actively changing the plan means the business intends to PARTICIPATE - clear any
  // previously set skip-campaign opt-out or founding participation pause (neither
  // reflects their intent any more).
  await pool.query(
    `UPDATE subscription
     SET pending_entries_per_location = $1, pending_fee_at_entry = $2, stripe_price_id = $3, skip_next_campaign = false, participation_paused = false, updated_at = NOW()
     WHERE business_id = $4`,
    [newEntriesPerLocation, newTotalFee, priceId, sub.business_id],
  );

  // No money moved (pre-24th change): record it in the change log so the payment history
  // still shows what happened. Settled changes skip this - their invoice tells the story.
  if (!settled) {
    try {
      await pool.query(
        `INSERT INTO subscription_change_log (business_id, description) VALUES ($1, $2)`,
        [sub.business_id, `Updated your plan from ${baselineTier.toLocaleString()} to ${newEntriesPerLocation.toLocaleString()} entries per location. Takes effect with the next campaign.`],
      );
    } catch (err: unknown) {
      console.error('[Stripe] change-log write failed (non-fatal):', err instanceof Error ? err.message : err);
    }
  }
  });

// ─── Get Subscription Invoices ────────────────────────────────────────────────

export interface InvoiceLineItem {
  description: string | null;
  quantity: number | null;
  amount: number;
  period_start: number | undefined;
  period_end: number | undefined;
}

export interface SubscriptionInvoice {
  id: string;
  date: number;
  amount_paid: number;
  amount_due: number;
  status: string | null;
  invoice_description: string | null;
  description: InvoiceLineItem[];
  invoice_pdf: string | null;
  hosted_invoice_url: string | null;
  // 'founding' = one-time annual founding payment (render line text verbatim, not a
  // per-location monthly breakdown). Absent for recurring subscription invoices.
  kind?: 'founding';
}

export const getSubscriptionInvoices = async (userId: number): Promise<SubscriptionInvoice[]> => {
  const pool = getPool();

  // Single round-trip: pull the customer id plus any founding payments at once.
  // The founding ledger is append-only and records refunds when issued; amounts come
  // straight from the DB (the only Stripe lookups below are the hosted receipt links).
  const result = await pool.query(
    `SELECT s.stripe_customer_id,
            fp.stripe_payment_intent_id, fp.amount, fp.refunded_amount, fp.created_at
     FROM subscription s
     JOIN business b ON b.id = s.business_id
     LEFT JOIN founding_payment fp ON fp.business_id = b.id
     WHERE b.user_id = $1
     ORDER BY fp.created_at DESC`,
    [userId],
  );

  const stripeCustomerId: string | null = result.rows[0]?.stripe_customer_id ?? null;

  // Founding members pay once via PaymentIntent — Stripe never creates invoices for
  // one-time payments, and founding_member is removed only at the founding-to-regular hand-off (founding cannot be cancelled). The founding_payment
  // ledger is the source of truth for history.
  // Founding payments are one-time PaymentIntents (no Stripe invoices). A business that later
  // resubscribes to a regular plan keeps its founding_payment ledger rows, so we must show BOTH
  // the founding history AND any recurring Stripe invoices - merged, newest first - not one or the other.
  const foundingRows = result.rows.filter(r => r.stripe_payment_intent_id);

  // No invoice exists for a one-time payment, but every charge has a Stripe-hosted
  // receipt page (receipt_url) — surface it through hosted_invoice_url so the client's
  // Invoice button works for founding rows too. One small Stripe call per founding
  // payment (almost always exactly one); non-fatal, the row just has no link on failure.
  const foundingReceiptUrls = new Map<string, string | null>();
  await Promise.all(foundingRows.map(async (row) => {
    try {
      const pi = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id, { expand: ['latest_charge'] });
      const charge = pi.latest_charge as Stripe.Charge | null;
      foundingReceiptUrls.set(row.stripe_payment_intent_id, charge?.receipt_url ?? null);
    } catch {
      foundingReceiptUrls.set(row.stripe_payment_intent_id, null);
    }
  }));

  const foundingInvoices: SubscriptionInvoice[] = foundingRows.map((row) => {
    const grossDollars = Number(row.amount);
    const refundedDollars = Number(row.refunded_amount);
    const netPaidDollars = Math.max(0, grossDollars - refundedDollars);
    const createdTs = Math.floor(new Date(row.created_at).getTime() / 1000);

    const isFullRefund = refundedDollars > 0 && netPaidDollars === 0;
    const isPartialRefund = refundedDollars > 0 && netPaidDollars > 0;
    const status = isFullRefund ? 'void' : 'paid';
    const lineDesc = isFullRefund
      ? 'Founding Partner - Winnbell (refunded)'
      : isPartialRefund
        ? `Founding Partner - Winnbell (partial refund -$${refundedDollars.toFixed(2)})`
        : 'Founding Partner - Winnbell';

    return {
      id: row.stripe_payment_intent_id,
      date: createdTs,
      amount_paid: netPaidDollars,
      amount_due: grossDollars,
      status,
      invoice_description: null,
      description: [{ description: lineDesc, quantity: 1, amount: grossDollars, period_start: undefined, period_end: undefined }],
      invoice_pdf: null,
      hosted_invoice_url: foundingReceiptUrls.get(row.stripe_payment_intent_id) ?? null,
      kind: 'founding',
    };
  });

  // Plan/location changes that moved no money (pre-24th) exist only in our change log —
  // merged in as zero-amount entries the client renders as change notes.
  const changeLogResult = await pool.query(
    `SELECT scl.id, scl.description, scl.created_at
     FROM subscription_change_log scl
     JOIN business b ON b.id = scl.business_id
     WHERE b.user_id = $1
     ORDER BY scl.created_at DESC
     LIMIT 24`,
    [userId],
  );
  const changeEntries: SubscriptionInvoice[] = changeLogResult.rows.map((row) => ({
    id: `chg_${row.id}`,
    date: Math.floor(new Date(row.created_at).getTime() / 1000),
    amount_paid: 0,
    amount_due: 0,
    status: 'paid',
    invoice_description: row.description as string,
    description: [],
    invoice_pdf: null,
    hosted_invoice_url: null,
  }));

  // charges.list drives the refund entries below (each charge carries its refunds directly).
  let customerCharges: Stripe.Charge[] = [];
  if (stripeCustomerId) {
    const chargeList = await stripe.charges.list({ customer: stripeCustomerId, limit: 24, expand: ['data.refunds'] });
    customerCharges = chargeList.data;
  }

  let stripeInvoices: SubscriptionInvoice[] = [];
  if (stripeCustomerId) {
    const invoiceList = await stripe.invoices.list({
      customer: stripeCustomerId,
      limit: 24,
      expand: ['data.lines', 'data.payments'],
    });
    stripeInvoices = invoiceList.data
      // Drop Stripe accounting artifacts: subscription creation (and similar) produces a
      // $0 invoice that Stripe instantly marks "paid". No money moved and there is no
      // description to explain anything, so showing it as a payment only confuses the
      // business. Zero-total invoices WITH a description (change notes) are kept.
      .filter((invoice) => !(invoice.amount_due === 0 && invoice.amount_paid === 0 && !invoice.description))
      .map((invoice): SubscriptionInvoice => {
        return {
          id: invoice.id,
          date: invoice.created,
          amount_paid: invoice.amount_paid / 100,
          amount_due: invoice.amount_due / 100,
          status: invoice.status,
          invoice_description: invoice.description ?? null,
          description: invoice.lines.data.map(line => ({
            description: line.description,
            quantity: line.quantity ?? null,
            amount: line.amount / 100,
            period_start: line.period?.start,
            period_end: line.period?.end,
          })),
          invoice_pdf: invoice.invoice_pdf ?? null,
          // The clean hosted invoice page (invoice.stripe.com/i/...) - a single "Paid" invoice view.
          // NOT the charge receipt_url: for a subscription (invoice-backed) charge that opens the
          // /receipts/invoices/ page with a combined invoice + receipt ("two block") layout.
          hosted_invoice_url: invoice.hosted_invoice_url ?? null,
        };
      });
  }

  // Refunds on regular (Stripe-invoice) charges. In-window downgrades and location removals
  // refund against the ORIGINAL charge's PaymentIntent — that does not change the already-paid
  // invoice, so the refund would otherwise be invisible in history. Surface each succeeded
  // refund as its own entry. Founding refunds are already shown via the founding_payment
  // ledger above, so skip any PaymentIntent that belongs to a founding payment.
  const foundingPIs = new Set(foundingRows.map((r) => r.stripe_payment_intent_id as string));
  let refundEntries: SubscriptionInvoice[] = [];
  {
    // Reuses the customerCharges list fetched above (refunds already expanded there).
    for (const charge of customerCharges) {
      const refunds = (charge as unknown as { refunds?: { data?: Stripe.Refund[] } }).refunds?.data ?? [];
      for (const refund of refunds) {
        if (refund.status !== 'succeeded') continue;
        const rpi = typeof refund.payment_intent === 'string' ? refund.payment_intent : refund.payment_intent?.id;
        if (rpi && foundingPIs.has(rpi)) continue; // founding refund already shown via the ledger
        const reason = (refund.metadata?.reason as string | undefined) || 'Refund for a plan change';
        const amt = refund.amount / 100;
        refundEntries.push({
          id: refund.id,
          date: refund.created,
          amount_paid: 0,
          amount_due: amt,
          status: 'void', // client renders 'void' as a grey "Refunded" chip
          invoice_description: null,
          // period_start === period_end marks this a one-off line so the client shows the
          // description verbatim instead of synthesizing a per-location monthly breakdown.
          description: [{ description: `Refund: ${reason}`, quantity: 1, amount: -amt, period_start: refund.created, period_end: refund.created }],
          invoice_pdf: null,
          // A refund is a reversal on a charge, not an invoice of its own. The charge's receipt page
          // is the one Stripe document that actually shows the refund (amount refunded + date); an
          // invoice's hosted page shows the ORIGINAL pre-refund total (misleading for a partial
          // refund). So link the charge receipt here.
          hosted_invoice_url: charge.receipt_url ?? null,
        });
      }
    }
  }

  return [...foundingInvoices, ...changeEntries, ...stripeInvoices, ...refundEntries].sort((a, b) => b.date - a.date);
};

// ─── Get Subscription Details ─────────────────────────────────────────────────

export const getSubscriptionDetails = async (userId: number) => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT
      s.id, s.status, s.current_period_end, s.cancel_at_period_end,
      s.stripe_subscription_id, s.stripe_price_id, s.billing_interval,
      d.id         AS draw_id,
      d.name       AS draw_name,
      d.start_date AS draw_start_date,
      d.draw_date  AS draw_date,
      d.status     AS draw_status,
      -- Prize teaser applies here too: an Upcoming enrollment's prize stays hidden from
      -- business dashboards until the admin reveals it (no leak via a partner screen).
      CASE WHEN d.status = 'Upcoming' AND d.prize_revealed = FALSE THEN NULL
           ELSE d.prize_pool END AS prize_amount,
      CASE WHEN fm.id IS NOT NULL THEN true ELSE false END AS is_founding,
      fm.seat_number AS founding_seat_number,
      -- Special Terms Section 6: one-time renewal at the original monthly rate x renewal term.
      -- ONE-TIME option: founding_renewed = the single renewal was already used.
      fm.amount_paid::float AS founding_amount_paid,
      (fm.renewed_at IS NOT NULL) AS founding_renewed,
      s.fee_at_entry,
      s.entries_per_location,
      s.pending_fee_at_entry,
      s.pending_entries_per_location,
      s.skip_next_campaign,
      s.participation_paused,
      (SELECT COUNT(*)::int FROM business_location WHERE business_id = b.id AND is_active = TRUE) AS active_location_count,
      -- What the NEXT campaign runs with: live locations minus scheduled removals plus
      -- staged adds. Shown alongside the staged plan so money and counts always agree.
      (SELECT COUNT(*)::int FROM business_location
       WHERE business_id = b.id
         AND ((is_active = TRUE AND deactivate_at_open = FALSE) OR activate_at_open = TRUE)
      ) AS next_campaign_location_count,
      nd.id         AS next_campaign_id,
      nd.name       AS next_campaign_name,
      nd.start_date AS next_campaign_start_date,
      nd.draw_date  AS next_campaign_date,
      CASE WHEN nd.prize_revealed = FALSE THEN NULL ELSE nd.prize_pool END AS next_campaign_prize,
      b.user_id     AS owner_user_id
    FROM business b
    JOIN subscription s ON s.business_id = b.id
    LEFT JOIN founding_member fm ON fm.business_id = b.id
    LEFT JOIN LATERAL (
      SELECT d2.id, d2.name, d2.start_date, d2.draw_date, d2.status, d2.prize_pool, d2.prize_revealed
      FROM draw_entry de2
      JOIN draw d2 ON d2.id = de2.draw_id
      WHERE de2.business_id = b.id
        AND d2.status IN ('Open', 'Upcoming')
      ORDER BY
        CASE d2.status WHEN 'Open' THEN 0 ELSE 1 END,
        d2.draw_date ASC
      LIMIT 1
    ) d ON true
    LEFT JOIN LATERAL (
      -- The next campaign this business will be enrolled into when the admin opens
      -- it. Enrollment happens at open, so there is no draw_entry yet; this shows
      -- the soonest Upcoming campaign the business will join.
      SELECT d4.id, d4.name, d4.start_date, d4.draw_date, d4.prize_pool, d4.prize_revealed
      FROM draw d4
      WHERE d4.status = 'Upcoming'
      ORDER BY d4.draw_date ASC
      LIMIT 1
    ) nd ON true
    WHERE b.user_id = $1
       OR b.id IN (SELECT business_id FROM business_location WHERE manager_user_id = $1)
  `, [userId]);

  const sub = result.rows[0] ?? null;
  if (sub) {
    // True while a founding member may start a regular plan (final included month or
    // already expired). Computed with the SAME helper the checkout guard uses, so the
    // client banner and the server guard can never disagree.
    sub.founding_transition_available =
      sub.is_founding === true &&
      !sub.stripe_subscription_id &&
      sub.current_period_end != null &&
      isFoundingTransitionWindow(new Date(sub.current_period_end));
    // Renewal banner flag - computed with the SAME window helper the renewal checkout
    // guard uses, so the client never shows a banner the server would reject.
    sub.founding_renewal_open =
      sub.is_founding === true &&
      sub.founding_renewed !== true &&
      sub.status === 'Active' &&
      sub.current_period_end != null &&
      foundingRenewalWindowState(new Date(sub.current_period_end)) === 'open';
    // What the renewal will actually charge (dollars) - SAME formula as the renewal
    // checkout (monthly rate snapshot x renewal term), so the banner price and the
    // Stripe charge can never disagree.
    sub.founding_renewal_price =
      sub.is_founding === true && sub.founding_amount_paid != null
        ? foundingRenewalAmountCents(sub.fee_at_entry, sub.founding_amount_paid) / 100
        : null;
    // True between the 24th charge and the paid campaign's open — the window where the
    // business may opt out of the paid campaign (no refund) and where changes settle
    // their difference immediately. Same rule the server mutations use.
    // Reuse the single source of truth (the same helper the settlement paths use) so the client
    // banner and the server settlement logic can never disagree. Crucially it returns FALSE when
    // no draws exist at all (P3-2) - the old inline calc treated openedAt=null as in-window=true,
    // which showed the "next campaign already paid" copy on a platform with zero campaigns.
    sub.in_charged_window = await isChargedNotOpenedWindow(pool);

    // Location managers may see CAMPAIGN facts (their prep view needs draw name/dates/
    // prize/status) but never the owner's billing: fees, Stripe identifiers, staged plan
    // changes, founding seat, billing window. Null them out rather than dropping the row -
    // the manager client paths only read the campaign fields.
    if (sub.owner_user_id !== userId) {
      sub.fee_at_entry = null;
      sub.entries_per_location = null;
      sub.pending_fee_at_entry = null;
      sub.pending_entries_per_location = null;
      sub.stripe_subscription_id = null;
      sub.stripe_price_id = null;
      sub.current_period_end = null;
      sub.founding_seat_number = null;
      sub.founding_transition_available = false;
      sub.in_charged_window = false;
      // Founding billing facts are the owner's too: what they paid and their renewal state.
      sub.founding_amount_paid = null;
      sub.founding_renewed = null;
      sub.founding_renewal_open = false;
      sub.founding_renewal_price = null;
    }
    delete sub.owner_user_id;
  }
  return sub;
};

// ─── Founding Participation Pause (voluntary cancel, no refund) ───────────────
// Founding Partner cancellation: the Special Terms allow no refund and no early
// termination of the TERM, but the member may stop PARTICIPATING at any time. Pausing
// takes the business off the map immediately and blocks new customer entries; customer
// entries already earned in the running campaign stay valid (draw_entry is kept, same
// H2 rule as everywhere else). While paused the business is not enrolled when campaigns
// open. The founding term keeps running (no extension); reactivation is allowed only
// while current_period_end is still in the future - an expired term needs a new plan.
export const setParticipationPaused = async (userId: number, paused: boolean): Promise<void> => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT s.id, s.current_period_end, (fm.id IS NOT NULL) AS is_founding
    FROM subscription s
    JOIN business b ON b.id = s.business_id
    LEFT JOIN founding_member fm ON fm.business_id = b.id
    WHERE b.user_id = $1 AND s.status != 'Cancelled'
  `, [userId]);
  const sub = result.rows[0];
  if (!sub) throw new Error('No active subscription found');
  // Founding-only until the monthly-plan cancellation model is decided: monthly plans
  // use the Stripe cancel_at_period_end flow instead.
  if (!sub.is_founding) throw new Error('FOUNDING_ONLY');
  if (!paused && (!sub.current_period_end || new Date(sub.current_period_end) < new Date())) {
    throw new Error('FOUNDING_TERM_ENDED');
  }

  await pool.query(
    `UPDATE subscription SET participation_paused = $2, updated_at = NOW() WHERE id = $1`,
    [sub.id, paused],
  );
  invalidatePublicBusinessData();
  console.log(`[Founding] Subscription ${sub.id} participation ${paused ? 'paused (voluntary cancel, no refund)' : 'reactivated'}`);
};

// ─── Resume Subscription ──────────────────────────────────────────────────────

export const resumeSubscription = async (userId: number): Promise<void> => {
  const pool = getPool();

  // Founding memberships are one-time payments — there is nothing to resume
  const foundingCheck = await pool.query(`
    SELECT fm.id FROM founding_member fm
    JOIN business b ON b.id = fm.business_id
    WHERE b.user_id = $1
  `, [userId]);
  if (foundingCheck.rows.length > 0) {
    throw new Error('Founding partner memberships cannot be paused and resumed. Contact support if you need assistance.');
  }

  // participation_paused = true also qualifies (not just cancel_at_period_end): if a
  // prior resume updated Stripe but the DB write failed, the webhook later syncs
  // cancel_at_period_end = false while the pause stays - without this clause the row
  // would never match again and the business would stay off the map while PAYING.
  // Retrying resume here heals that state (the Stripe update is an idempotent no-op).
  const subResult = await pool.query(`
    SELECT s.id, s.stripe_subscription_id, b.id AS business_id
    FROM subscription s
    JOIN business b ON b.id = s.business_id
    WHERE b.user_id = $1 AND (s.cancel_at_period_end = true OR s.participation_paused = true)
      AND s.status != 'Cancelled' AND s.stripe_subscription_id IS NOT NULL
  `, [userId]);

  const sub = subResult.rows[0];
  if (!sub) throw new Error('No pending cancellation found to resume');

  await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: false });

  // participation_paused clears too: a cancel with immediate removal took the business
  // off the map, and resuming means the owner wants back in. Done before the paid
  // campaign opens this restores that spot; after the open the campaign is gone (the
  // owner was warned there is no refund) and enrollment resumes from the next one.
  // skip_next_campaign is cleared defensively (the skip feature was removed; no setters remain).
  await pool.query(
    `UPDATE subscription SET cancel_at_period_end = false, participation_paused = false, skip_next_campaign = false, updated_at = NOW() WHERE id = $1`,
    [sub.id],
  );

  // No draw re-participation needed: the business is Active again, so the next
  // campaign that opens enrolls it like any other paid subscriber.
  invalidatePublicBusinessData();
};

// ─── Cancel Subscription ──────────────────────────────────────────────────────

export type CancelRefundType = 'full' | 'prorated' | 'none';

export interface CancelResult {
  removedFromDraw: boolean;
  refundType: CancelRefundType;
  refundAmount: number; // actual dollars refunded (0 if none)
  // Echo of the owner's choice: true = business removed from the map immediately and not
  // enrolled in the paid upcoming campaign (no refund); false = keeps participating in
  // everything already paid for, the plan just does not renew.
  immediateRemoval: boolean;
}

export const cancelSubscription = async (userId: number, immediate = false): Promise<CancelResult> => {
  const pool = getPool();

  // ── Founding member branch ─────────────────────────────────────────────────
  // Founding Partner Special Terms: a fixed term with NO early termination and
  // NO refund. Cancellation does not exist for founding - the membership runs through
  // its term, stays enrolled in every campaign it covers, and simply does not renew
  // (expiry is automatic: enrollment requires current_period_end >= NOW()).
  const foundingResult = await pool.query(`
    SELECT b.id AS business_id
    FROM founding_member fm
    JOIN business b ON b.id = fm.business_id
    WHERE b.user_id = $1
  `, [userId]);

  if (foundingResult.rows.length > 0) {
    throw new Error('FOUNDING_NO_CANCEL');
  }

  // ── Recurring subscription branch ─────────────────────────────────────────
  const subResult = await pool.query(`
    SELECT s.id, s.stripe_subscription_id, s.status, b.id AS business_id
    FROM subscription s
    JOIN business b ON b.id = s.business_id
    WHERE b.user_id = $1 AND s.status != 'Cancelled'
  `, [userId]);

  const sub = subResult.rows[0];
  if (!sub) throw new Error('No active subscription found');

  // Set cancel at period end on Stripe — the plan never renews and never charges again.
  // The `immediate` flag is the owner's explicit choice from the confirm dialog:
  //  - false: keep participating in everything already paid for (the running campaign
  //    and, after the 24th, the paid upcoming one); the business just isn't renewed.
  //  - true: participation_paused as well - off the map right away, no new customer
  //    entries, and NOT enrolled when the paid upcoming campaign opens. No refund
  //    (the dialog says so explicitly). Customer entries already earned stay valid;
  //    we never remove a business from a draw (draw_entry is untouched).
  // Resume clears both flags - done before the open it restores the paid spot.
  await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
  await pool.query(
    `UPDATE subscription SET cancel_at_period_end = true, participation_paused = (participation_paused OR $2), updated_at = NOW() WHERE id = $1`,
    [sub.id, immediate],
  );

  invalidatePublicBusinessData();
  console.log(`[Cancel] Business ${sub.business_id} set to cancel at period end.${immediate ? ' Removed from participation immediately (no refund).' : ''} No draw change, no refund.`);
  return { removedFromDraw: false, refundType: 'none', refundAmount: 0, immediateRemoval: immediate };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read the subscription id off an invoice across Stripe API versions.
 * Pre-2025 ("acacia" and earlier) exposed `invoice.subscription`; the 2025
 * "Basil" API moved it to `invoice.parent.subscription_details.subscription`.
 * Reading both keeps renewal + payment-failure handling working regardless of
 * the account's API version.
 */
function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  // Structural cast (not `any`): models both API shapes without depending on which one the
  // installed Stripe SDK types declare.
  const inv = invoice as unknown as {
    subscription?: string | { id?: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id?: string } | null } | null } | null;
  };
  const direct = inv.subscription;
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct.id === 'string') return direct.id;
  const nested = inv.parent?.subscription_details?.subscription;
  if (typeof nested === 'string') return nested;
  if (nested && typeof nested.id === 'string') return nested.id;
  return null;
}

/**
 * Read the current period end off a subscription across Stripe API versions.
 * Pre-2025 ("acacia") exposed `subscription.current_period_end`; the 2025 "Basil" API
 * moved it onto the subscription ITEM (`subscription.items.data[0].current_period_end`).
 * Read the item first (Basil), then the legacy root. Throw rather than fabricate a date:
 * this value is the system-of-record for when the paid period ends and drives the founding
 * transition + payment-recovery logic, so a silently wrong date would cause real misbilling.
 */
function extractPeriodEnd(subscription: Stripe.Subscription): Date {
  // Structural cast (not `any`): models both API shapes without depending on which one the
  // installed Stripe SDK types declare.
  const sub = subscription as unknown as {
    current_period_end?: number | null;
    items?: { data?: Array<{ current_period_end?: number | null }> };
  };
  const fromItem = sub.items?.data?.[0]?.current_period_end;
  const fromRoot = sub.current_period_end;
  const raw = typeof fromItem === 'number' && fromItem > 0 ? fromItem
    : typeof fromRoot === 'number' && fromRoot > 0 ? fromRoot
    : null;

  if (raw == null) {
    throw new Error(
      `Stripe subscription ${subscription.id} has no readable current_period_end ` +
      '(checked items[0] and root). Refusing to fabricate a billing period.',
    );
  }
  return new Date(raw * 1000);
}

function mapStripeStatus(stripeStatus: string): string {
  const map: Record<string, string> = {
    active: 'Active',
    trialing: 'Trialing',
    past_due: 'Past_Due',
    canceled: 'Cancelled',
    incomplete: 'Incomplete',
    incomplete_expired: 'Cancelled',
    unpaid: 'Past_Due',
    paused: 'Past_Due',
  };
  return map[stripeStatus] ?? 'Incomplete';
}
