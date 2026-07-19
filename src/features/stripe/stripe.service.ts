import Stripe from 'stripe';
import { Pool } from 'pg';
import { getPool } from '../../shared/db/db.js';
import { sendSubscriptionConfirmationEmail, sendPaymentFailedEmail, sendFoundingWelcomeEmail, sendDisputeAlertEmail } from '../../shared/email/email.service.js';
import { getPlatformSettings, publicCache, invalidatePublicBusinessData } from '../../shared/cache/cache.js';
import { nextCampaignOpensNy, lastChargeAtNy, CHARGE_DAY_OF_MONTH } from '../../shared/dates.js';

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
    invoice = await stripe.invoices.finalizeInvoice(draft.id);
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
    await stripe.refunds.create({ payment_intent: paymentIntentId, amount: refundCents, metadata: { reason } });
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
// nothing ever flips its status off 'Active' — the year "ends" purely as a date. Founders
// are in EVERY campaign that OPENS before their year ends, so their final included campaign
// is the last one to open inside the year. From that month onward (year ends before the
// next campaign opens — and forever after expiry) they may start a regular plan. Subscribing
// inside this window puts them in that next campaign with no gap: the new subscription bills
// on the last day of this month, which pays for next month's campaign.
export function isFoundingTransitionWindow(currentPeriodEnd: Date): boolean {
  return currentPeriodEnd.getTime() < nextCampaignOpensNy().getTime();
}

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

  // Founding covers up to 3 locations for the flat price. The client hides the offer for
  // larger businesses, but money rules live on the SERVER: same next-campaign count the
  // add-location limit uses, checked at purchase time.
  const locCount = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM business_location
     WHERE business_id = $1
       AND ((is_active = TRUE AND deactivate_at_open = FALSE) OR activate_at_open = TRUE)`,
    [businessId],
  );
  if (Number(locCount.rows[0]?.cnt ?? 0) > 3) throw new Error('FOUNDING_LOCATION_LIMIT');

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:8081';

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: userEmail,
    customer_creation: 'always',
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: 120000, // $1,200.00
        product_data: {
          name: 'Founding Partner - Winnbell',
          description: 'One-time membership. Full year. 1,000 entries per location per month.',
        },
      },
    }],
    metadata: { business_id: String(businessId), founding: 'true' },
    // Stamp the PaymentIntent too so the one-time charge is findable in the Stripe
    // dashboard by business_id (Checkout metadata does not propagate to the PI).
    payment_intent_data: { metadata: { business_id: String(businessId), founding: 'true' } },
    success_url: `${baseUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/subscribe`,
  });

  return { url: session.url as string };
};

// ─── Founding Member: Count / Availability ────────────────────────────────────

export const getFoundingMemberCount = async (): Promise<{
  taken: number; remaining: number; cap: number; price: number; active: boolean;
}> => {
  const CACHE_KEY = 'founding:availability';
  const cached = publicCache.get<{ taken: number; remaining: number; cap: number; price: number; active: boolean }>(CACHE_KEY);
  if (cached !== undefined) return cached;

  const pool = getPool();
  const [settings, countResult] = await Promise.all([
    getPlatformSettings(),
    pool.query(`SELECT COUNT(*)::int AS taken FROM founding_member`),
  ]);
  const taken = countResult.rows[0]?.taken ?? 0;
  const cap = settings.founding_member_cap ?? 30;
  const active = settings.founding_phase_active ?? true;
  const value = { taken, remaining: Math.max(0, cap - taken), cap, price: 1200, active };
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
  // window (their prepaid year no longer covers the next campaign, or already ended).
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

export const verifyAndActivateSession = async (sessionId: string, userId: number): Promise<void> => {
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
    await activateFoundingMember(pool, businessId, paymentIntentId, sessionId, customerId);
    invalidatePublicBusinessData();
    return;
  }

  // ── Update payment method branch (setup mode with an existing customer) ─────
  if (session.mode === 'setup' && session.metadata?.purpose === 'update_payment_method') {
    if (session.status !== 'complete') throw new Error('Setup not completed');
    await handleUpdatePaymentMethodSession(pool, session);
    return;
  }

  // ── Recurring subscription branch (setup mode → server-created sub) ─────────
  if (session.mode === 'setup') {
    if (session.status !== 'complete') throw new Error('Setup not completed');
    await createSubscriptionForSetupSession(pool, session);
    return;
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
async function createSubscriptionForSetupSession(pool: Pool, session: Stripe.Checkout.Session): Promise<void> {
  const businessId = Number(session.metadata?.business_id);
  if (!businessId) throw new Error('Setup session missing business_id');

  // DB-level idempotency: a live subscription already exists for this business.
  // A founding membership (no Stripe subscription behind it) does NOT count — the
  // checkout guard only lets founding members reach setup mode inside their transition
  // window, and this new subscription is what replaces the founding one. After the
  // replacement the row has a stripe_subscription_id, so a duplicate webhook/verify
  // call still returns here.
  const existing = await pool.query(
    `SELECT s.stripe_subscription_id,
            EXISTS(SELECT 1 FROM founding_member fm WHERE fm.business_id = s.business_id) AS is_founding
     FROM subscription s
     WHERE s.business_id = $1 AND s.status != 'Cancelled'`,
    [businessId],
  );
  const existingSub = existing.rows[0];
  if (existingSub && !(existingSub.is_founding && !existingSub.stripe_subscription_id)) return;

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
        if (periodEnd !== null) {
          await pool.query(
            `UPDATE subscription
             SET current_period_end = $2, cancel_at_period_end = $3, updated_at = NOW()
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
          await activateFoundingMember(pool, businessId, paymentIntentId, session.id, customerId);
          invalidatePublicBusinessData();
          console.log(`[Stripe] Webhook activated founding member for business ${businessId}`);
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
        await pool.query(`
          UPDATE subscription
          SET status = $1, current_period_end = $2, cancel_at_period_end = $3, updated_at = NOW()
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
              await sendPaymentFailedEmail(biz.rows[0].email, biz.rows[0].name, invoice.amount_due / 100);
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
  customerId: string | null = null,
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
    // session. Auto-refund this second $1,200 in full and record it on the ledger as
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
      VALUES ($1, $2, $3, 1200.00, 1200.00)
      ON CONFLICT (stripe_payment_intent_id) DO NOTHING
    `, [businessId, paymentIntentId, checkoutSessionId]);
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
      SELECT $1, seat_number, $2, $3, 1200.00
      FROM available_seat
      RETURNING seat_number
    `, [businessId, paymentIntentId, checkoutSessionId]);

    if ((seatResult.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      console.error(`[Founding] No seats available for business ${businessId} — issuing auto-refund`);
      try {
        await stripe.refunds.create({ payment_intent: paymentIntentId });
      } catch (refundErr: unknown) {
        console.error(`[Founding] Auto-refund failed: ${refundErr instanceof Error ? refundErr.message : refundErr}`);
      }
      throw new Error('All founding partner spots were claimed while your payment was processing. A full refund has been issued.');
    }

    seatNumber = seatResult.rows[0].seat_number as number;
    console.log(`[Founding] Business ${businessId} claimed seat #${seatNumber}`);

    // One-time payment: no stripe_subscription_id; period ends in 1 year; Growth-tier
    // entry allowance (2500 per location).
    const periodEnd = new Date();
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    const monthlyEquivalent = Math.round(120000 / 12) / 100; // $100.00 ($1,200 / 12)

    await client.query(`
      INSERT INTO subscription
        (business_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
         status, current_period_end, cancel_at_period_end, fee_at_entry, entries_per_location, billing_interval)
      VALUES ($1, $4, NULL, NULL, 'Active', $2, false, $3, 2500, 'yearly')
      ON CONFLICT (business_id) DO UPDATE
        SET status               = 'Active',
            stripe_customer_id   = COALESCE(EXCLUDED.stripe_customer_id, subscription.stripe_customer_id),
            stripe_subscription_id = NULL,
            current_period_end   = EXCLUDED.current_period_end,
            cancel_at_period_end = false,
            fee_at_entry         = EXCLUDED.fee_at_entry,
            entries_per_location = 2500,
            billing_interval     = 'yearly',
            updated_at           = NOW()
    `, [businessId, periodEnd, monthlyEquivalent, customerId]);

    // Append to the durable payment ledger. Unlike founding_member (one row per
    // business, deleted on cancel), this is append-only so the plan page can show
    // full history across cancel→repurchase cycles. ON CONFLICT keeps it idempotent.
    await client.query(`
      INSERT INTO founding_payment (business_id, stripe_payment_intent_id, stripe_checkout_session_id, amount)
      VALUES ($1, $2, $3, 1200.00)
      ON CONFLICT (stripe_payment_intent_id) DO NOTHING
    `, [businessId, paymentIntentId, checkoutSessionId]);

    await client.query('COMMIT');
    console.log(`[Founding] subscription row upserted for business ${businessId} (seat #${seatNumber})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Enrollment happens when the admin opens the next campaign — founding members
  // are Active and within their prepaid year, so they get enrolled like anyone else.

  // Welcome email — non-fatal (activation is already committed)
  try {
    const bizResult = await pool.query(`
      SELECT b.name, u.email, fm.seat_number, s.current_period_end,
             (SELECT founding_member_cap FROM platform_settings WHERE id = 1) AS cap
      FROM business b
      JOIN "user" u ON u.id = b.user_id
      JOIN founding_member fm ON fm.business_id = b.id
      JOIN subscription s ON s.business_id = b.id
      WHERE b.id = $1
    `, [businessId]);
    const biz = bizResult.rows[0];
    if (biz?.email) {
      await sendFoundingWelcomeEmail(biz.email, biz.name, {
        seatNumber: Number(biz.seat_number),
        cap: Number(biz.cap ?? 30),
        termEnd: new Date(biz.current_period_end),
      });
    }
  } catch (err: unknown) {
    console.error(`[Founding] Welcome email failed for business ${businessId} (non-fatal):`, err instanceof Error ? err.message : err);
  }
}

// ─── Founding Member: Cancel + Prorated Refund ────────────────────────────────

async function cancelFoundingMembership(
  pool: Pool,
  businessId: number,
  paymentIntentId: string,
): Promise<CancelResult> {
  // Membership period for the time-based refund. The year STARTS at the founding payment
  // (founding_member.paid_at) - NOT subscription.created_at, which can be years older when
  // the business had a regular plan before buying founding (the upsert never resets it)
  // and would wrongly shrink the refund.
  const subResult = await pool.query(
    `SELECT fm.paid_at, s.current_period_end
     FROM founding_member fm
     JOIN subscription s ON s.business_id = fm.business_id
     WHERE fm.business_id = $1`,
    [businessId],
  );
  const sub = subResult.rows[0] as { paid_at: Date; current_period_end: Date } | undefined;

  // 50% refund of remaining time: $1,200 × (days_remaining / total_days) × 0.5.
  // The refund is issued BEFORE any destructive change — if Stripe rejects it,
  // the whole cancellation aborts and the business keeps its membership intact.
  // (Previously a failed refund was logged "non-fatal" while the membership was
  // still deleted and the user told a refund was issued.)
  let refundType: CancelRefundType = 'none';
  let refundAmount = 0;
  let refundCents = 0;

  if (sub) {
    const now = new Date();
    const periodEnd = new Date(sub.current_period_end);
    const periodStart = new Date(sub.paid_at);
    const totalMs = periodEnd.getTime() - periodStart.getTime();
    const remainingMs = Math.max(0, periodEnd.getTime() - now.getTime());
    const remainingFraction = totalMs > 0 ? remainingMs / totalMs : 0;
    refundCents = Math.round(120000 * remainingFraction * 0.5);
  }

  // Step 1 — Stripe refund FIRST. A refund cannot be rolled back, so it must precede
  // every DB change: if Stripe rejects it the cancellation aborts and the business
  // keeps its membership intact (no destructive change has happened yet).
  if (refundCents > 0) {
    // Double-refund guard: Stripe is the source of truth for prior refunds. If an earlier
    // cancel attempt refunded but our DB commit then failed, the ledger never recorded it —
    // a retry must NOT refund again. Cap by what Stripe says was already returned. If we
    // cannot verify, abort rather than risk paying twice.
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
      const charge = pi.latest_charge;
      const alreadyRefundedCents = charge && typeof charge !== 'string' ? (charge.amount_refunded ?? 0) : 0;
      if (alreadyRefundedCents > 0) {
        console.warn(`[Founding] Business ${businessId}: $${(alreadyRefundedCents / 100).toFixed(2)} already refunded on Stripe (prior attempt) — capping this refund.`);
      }
      refundCents = Math.max(0, refundCents - alreadyRefundedCents);
    } catch (err: unknown) {
      console.error(`[Founding] Could not verify prior refunds — cancellation aborted for business ${businessId}: ${err instanceof Error ? err.message : err}`);
      throw new Error('REFUND_FAILED');
    }
  }
  if (refundCents > 0) {
    try {
      await stripe.refunds.create({ payment_intent: paymentIntentId, amount: refundCents });
    } catch (err: unknown) {
      console.error(`[Founding] Stripe refund failed — cancellation aborted for business ${businessId}: ${err instanceof Error ? err.message : err}`);
      throw new Error('REFUND_FAILED');
    }
    refundAmount = refundCents / 100;
    refundType = 'prorated'; // always 50% of remaining time — never the full payment
  }

  // Step 2 — all DB writes atomically. Record the refund on the ledger AND apply the
  // destructive cancellation in ONE transaction, so the business is never left
  // half-cancelled (e.g. refunded but still a founding_member with an active sub).
  const client = await pool.connect();
  let removedFromDraw = false;
  let removedCount = 0;
  try {
    await client.query('BEGIN');

    if (refundAmount > 0) {
      // Ledger record so the plan page shows net/refund state from the DB alone.
      await client.query(
        `UPDATE founding_payment SET refunded_amount = refunded_amount + $1 WHERE stripe_payment_intent_id = $2`,
        [refundAmount, paymentIntentId],
      );
    }

    // Remove from all upcoming draws
    const deleteResult = await client.query(
      `DELETE FROM draw_entry de
       USING draw d
       WHERE de.draw_id = d.id AND de.business_id = $1 AND d.status = 'Upcoming'
       RETURNING de.draw_id`,
      [businessId],
    );
    removedCount = deleteResult.rowCount ?? 0;
    removedFromDraw = removedCount > 0;

    // Remove founding_member record entirely — they had their chance, no longer founding.
    await client.query(`DELETE FROM founding_member WHERE business_id = $1`, [businessId]);

    // Cancel subscription immediately (one-time payment, nothing to cancel on Stripe).
    await client.query(
      `UPDATE subscription SET status = 'Cancelled', cancel_at_period_end = false, updated_at = NOW()
       WHERE business_id = $1`,
      [businessId],
    );

    await client.query('COMMIT');
    console.log(`[Founding] Business ${businessId} cancelled. Removed from ${removedCount} upcoming draws. Refunded $${refundAmount} (50% of remaining time).`);
  } catch (err) {
    await client.query('ROLLBACK');
    // Stripe-vs-DB can't be one atomic unit: if the refund already went through but the
    // DB cancellation rolled back, the money was returned yet the membership is intact.
    // This is the unavoidable edge — make it LOUD so ops can reconcile manually.
    if (refundAmount > 0) {
      console.error(
        `[Founding] CRITICAL: refund of $${refundAmount} was issued to Stripe for business ${businessId} ` +
        `but the DB cancellation ROLLED BACK — manual reconciliation needed.`,
        err instanceof Error ? err.message : err,
      );
    }
    throw err;
  } finally {
    client.release();
  }

  invalidatePublicBusinessData();
  return { removedFromDraw, refundType, refundAmount };
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
    // regular plan. The founding seat ends here (row deleted; the $1,200 stays in the
    // append-only founding_payment ledger). When the founding year still covers the
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
      // is in every campaign that opened inside their year (even one that draws after
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
              billing_interval       = EXCLUDED.billing_interval,
              updated_at             = NOW()
      `, [businessId, customerId, subscriptionId, priceId, currentPeriodEnd, monthlyFee, entriesPerLocation || null, 'monthly', initialStatus]);
    }

    await client.query('COMMIT');
    console.log(`[Stripe] subscription row upserted for business ${businessId}`);
  } catch (err) {
    await client.query('ROLLBACK');
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
  await pool.query(
    `UPDATE subscription
     SET pending_entries_per_location = $1, pending_fee_at_entry = $2, updated_at = NOW()
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

export const updateSubscriptionPlan = async (userId: number, newEntriesPerLocation: number): Promise<void> => {
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
  await pool.query(
    `UPDATE subscription
     SET pending_entries_per_location = $1, pending_fee_at_entry = $2, stripe_price_id = $3, updated_at = NOW()
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
};

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
  // The founding ledger is append-only and records refunds when issued, so the
  // history read is pure DB — no per-load Stripe call.
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
  // one-time payments, and founding_member is wiped on cancel. The founding_payment
  // ledger is the source of truth for history.
  // Founding payments are one-time PaymentIntents (no Stripe invoices). A business that later
  // resubscribes to a regular plan keeps its founding_payment ledger rows, so we must show BOTH
  // the founding history AND any recurring Stripe invoices - merged, newest first - not one or the other.
  const foundingRows = result.rows.filter(r => r.stripe_payment_intent_id);
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
      hosted_invoice_url: null,
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

  let stripeInvoices: SubscriptionInvoice[] = [];
  if (stripeCustomerId) {
    const invoiceList = await stripe.invoices.list({
      customer: stripeCustomerId,
      limit: 24,
      expand: ['data.lines'],
    });
    stripeInvoices = invoiceList.data
      // Drop Stripe accounting artifacts: subscription creation (and similar) produces a
      // $0 invoice that Stripe instantly marks "paid". No money moved and there is no
      // description to explain anything, so showing it as a payment only confuses the
      // business. Zero-total invoices WITH a description (change notes) are kept.
      .filter((invoice) => !(invoice.amount_due === 0 && invoice.amount_paid === 0 && !invoice.description))
      .map((invoice): SubscriptionInvoice => ({
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
      hosted_invoice_url: invoice.hosted_invoice_url ?? null,
    }));
  }

  // Refunds on regular (Stripe-invoice) charges. In-window downgrades and location removals
  // refund against the ORIGINAL charge's PaymentIntent — that does not change the already-paid
  // invoice, so the refund would otherwise be invisible in history. Surface each succeeded
  // refund as its own entry. Founding refunds are already shown via the founding_payment
  // ledger above, so skip any PaymentIntent that belongs to a founding payment.
  const foundingPIs = new Set(foundingRows.map((r) => r.stripe_payment_intent_id as string));
  let refundEntries: SubscriptionInvoice[] = [];
  if (stripeCustomerId) {
    const chargeList = await stripe.charges.list({ customer: stripeCustomerId, limit: 24, expand: ['data.refunds'] });
    for (const charge of chargeList.data) {
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
          hosted_invoice_url: null,
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
      d.prize_pool AS prize_amount,
      CASE WHEN fm.id IS NOT NULL THEN true ELSE false END AS is_founding,
      fm.seat_number AS founding_seat_number,
      s.fee_at_entry,
      s.entries_per_location,
      s.pending_fee_at_entry,
      s.pending_entries_per_location,
      s.skip_next_campaign,
      (SELECT d5.opened_at FROM draw d5 WHERE d5.status = 'Open' ORDER BY d5.opened_at DESC NULLS LAST LIMIT 1) AS open_campaign_opened_at,
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
      nd.prize_pool AS next_campaign_prize
    FROM business b
    JOIN subscription s ON s.business_id = b.id
    LEFT JOIN founding_member fm ON fm.business_id = b.id
    LEFT JOIN LATERAL (
      SELECT d2.id, d2.name, d2.start_date, d2.draw_date, d2.status, d2.prize_pool
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
      SELECT d4.id, d4.name, d4.start_date, d4.draw_date, d4.prize_pool
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
    // True between the 24th charge and the paid campaign's open — the window where the
    // business may opt out of the paid campaign (no refund) and where changes settle
    // their difference immediately. Same rule the server mutations use.
    const openedAt = sub.open_campaign_opened_at ? new Date(sub.open_campaign_opened_at).getTime() : null;
    sub.in_charged_window = openedAt === null || lastChargeAtNy().getTime() > openedAt;
    delete sub.open_campaign_opened_at;
  }
  return sub;
};

// ─── Skip the Paid Campaign (opt out, no refund) ──────────────────────────────
// After the 24th charge a business cannot cancel the upcoming campaign, but it may opt
// out of participating in it — no refund. The flag is consumed at the next campaign open
// (enrollment skips the business, then resets it). Only available inside the charged
// window; once the campaign opens, removal is an admin/support action.
export const setSkipNextCampaign = async (userId: number, skip: boolean): Promise<void> => {
  const pool = getPool();

  if (skip && !(await isChargedNotOpenedWindow(pool))) {
    throw new Error('SKIP_WINDOW_CLOSED');
  }

  const result = await pool.query(
    `UPDATE subscription s
     SET skip_next_campaign = $2, updated_at = NOW()
     FROM business b
     WHERE b.id = s.business_id AND b.user_id = $1 AND s.status != 'Cancelled'
     RETURNING s.id`,
    [userId, skip],
  );
  if (result.rowCount === 0) throw new Error('No active subscription found');
  invalidatePublicBusinessData();
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

  const subResult = await pool.query(`
    SELECT s.id, s.stripe_subscription_id, b.id AS business_id
    FROM subscription s
    JOIN business b ON b.id = s.business_id
    WHERE b.user_id = $1 AND s.cancel_at_period_end = true AND s.status != 'Cancelled'
  `, [userId]);

  const sub = subResult.rows[0];
  if (!sub) throw new Error('No pending cancellation found to resume');

  await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: false });

  await pool.query(
    `UPDATE subscription SET cancel_at_period_end = false, updated_at = NOW() WHERE id = $1`,
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
}

export const cancelSubscription = async (userId: number): Promise<CancelResult> => {
  const pool = getPool();

  // ── Founding member branch ─────────────────────────────────────────────────
  const foundingResult = await pool.query(`
    SELECT fm.stripe_payment_intent_id, b.id AS business_id
    FROM founding_member fm
    JOIN business b ON b.id = fm.business_id
    WHERE b.user_id = $1
  `, [userId]);

  if (foundingResult.rows.length > 0) {
    const { business_id, stripe_payment_intent_id } = foundingResult.rows[0];
    return cancelFoundingMembership(pool, business_id, stripe_payment_intent_id);
  }

  // ── Recurring subscription branch ─────────────────────────────────────────
  const subResult = await pool.query(`
    SELECT s.id, s.stripe_subscription_id, b.id AS business_id
    FROM subscription s
    JOIN business b ON b.id = s.business_id
    WHERE b.user_id = $1 AND s.status != 'Cancelled'
  `, [userId]);

  const sub = subResult.rows[0];
  if (!sub) throw new Error('No active subscription found');

  // Set cancel at period end on Stripe — the business keeps access AND its current
  // paid draw until the period ends. We never remove from a draw on cancel; a
  // Cancelled business simply isn't enrolled when the next campaign opens.
  await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
  await pool.query(
    `UPDATE subscription SET cancel_at_period_end = true, updated_at = NOW() WHERE id = $1`,
    [sub.id],
  );

  invalidatePublicBusinessData();
  console.log(`[Cancel] Business ${sub.business_id} set to cancel at period end. No draw change, no refund.`);
  return { removedFromDraw: false, refundType: 'none', refundAmount: 0 };
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
