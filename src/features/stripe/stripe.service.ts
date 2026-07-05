import Stripe from 'stripe';
import { Pool } from 'pg';
import { getPool } from '../../shared/db/db.js';
import { sendSubscriptionConfirmationEmail } from '../../shared/email/email.service.js';
import { getPlatformSettings, publicCache, invalidatePublicBusinessData } from '../../shared/cache/cache.js';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) throw new Error('STRIPE_SECRET_KEY is not configured — refusing to start the Stripe client.');
const stripe = new Stripe(stripeSecretKey);

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
export const TIER_PRICE_MAP: Record<number, { envKey: string; price: number }> = {
  250:  { envKey: 'STRIPE_PRICE_ID_250',  price: 250  },
  500:  { envKey: 'STRIPE_PRICE_ID_500',  price: 490  },
  750:  { envKey: 'STRIPE_PRICE_ID_750',  price: 730  },
  1000: { envKey: 'STRIPE_PRICE_ID_1000', price: 920  },
  1250: { envKey: 'STRIPE_PRICE_ID_1250', price: 1140 },
  1500: { envKey: 'STRIPE_PRICE_ID_1500', price: 1360 },
  1750: { envKey: 'STRIPE_PRICE_ID_1750', price: 1500 },
  2000: { envKey: 'STRIPE_PRICE_ID_2000', price: 1710 },
  2250: { envKey: 'STRIPE_PRICE_ID_2250', price: 1910 },
  2500: { envKey: 'STRIPE_PRICE_ID_2500', price: 2050 },
  2750: { envKey: 'STRIPE_PRICE_ID_2750', price: 2250 },
  3000: { envKey: 'STRIPE_PRICE_ID_3000', price: 2460 },
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
): Promise<{ url: string; joinsNextCampaign: boolean; nextCampaignDate: string | null }> => {
  const tier = TIER_PRICE_MAP[entriesPerLocation];
  if (!tier) throw new Error('Invalid entries_per_location value');

  const priceId = process.env[tier.envKey];
  if (!priceId) throw new Error(`${tier.envKey} is not configured`);

  const pool = getPool();
  const existing = await pool.query(
    `SELECT id FROM subscription WHERE business_id = $1 AND status != 'Cancelled'`,
    [businessId],
  );
  if (existing.rows.length > 0) throw new Error('This business already has an active subscription');

  // Detect late-cycle signups (within 7 days of next campaign start).
  // We still allow the subscription — but flag it so the client can inform the business
  // they'll join the NEXT campaign rather than the current one.
  const nowNY = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const nextCampaignStart = new Date(nowNY.getFullYear(), nowNY.getMonth() + 1, 1);
  const msUntilNext = nextCampaignStart.getTime() - nowNY.getTime();
  const daysUntilNext = msUntilNext / (1000 * 60 * 60 * 24);
  const joinsNextCampaign = daysUntilNext <= CAMPAIGN_ONBOARDING_CUTOFF_DAYS;
  const nextCampaignDate = joinsNextCampaign
    ? new Date(nowNY.getFullYear(), nowNY.getMonth() + 2, 1).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  const locResult = await pool.query(
    `SELECT COUNT(*) AS cnt FROM business_location WHERE business_id = $1 AND is_active = true`,
    [businessId],
  );
  const locationCount = Math.max(1, Number(locResult.rows[0]?.cnt ?? 1));

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:8081';

  // Setup mode: collect + save a card without charging now. The subscription
  // itself is created server-side (createSubscriptionForSetupSession) so we can
  // anchor billing to the last day of the month (day_of_month: 31) and make the
  // first partial month free — neither of which Checkout's subscription mode allows.
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

  return { url: session.url as string, joinsNextCampaign, nextCampaignDate };
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

  // ── Recurring subscription branch (setup mode → server-created sub) ─────────
  if (session.mode === 'setup') {
    if (session.status !== 'complete') throw new Error('Setup not completed');
    await createSubscriptionForSetupSession(pool, session);
    return;
  }

  throw new Error('Unrecognized checkout session');
};

// ─── Create Subscription From a Completed Setup Session ───────────────────────
// After a setup-mode Checkout completes (card saved, no charge), create the
// recurring subscription billed on the LAST DAY of each month. Called by BOTH
// the webhook and the success-page verify; idempotent so it can never create two.
async function createSubscriptionForSetupSession(pool: Pool, session: Stripe.Checkout.Session): Promise<void> {
  const businessId = Number(session.metadata?.business_id);
  if (!businessId) throw new Error('Setup session missing business_id');

  // DB-level idempotency: a live subscription already exists for this business.
  const existing = await pool.query(
    `SELECT id FROM subscription WHERE business_id = $1 AND status != 'Cancelled'`,
    [businessId],
  );
  if (existing.rows.length > 0) return;

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

  // day_of_month:31 → bills the last day of every month (Stripe clamps short
  // months). proration_behavior 'none' → no charge for the partial signup month;
  // first charge lands on the next month-end and pays for next month's draw.
  const subscription = await stripe.subscriptions.create(
    {
      customer: customerId,
      items: [{ price: priceId, quantity }],
      default_payment_method: paymentMethodId ?? undefined,
      billing_cycle_anchor_config: { day_of_month: 31 },
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

  await activateBusinessSubscription(pool, businessId, subscription.id, customerId, priceId, currentPeriodEnd, monthlyFee, entriesPerLocation);
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

        // ── Recurring subscription (created from the setup-mode session) ──────
        if (session.mode === 'setup') {
          await createSubscriptionForSetupSession(pool, session);
          console.log(`[Stripe] Webhook created subscription for business ${businessId}`);
        }
      } catch (err: unknown) {
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

        await pool.query(`
          UPDATE subscription
          SET status = $1, current_period_end = $2, cancel_at_period_end = $3, updated_at = NOW()
          WHERE business_id = $4
        `, [status, currentPeriodEnd, cancelAtPeriodEnd, businessId]);

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

        await pool.query(
          `UPDATE subscription SET status = 'Cancelled', updated_at = NOW() WHERE business_id = $1`,
          [businessId],
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

    case 'invoice.payment_failed': {
      try {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = getInvoiceSubscriptionId(invoice);
        if (!subscriptionId) break;

        await pool.query(
          `UPDATE subscription SET status = 'Past_Due', updated_at = NOW() WHERE stripe_subscription_id = $1`,
          [subscriptionId],
        );
        invalidatePublicBusinessData();
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

        // Symmetric counterpart to invoice.payment_failed. A paid invoice means the
        // subscription is current, so clear a stale Past_Due immediately — otherwise a
        // business that just recovered could be skipped by open-time draw enrollment if
        // the authoritative customer.subscription.updated event is delayed or arrives
        // out of order (Stripe does not guarantee ordering between the two).
        //
        // STATUS ONLY — we deliberately do NOT touch current_period_end here. This event
        // also fires for the proration invoices we create in updateSubscriptionPlan /
        // syncSubscriptionQuantity, whose line period is a short proration window; writing
        // it would wrongly shorten the access window. Period sync stays owned by
        // customer.subscription.updated. The `status <> 'Cancelled'` guard prevents
        // resurrecting a cancelled subscription, and a missing row (event ordering vs
        // checkout) is a safe no-op.
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
  // Idempotency guard
  const existing = await pool.query(
    `SELECT id FROM founding_member WHERE stripe_checkout_session_id = $1`,
    [checkoutSessionId],
  );
  if (existing.rows.length > 0) {
    console.log(`[Founding] Session ${checkoutSessionId} already activated — skipping`);
    return;
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

    // One-time payment: no stripe_subscription_id; period ends in 1 year; top entry tier
    const periodEnd = new Date();
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    const monthlyEquivalent = Math.round(120000 / 12) / 100; // $100.00 ($1,200 / 12)

    await client.query(`
      INSERT INTO subscription
        (business_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
         status, current_period_end, cancel_at_period_end, fee_at_entry, entries_per_location, billing_interval)
      VALUES ($1, $4, NULL, NULL, 'Active', $2, false, $3, 1000, 'yearly')
      ON CONFLICT (business_id) DO UPDATE
        SET status               = 'Active',
            stripe_customer_id   = COALESCE(EXCLUDED.stripe_customer_id, subscription.stripe_customer_id),
            stripe_subscription_id = NULL,
            current_period_end   = EXCLUDED.current_period_end,
            cancel_at_period_end = false,
            fee_at_entry         = EXCLUDED.fee_at_entry,
            entries_per_location = 1000,
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

  // Confirmation email — non-fatal
  try {
    const bizResult = await pool.query(`
      SELECT b.name, u.email, fm.seat_number,
             (SELECT founding_member_cap FROM platform_settings WHERE id = 1) AS cap
      FROM business b
      JOIN "user" u ON u.id = b.user_id
      JOIN founding_member fm ON fm.business_id = b.id
      WHERE b.id = $1
    `, [businessId]);
    const biz = bizResult.rows[0];
    if (biz?.email) {
      console.log(`[Founding] Business ${businessId} "${biz.name}" activated as Founding Partner #${biz.seat_number} of ${biz.cap} — email: ${biz.email}`);
    }
  } catch (err: unknown) {
    console.error(`[Founding] Email lookup failed for business ${businessId} (non-fatal):`, err instanceof Error ? err.message : err);
  }
}

// ─── Founding Member: Cancel + Prorated Refund ────────────────────────────────

async function cancelFoundingMembership(
  pool: Pool,
  businessId: number,
  paymentIntentId: string,
): Promise<CancelResult> {
  // Get membership period to calculate time-based refund
  const subResult = await pool.query(
    `SELECT created_at, current_period_end FROM subscription WHERE business_id = $1`,
    [businessId],
  );
  const sub = subResult.rows[0] as { created_at: Date; current_period_end: Date } | undefined;

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
    const periodStart = new Date(sub.created_at);
    const totalMs = periodEnd.getTime() - periodStart.getTime();
    const remainingMs = Math.max(0, periodEnd.getTime() - now.getTime());
    const remainingFraction = totalMs > 0 ? remainingMs / totalMs : 0;
    refundCents = Math.round(120000 * remainingFraction * 0.5);
  }

  // Step 1 — Stripe refund FIRST. A refund cannot be rolled back, so it must precede
  // every DB change: if Stripe rejects it the cancellation aborts and the business
  // keeps its membership intact (no destructive change has happened yet).
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
): Promise<void> {
  console.log(`[Stripe] Activating business ${businessId} — entries/location: ${entriesPerLocation}...`);

  // Both the business UPDATE and subscription INSERT must succeed or both must roll back.
  // If the subscription row fails to insert after the business is marked subscribed,
  // the business would appear active with no subscription record — money taken, no subscription.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO subscription
        (business_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, status, current_period_end, cancel_at_period_end, fee_at_entry, entries_per_location, billing_interval)
      VALUES ($1, $2, $3, $4, 'Active', $5, false, $6, $7, $8)
      ON CONFLICT (business_id) DO UPDATE
        SET stripe_customer_id     = EXCLUDED.stripe_customer_id,
            stripe_subscription_id = EXCLUDED.stripe_subscription_id,
            stripe_price_id        = EXCLUDED.stripe_price_id,
            status                 = 'Active',
            current_period_end     = EXCLUDED.current_period_end,
            cancel_at_period_end   = false,
            fee_at_entry           = EXCLUDED.fee_at_entry,
            entries_per_location   = EXCLUDED.entries_per_location,
            billing_interval       = EXCLUDED.billing_interval,
            updated_at             = NOW()
    `, [businessId, customerId, subscriptionId, priceId, currentPeriodEnd, monthlyFee, entriesPerLocation || null, 'monthly']);

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

  // Send confirmation email — non-fatal
  try {
    const bizResult = await pool.query(
      `SELECT b.name, u.email, s.entries_per_location, s.billing_interval, s.fee_at_entry,
              (SELECT COUNT(*) FROM business_location WHERE business_id = b.id AND is_active = true) AS location_count
       FROM business b
       JOIN "user" u ON u.id = b.user_id
       JOIN subscription s ON s.business_id = b.id
       WHERE b.id = $1`,
      [businessId],
    );
    const biz = bizResult.rows[0];
    if (biz?.email) {
      await sendSubscriptionConfirmationEmail(biz.email, biz.name, {
        entriesPerLocation: biz.entries_per_location,
        billingInterval: biz.billing_interval,
        monthlyFee: biz.fee_at_entry,
        locationCount: Math.max(1, Number(biz.location_count)),
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
// Called after adding/removing a location to keep Stripe quantity in sync.
// Skips silently for founding members (no stripe_subscription_id).
export const syncSubscriptionQuantity = async (userId: number, newLocationCount: number, reason: 'location_added' | 'location_removed' = 'location_added'): Promise<void> => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT
      s.stripe_subscription_id,
      s.stripe_customer_id,
      s.entries_per_location,
      b.id AS business_id
    FROM business b
    JOIN subscription s ON s.business_id = b.id
    WHERE b.user_id = $1
  `, [userId]);

  const sub = result.rows[0];
  if (!sub) return; // no subscription yet — nothing to sync
  if (!sub.stripe_subscription_id) return; // founding member, no Stripe sub — skip

  const tierConfig = TIER_PRICE_MAP[sub.entries_per_location as number];
  if (!tierConfig) throw new Error('Unknown tier');

  const priceId = process.env[tierConfig.envKey];
  if (!priceId) throw new Error(`Stripe price ID not configured for tier ${sub.entries_per_location}`);

  const quantity = Math.max(1, newLocationCount);

  const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['items'] });
  const item = stripeSub.items.data[0];
  if (!item) throw new Error('Stripe subscription item not found');

  // fee_at_entry from the single TIER_PRICE_MAP source of truth (same helper as every
  // other write-path). The post-update unit_amount isn't fetched here, so no cross-check.
  const newTotalFee = resolveMonthlyFee(sub.entries_per_location as number, quantity);

  const changeLabel = reason === 'location_added'
    ? `You added a location. Your plan now covers ${quantity} location${quantity !== 1 ? 's' : ''}.`
    : `You removed a location. Your plan now covers ${quantity} location${quantity !== 1 ? 's' : ''}.`;

  const originalQuantity = item.quantity ?? 1;
  const originalPriceId = item.price.id;

  // Step 1 — queue proration items on Stripe (no invoice yet)
  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    items: [{ id: item.id, price: priceId, quantity }],
    proration_behavior: 'create_prorations',
  });

  try {
    // Step 2 — create draft invoice with description, finalize, and pay
    const draftInvoice = await stripe.invoices.create({
      customer: sub.stripe_customer_id,
      subscription: sub.stripe_subscription_id,
      description: changeLabel,
      auto_advance: false,
    });
    if (!draftInvoice.id) throw new Error('Stripe did not return an invoice id for the proration charge');
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(draftInvoice.id);
    if (finalizedInvoice.status === 'open') {
      await stripe.invoices.pay(draftInvoice.id);
    }
  } catch (invoiceErr) {
    // Roll back the subscription update so Stripe matches our DB
    try {
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        items: [{ id: item.id, price: originalPriceId, quantity: originalQuantity }],
        proration_behavior: 'none',
      });
    } catch (rollbackErr: unknown) {
      console.error('[Stripe] Rollback failed after invoice error:', rollbackErr instanceof Error ? rollbackErr.message : rollbackErr);
    }
    throw invoiceErr;
  }

  // Step 3 — only update DB after Stripe confirms everything succeeded
  await pool.query(
    `UPDATE subscription SET fee_at_entry = $1, updated_at = NOW() WHERE business_id = $2`,
    [newTotalFee, sub.business_id],
  );
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
      s.status,
      b.id AS business_id,
      (SELECT COUNT(*)::int FROM business_location WHERE business_id = b.id AND is_active = TRUE) AS location_count
    FROM business b
    JOIN subscription s ON s.business_id = b.id
    WHERE b.user_id = $1
  `, [userId]);

  const sub = result.rows[0];
  if (!sub) throw new Error('No subscription found');
  if (sub.status === 'Cancelled') throw new Error('Cannot update a cancelled subscription');
  if (!sub.stripe_subscription_id) throw new Error('No Stripe subscription on record');
  if (sub.current_entries_per_location === newEntriesPerLocation) throw new Error('Already on this tier');

  const priceId = process.env[tierConfig.envKey];
  if (!priceId) throw new Error(`Stripe price ID not configured for tier ${newEntriesPerLocation}`);

  const locationCount = Math.max(1, Number(sub.location_count));

  // fee_at_entry from the single TIER_PRICE_MAP source of truth (same helper as every
  // other write-path). The post-update unit_amount isn't fetched here, so no cross-check.
  const newTotalFee = resolveMonthlyFee(newEntriesPerLocation, locationCount);

  // Fetch current Stripe subscription to get the item
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['items'] });
  const item = stripeSub.items.data[0];
  if (!item) throw new Error('Stripe subscription item not found');

  const oldTier = sub.current_entries_per_location as number;
  const direction = newEntriesPerLocation > oldTier ? 'upgraded' : 'downgraded';
  const changeLabel = `You ${direction} your plan from ${oldTier.toLocaleString()} to ${newEntriesPerLocation.toLocaleString()} entries per location.`;

  const originalPriceId = item.price.id;
  const originalQuantity = item.quantity ?? 1;

  // Step 1 — queue proration items on Stripe (no invoice yet)
  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    items: [{ id: item.id, price: priceId, quantity: locationCount }],
    proration_behavior: 'create_prorations',
  });

  try {
    // Step 2 — create draft invoice with description, finalize, and pay
    const draftInvoice = await stripe.invoices.create({
      customer: sub.stripe_customer_id,
      subscription: sub.stripe_subscription_id,
      description: changeLabel,
      auto_advance: false,
    });
    if (!draftInvoice.id) throw new Error('Stripe did not return an invoice id for the plan-change charge');
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(draftInvoice.id);
    if (finalizedInvoice.status === 'open') {
      await stripe.invoices.pay(draftInvoice.id);
    }
  } catch (invoiceErr) {
    // Roll back the subscription update so Stripe matches our DB
    try {
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        items: [{ id: item.id, price: originalPriceId, quantity: originalQuantity }],
        proration_behavior: 'none',
      });
    } catch (rollbackErr: unknown) {
      console.error('[Stripe] Rollback failed after invoice error:', rollbackErr instanceof Error ? rollbackErr.message : rollbackErr);
    }
    throw invoiceErr;
  }

  // Step 3 — only update DB after Stripe confirms everything succeeded.
  // stripe_price_id is updated too so the DB never drifts from the live Stripe price.
  await pool.query(
    `UPDATE subscription
     SET entries_per_location = $1, fee_at_entry = $2, stripe_price_id = $3, updated_at = NOW()
     WHERE business_id = $4`,
    [newEntriesPerLocation, newTotalFee, priceId, sub.business_id],
  );
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

  let stripeInvoices: SubscriptionInvoice[] = [];
  if (stripeCustomerId) {
    const invoiceList = await stripe.invoices.list({
      customer: stripeCustomerId,
      limit: 24,
      expand: ['data.lines'],
    });
    stripeInvoices = invoiceList.data.map((invoice): SubscriptionInvoice => ({
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

  return [...foundingInvoices, ...stripeInvoices].sort((a, b) => b.date - a.date);
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
      d.draw_date  AS draw_date,
      d.status     AS draw_status,
      d.prize_pool AS prize_amount,
      CASE WHEN fm.id IS NOT NULL THEN true ELSE false END AS is_founding,
      fm.seat_number AS founding_seat_number,
      s.fee_at_entry,
      s.entries_per_location,
      (SELECT COUNT(*)::int FROM business_location WHERE business_id = b.id AND is_active = TRUE) AS active_location_count,
      (
        SELECT COUNT(*)::int
        FROM draw_entry de3
        JOIN draw d3 ON d3.id = de3.draw_id
        WHERE de3.business_id = b.id AND d3.status = 'Upcoming'
      ) AS founding_draws_remaining,
      nd.id         AS next_campaign_id,
      nd.name       AS next_campaign_name,
      nd.draw_date  AS next_campaign_date,
      nd.prize_pool AS next_campaign_prize
    FROM business b
    JOIN subscription s ON s.business_id = b.id
    LEFT JOIN founding_member fm ON fm.business_id = b.id
    LEFT JOIN LATERAL (
      SELECT d2.id, d2.name, d2.draw_date, d2.status, d2.prize_pool
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
      SELECT d4.id, d4.name, d4.draw_date, d4.prize_pool
      FROM draw d4
      WHERE d4.status = 'Upcoming'
      ORDER BY d4.draw_date ASC
      LIMIT 1
    ) nd ON true
    WHERE b.user_id = $1
       OR b.id IN (SELECT business_id FROM business_location WHERE manager_user_id = $1)
  `, [userId]);

  return result.rows[0] ?? null;
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

const ONBOARDING_CUTOFF_DAYS = 7;
const CAMPAIGN_ONBOARDING_CUTOFF_DAYS = 7; // days before the 1st of next month where new signups are blocked

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

function extractPeriodEnd(subscription: Stripe.Subscription): Date {
  const raw =
    (subscription as any).current_period_end ??
    (subscription.items?.data?.[0] as any)?.current_period_end ??
    (subscription as any).billing_cycle_anchor;

  if (raw && typeof raw === 'number' && raw > 0) {
    return new Date(raw * 1000);
  }

  console.warn('[Stripe] could not read current_period_end, defaulting to 30 days from now');
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
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
