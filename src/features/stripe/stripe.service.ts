import Stripe from 'stripe';
import { Pool } from 'pg';
import { getPool } from '../../shared/db/db.js';
import { sendSubscriptionConfirmationEmail } from '../../shared/email/email.service.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  return d;
}

// ─── Get Business For Checkout ────────────────────────────────────────────────

export const getBusinessForCheckout = async (userId: number): Promise<{ id: number; email: string } | null> => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT b.id, u.email FROM business b JOIN "user" u ON u.id = b.user_id WHERE b.user_id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
};

// ─── Tier Price Map ────────────────────────────────────────────────────────────
// Each tier has its own Stripe price ID (set in .env) and a fixed price per location/month.
// Quantity sent to Stripe = number of locations (not cap units) — making pricing non-linear.
export const TIER_PRICE_MAP: Record<number, {
  monthly: { envKey: string; pricePerLocation: number };
  yearly:  { envKey: string; pricePerLocation: number };
}> = {
  250:  { monthly: { envKey: 'STRIPE_PRICE_ID_250',         pricePerLocation: 250   }, yearly: { envKey: 'STRIPE_PRICE_ID_250_YEARLY',  pricePerLocation: 3000  } },
  500:  { monthly: { envKey: 'STRIPE_PRICE_ID_500',         pricePerLocation: 490   }, yearly: { envKey: 'STRIPE_PRICE_ID_500_YEARLY',  pricePerLocation: 5880  } },
  750:  { monthly: { envKey: 'STRIPE_PRICE_ID_750',         pricePerLocation: 720   }, yearly: { envKey: 'STRIPE_PRICE_ID_750_YEARLY',  pricePerLocation: 8640  } },
  1000: { monthly: { envKey: 'STRIPE_PRICE_ID_1000',        pricePerLocation: 940   }, yearly: { envKey: 'STRIPE_PRICE_ID_1000_YEARLY', pricePerLocation: 11280 } },
  1250: { monthly: { envKey: 'STRIPE_PRICE_ID_1250',        pricePerLocation: 1150  }, yearly: { envKey: 'STRIPE_PRICE_ID_1250_YEARLY', pricePerLocation: 13800 } },
  1500: { monthly: { envKey: 'STRIPE_PRICE_ID_1500',        pricePerLocation: 1350  }, yearly: { envKey: 'STRIPE_PRICE_ID_1500_YEARLY', pricePerLocation: 16200 } },
  1750: { monthly: { envKey: 'STRIPE_PRICE_ID_1750',        pricePerLocation: 1540  }, yearly: { envKey: 'STRIPE_PRICE_ID_1750_YEARLY', pricePerLocation: 18480 } },
  2000: { monthly: { envKey: 'STRIPE_PRICE_ID_2000',        pricePerLocation: 1720  }, yearly: { envKey: 'STRIPE_PRICE_ID_2000_YEARLY', pricePerLocation: 20640 } },
  2250: { monthly: { envKey: 'STRIPE_PRICE_ID_2250',        pricePerLocation: 1890  }, yearly: { envKey: 'STRIPE_PRICE_ID_2250_YEARLY', pricePerLocation: 22680 } },
  2500: { monthly: { envKey: 'STRIPE_PRICE_ID_2500',        pricePerLocation: 2000  }, yearly: { envKey: 'STRIPE_PRICE_ID_2500_YEARLY', pricePerLocation: 24000 } },
};

// ─── Founding Member: Checkout Session ────────────────────────────────────────

export const createFoundingMemberCheckoutSession = async (
  businessId: number,
  userEmail: string,
): Promise<{ url: string }> => {
  const pool = getPool();

  const settingsResult = await pool.query(
    `SELECT founding_member_cap, founding_phase_active FROM platform_settings WHERE id = 1`,
  );
  const settings = settingsResult.rows[0];
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
    success_url: `${baseUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/subscribe`,
  });

  return { url: session.url as string };
};

// ─── Founding Member: Count / Availability ────────────────────────────────────

export const getFoundingMemberCount = async (): Promise<{
  taken: number; remaining: number; cap: number; price: number; active: boolean;
}> => {
  const pool = getPool();
  const [settingsResult, countResult] = await Promise.all([
    pool.query(`SELECT founding_member_cap, founding_phase_active FROM platform_settings WHERE id = 1`),
    pool.query(`SELECT COUNT(*)::int AS taken FROM founding_member`),
  ]);
  const settings = settingsResult.rows[0] ?? { founding_member_cap: 30, founding_phase_active: true };
  const taken = countResult.rows[0]?.taken ?? 0;
  const cap = settings.founding_member_cap ?? 30;
  const active = settings.founding_phase_active ?? true;
  return { taken, remaining: Math.max(0, cap - taken), cap, price: 1000, active };
};

// ─── Create Checkout Session ──────────────────────────────────────────────────

export const createCheckoutSession = async (
  businessId: number,
  userEmail: string,
  entriesPerLocation: number,
  billingInterval: 'monthly' | 'yearly' = 'monthly',
): Promise<{ url: string; joinsNextCampaign: boolean; nextCampaignDate: string | null }> => {
  const tier = TIER_PRICE_MAP[entriesPerLocation];
  if (!tier) throw new Error('Invalid entries_per_location value');

  const tierConfig = tier[billingInterval];
  const priceId = process.env[tierConfig.envKey];
  if (!priceId) throw new Error(`${tierConfig.envKey} is not configured`);

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

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: userEmail,
    line_items: [{ price: priceId, quantity: locationCount }],
    metadata: { business_id: String(businessId), entries_per_location: String(entriesPerLocation), billing_interval: billingInterval },
    subscription_data: { metadata: { business_id: String(businessId), entries_per_location: String(entriesPerLocation), billing_interval: billingInterval } },
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

  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription', 'subscription.items'],
  });

  if (session.payment_status !== 'paid') throw new Error('Payment not completed');
  if (session.metadata?.business_id !== String(businessId)) throw new Error('Session does not belong to this business');

  // ── Founding member one-time payment branch ────────────────────────────────
  if (session.mode === 'payment' && session.metadata?.founding === 'true') {
    const paymentIntentId = session.payment_intent as string;
    await activateFoundingMember(pool, businessId, paymentIntentId, sessionId);
    return;
  }

  // ── Recurring subscription branch ─────────────────────────────────────────
  const subscription = session.subscription as Stripe.Subscription;

  // Idempotency guard: if this Stripe subscription is already activated, skip re-processing
  const existingCheck = await pool.query(
    `SELECT id FROM subscription WHERE stripe_subscription_id = $1`,
    [subscription.id],
  );
  if (existingCheck.rows.length > 0) return; // Already activated — safe to return success

  const customerId = session.customer as string;
  const priceItem = subscription.items.data[0];
  const priceId = priceItem?.price.id ?? '';
  const quantity = priceItem?.quantity ?? 1;
  const billingInterval: 'monthly' | 'yearly' =
    priceItem?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';
  const rawFee = Math.round((priceItem?.price.unit_amount ?? 0) * quantity) / 100;
  const monthlyEquivalentFee = billingInterval === 'yearly' ? rawFee / 12 : rawFee;
  const currentPeriodEnd = extractPeriodEnd(subscription);
  const entriesPerLocation = Number(session.metadata?.entries_per_location ?? 0);

  await activateBusinessSubscription(pool, businessId, subscription.id, customerId, priceId, currentPeriodEnd, monthlyEquivalentFee, entriesPerLocation, billingInterval);
};

// ─── Handle Webhook ───────────────────────────────────────────────────────────

export const handleStripeWebhook = async (rawBody: Buffer, signature: string): Promise<void> => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET as string;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err: any) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  const pool = getPool();

  switch (event.type) {

    case 'checkout.session.completed': {
      try {
        const session = event.data.object as Stripe.Checkout.Session;
        const businessId = Number(session.metadata?.business_id);
        if (!businessId) { console.error('[Stripe] checkout.session.completed: missing business_id', session.id); break; }

        // ── Founding member one-time payment ────────────────────────────────
        if (session.mode === 'payment' && session.metadata?.founding === 'true') {
          const paymentIntentId = session.payment_intent as string;
          await activateFoundingMember(pool, businessId, paymentIntentId, session.id);
          console.log(`[Stripe] Webhook activated founding member for business ${businessId}`);
          break;
        }

        // ── Recurring subscription ───────────────────────────────────────────
        const subscriptionId = session.subscription as string;
        if (!subscriptionId) { console.error('[Stripe] checkout.session.completed: no subscription', session.id); break; }

        const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items'] });
        const customerId = session.customer as string;
        const priceItem = subscription.items.data[0];
        const priceId = priceItem?.price.id ?? '';
        const quantity = priceItem?.quantity ?? 1;
        const billingInterval: 'monthly' | 'yearly' =
          (session.metadata?.billing_interval === 'yearly') ? 'yearly' : 'monthly';
        const rawFee = Math.round((priceItem?.price.unit_amount ?? 0) * quantity) / 100;
        const monthlyEquivalentFee = billingInterval === 'yearly' ? rawFee / 12 : rawFee;
        const currentPeriodEnd = extractPeriodEnd(subscription);
        const entriesPerLocation = Number(session.metadata?.entries_per_location ?? 0);

        await activateBusinessSubscription(pool, businessId, subscriptionId, customerId, priceId, currentPeriodEnd, monthlyEquivalentFee, entriesPerLocation, billingInterval);
        console.log(`[Stripe] Webhook activated business ${businessId}`);
      } catch (err: any) {
        console.error('[Stripe] ERROR in checkout.session.completed:', err.message);
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
        const isActive = status === 'Active' || status === 'Trialing';
        const previousStatus = (event.data as any).previous_attributes?.status;

        await pool.query(`
          UPDATE subscription
          SET status = $1, current_period_end = $2, cancel_at_period_end = $3, updated_at = NOW()
          WHERE business_id = $4
        `, [status, currentPeriodEnd, cancelAtPeriodEnd, businessId]);


        if (isActive && previousStatus && previousStatus !== 'active') {
          const priceItem = subscription.items.data[0];
          const quantity = priceItem?.quantity ?? 1;
          const billingInterval: 'monthly' | 'yearly' = priceItem?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';
          const rawFee = Math.round((priceItem?.price.unit_amount ?? 0) * quantity) / 100;
          const monthlyEquivalentFee = billingInterval === 'yearly' ? rawFee / 12 : rawFee;
          if (billingInterval === 'yearly') {
            await handleYearlyDrawParticipation(pool, businessId, monthlyEquivalentFee);
          } else {
            await handleDrawParticipation(pool, businessId, monthlyEquivalentFee);
          }
        }
      } catch (err: any) {
        console.error('[Stripe] ERROR in customer.subscription.updated:', err.message);
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
        await pool.query(
          `DELETE FROM draw_entry de
           USING draw d
           WHERE de.draw_id = d.id AND de.business_id = $1 AND d.status = 'Upcoming'`,
          [businessId],
        );
        console.log(`[Stripe] Business ${businessId} deactivated`);
      } catch (err: any) {
        console.error('[Stripe] ERROR in customer.subscription.deleted:', err.message);
        throw err;
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      try {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = (invoice as any).subscription as string | null;
        if (!subscriptionId) break;

        const billingReason = (invoice as any).billing_reason as string | null;
        if (billingReason !== 'subscription_cycle') break;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items'] });
        const businessId = Number(subscription.metadata?.business_id);
        if (!businessId) break;

        const priceItem = subscription.items.data[0];
        const quantity = priceItem?.quantity ?? 1;
        const billingInterval: 'monthly' | 'yearly' = priceItem?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';
        const rawFee = Math.round((priceItem?.price.unit_amount ?? 0) * quantity) / 100;
        const monthlyEquivalentFee = billingInterval === 'yearly' ? rawFee / 12 : rawFee;

        if (billingInterval === 'yearly') {
          await handleYearlyDrawParticipation(pool, businessId, monthlyEquivalentFee);
        } else {
          await handleDrawParticipation(pool, businessId, monthlyEquivalentFee);
        }
        console.log(`[Stripe] Renewal draw participation updated for business ${businessId}`);
      } catch (err: any) {
        console.error('[Stripe] ERROR in invoice.payment_succeeded:', err.message);
        throw err;
      }
      break;
    }

    case 'invoice.payment_failed': {
      try {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = (invoice as any).subscription as string | null;
        if (!subscriptionId) break;

        await pool.query(
          `UPDATE subscription SET status = 'Past_Due', updated_at = NOW() WHERE stripe_subscription_id = $1`,
          [subscriptionId],
        );
      } catch (err: any) {
        console.error('[Stripe] ERROR in invoice.payment_failed:', err.message);
        throw err;
      }
      break;
    }
  }
};

// ─── Founding Member: Activate ────────────────────────────────────────────────

async function activateFoundingMember(
  pool: Pool,
  businessId: number,
  paymentIntentId: string,
  checkoutSessionId: string,
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
      INSERT INTO founding_member (business_id, seat_number, stripe_payment_intent_id, stripe_checkout_session_id)
      SELECT $1, seat_number, $2, $3
      FROM available_seat
      RETURNING seat_number
    `, [businessId, paymentIntentId, checkoutSessionId]);

    if ((seatResult.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      console.error(`[Founding] No seats available for business ${businessId} — issuing auto-refund`);
      try {
        await stripe.refunds.create({ payment_intent: paymentIntentId });
      } catch (refundErr: any) {
        console.error(`[Founding] Auto-refund failed: ${refundErr.message}`);
      }
      throw new Error('All founding partner spots were claimed while your payment was processing. A full refund has been issued.');
    }

    seatNumber = seatResult.rows[0].seat_number as number;
    console.log(`[Founding] Business ${businessId} claimed seat #${seatNumber}`);

    // One-time payment: no stripe_subscription_id; period ends in 1 year; top entry tier
    const periodEnd = new Date();
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    const monthlyEquivalent = Math.round(120000 / 12) / 100; // $83.33

    await client.query(`
      INSERT INTO subscription
        (business_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
         status, current_period_end, cancel_at_period_end, fee_at_entry, entries_per_location, billing_interval)
      VALUES ($1, NULL, NULL, NULL, 'Active', $2, false, $3, 2500, 'yearly')
      ON CONFLICT (business_id) DO UPDATE
        SET status               = 'Active',
            stripe_subscription_id = NULL,
            current_period_end   = EXCLUDED.current_period_end,
            cancel_at_period_end = false,
            fee_at_entry         = EXCLUDED.fee_at_entry,
            entries_per_location = 1000,
            billing_interval     = 'yearly',
            updated_at           = NOW()
    `, [businessId, periodEnd, monthlyEquivalent]);


    await client.query('COMMIT');
    console.log(`[Founding] subscription row upserted for business ${businessId} (seat #${seatNumber})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Enroll in next upcoming draw (same as regular subscriber).
  // Future draws created by admin will auto-enroll all active subscribers including this one.
  try {
    const monthlyEquivalent = Math.round(120000 / 12) / 100;
    await handleDrawParticipation(pool, businessId, monthlyEquivalent);
  } catch (err: any) {
    console.error(`[Founding] Draw enrollment failed for business ${businessId} (non-fatal):`, err.message);
  }

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
  } catch (err: any) {
    console.error(`[Founding] Email lookup failed for business ${businessId} (non-fatal):`, err.message);
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

  // Remove from all upcoming draws
  const deleteResult = await pool.query(
    `DELETE FROM draw_entry de
     USING draw d
     WHERE de.draw_id = d.id AND de.business_id = $1 AND d.status = 'Upcoming'
     RETURNING de.draw_id`,
    [businessId],
  );
  const removedFromDraw = deleteResult.rowCount! > 0;

  // 50% refund of remaining time: $1,200 × (days_remaining / total_days) × 0.5
  let refundType: CancelRefundType = 'none';
  let refundAmount = 0;

  if (sub) {
    const now = new Date();
    const periodEnd = new Date(sub.current_period_end);
    const periodStart = new Date(sub.created_at);
    const totalMs = periodEnd.getTime() - periodStart.getTime();
    const remainingMs = Math.max(0, periodEnd.getTime() - now.getTime());
    const remainingFraction = totalMs > 0 ? remainingMs / totalMs : 0;
    const refundCents = Math.round(120000 * remainingFraction * 0.5);

    if (refundCents > 0) {
      refundAmount = refundCents / 100;
      refundType = remainingFraction >= 0.99 ? 'full' : 'prorated';

      try {
        await stripe.refunds.create({ payment_intent: paymentIntentId, amount: refundCents });
      } catch (err: any) {
        console.error(`[Founding] Stripe refund failed (non-fatal): ${err.message}`);
      }
    }
  }

  // Remove founding_member record entirely — they had their chance, no longer a founding member
  await pool.query(
    `DELETE FROM founding_member WHERE business_id = $1`,
    [businessId],
  );

  // Cancel subscription immediately (one-time payment, nothing to cancel on Stripe)
  await pool.query(
    `UPDATE subscription SET status = 'Cancelled', cancel_at_period_end = false, updated_at = NOW()
     WHERE business_id = $1`,
    [businessId],
  );

  console.log(`[Founding] Business ${businessId} cancelled. Removed from ${deleteResult.rowCount} upcoming draws. Refunded $${refundAmount} (50% of remaining time).`);
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
  monthlyEquivalentFee: number,
  entriesPerLocation: number,
  billingInterval: 'monthly' | 'yearly' = 'monthly',
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
    `, [businessId, customerId, subscriptionId, priceId, currentPeriodEnd, monthlyEquivalentFee, entriesPerLocation || null, billingInterval]);

    await client.query('COMMIT');
    console.log(`[Stripe] subscription row upserted for business ${businessId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Draw participation runs outside the transaction — it's non-fatal and has its own transaction.
  try {
    if (billingInterval === 'yearly') {
      await handleYearlyDrawParticipation(pool, businessId, monthlyEquivalentFee);
    } else {
      await handleDrawParticipation(pool, businessId, monthlyEquivalentFee);
    }
  } catch (err: any) {
    console.error(`[Stripe] Draw participation failed for business ${businessId} (non-fatal):`, err.message);
  }

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
  } catch (err: any) {
    console.error(`[Stripe] Confirmation email failed for business ${businessId} (non-fatal):`, err.message);
  }
}

// ─── Draw Participation ───────────────────────────────────────────────────────

async function handleDrawParticipation(
  pool: Pool,
  businessId: number,
  monthlyFee: number,
  targetDate?: Date,
  skipEnrollOthers = false,
): Promise<void> {
  // Default to next month. Normalise to 1st of month to avoid day-of-month overflow.
  const target = targetDate ?? addMonths(new Date(), 1);
  const targetMonth = target.getMonth() + 1; // 1-based
  const targetYear  = target.getFullYear();

  const client = await pool.connect();
  await client.query('BEGIN');

  try {
    // For monthly signups (no specific targetDate), join the next upcoming draw regardless of month.
    // For yearly pre-enrollment (specific targetDate), match the exact month so each future month
    // gets its own draw row.
    const drawResult = targetDate
      ? await client.query(`
          SELECT id FROM draw
          WHERE EXTRACT(MONTH FROM draw_date) = $1
            AND EXTRACT(YEAR FROM draw_date)  = $2
            AND status = 'Upcoming'
          LIMIT 1
        `, [targetMonth, targetYear])
      : await client.query(`
          SELECT id FROM draw
          WHERE status = 'Upcoming'
          ORDER BY draw_date ASC
          LIMIT 1
        `);

    const existingDraw = drawResult.rows[0] as { id: number } | undefined;

    if (existingDraw) {
      const insertResult = await client.query(`
        INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, contribution_amount)
        SELECT $1, $2, $3, 0
        WHERE NOT EXISTS (
          SELECT 1 FROM draw_entry WHERE draw_id = $1 AND business_id = $2
        )
      `, [existingDraw.id, businessId, monthlyFee]);

      if (insertResult.rowCount === 0) {
        console.log(`[Draw] Business ${businessId} already in draw ${existingDraw.id} — skipped`);
        await client.query('COMMIT');
        return;
      }

      console.log(`[Draw] Business ${businessId} entered draw ${existingDraw.id} (${targetYear}-${targetMonth}) — fee $${monthlyFee}`);
    } else {
      // Use MAKE_DATE with explicit year/month to avoid JS timezone-to-UTC conversion
      // shifting the date to the previous month on servers behind UTC.
      const newDrawResult = await client.query(`
        INSERT INTO draw (name, prize_pool, draw_date, status)
        VALUES (
          TRIM(TO_CHAR(MAKE_DATE($1, $2, 1), 'Month')) || ' ' || $1::text || ' Monthly Draw',
          0,
          (MAKE_DATE($1, $2, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date,
          'Upcoming'
        )
        RETURNING id
      `, [targetYear, targetMonth]);

      const newDraw = newDrawResult.rows[0] as { id: number };

      await client.query(
        `INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, contribution_amount) VALUES ($1, $2, $3, 0)`,
        [newDraw.id, businessId, monthlyFee],
      );

      // Only catch up other businesses when creating the immediate next-month draw.
      // For future months (yearly pre-enrollment) each business will enroll via their own renewal.
      if (!skipEnrollOthers) {
        await client.query(`
          INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, contribution_amount)
          SELECT $1, b.id, COALESCE(s.fee_at_entry, 0), 0
          FROM business b
          JOIN subscription s ON s.business_id = b.id
          WHERE s.status IN ('Active', 'Trialing') AND b.id != $2
          ON CONFLICT (draw_id, business_id) DO NOTHING
        `, [newDraw.id, businessId]);
      }

      console.log(`[Draw] Created new draw ${newDraw.id} for ${targetYear}-${targetMonth} with ${skipEnrollOthers ? 1 : 'all'} businesses — prize pool set by admin`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function handleYearlyDrawParticipation(pool: Pool, businessId: number, monthlyEquivalent: number): Promise<void> {
  for (let offset = 1; offset <= 12; offset++) {
    const target = addMonths(new Date(), offset);
    try {
      // Only enroll other businesses for the next-month draw (offset === 1).
      // Future months will be populated naturally as each business renews.
      await handleDrawParticipation(pool, businessId, monthlyEquivalent, target, offset > 1);
    } catch (err: any) {
      console.error(`[Draw] Yearly enrollment failed for business ${businessId} at month offset +${offset}:`, err.message);
    }
  }
}

// ─── Sync Subscription Quantity ───────────────────────────────────────────────
// Called after adding/removing a location to keep Stripe quantity in sync.
// Skips silently for founding members (no stripe_subscription_id).
export const syncSubscriptionQuantity = async (userId: number, newLocationCount: number): Promise<void> => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT
      s.stripe_subscription_id,
      s.billing_interval,
      s.entries_per_location,
      b.id AS business_id
    FROM business b
    JOIN subscription s ON s.business_id = b.id
    WHERE b.user_id = $1
  `, [userId]);

  const sub = result.rows[0];
  if (!sub) return; // no subscription yet — nothing to sync
  if (!sub.stripe_subscription_id) return; // founding member, no Stripe sub — skip

  const interval = sub.billing_interval as 'monthly' | 'yearly';
  const tierConfig = TIER_PRICE_MAP[sub.entries_per_location as number];
  if (!tierConfig) throw new Error('Unknown tier');

  const envKey = tierConfig[interval].envKey;
  const priceId = process.env[envKey];
  if (!priceId) throw new Error(`Stripe price ID not configured for tier ${sub.entries_per_location} (${interval})`);

  const quantity = Math.max(1, newLocationCount);
  const newFeePerLocation = tierConfig[interval].pricePerLocation;

  const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['items'] });
  const itemId = stripeSub.items.data[0]?.id;
  if (!itemId) throw new Error('Stripe subscription item not found');

  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    items: [{ id: itemId, price: priceId, quantity }],
    proration_behavior: 'create_prorations',
  });

  await pool.query(
    `UPDATE subscription SET fee_at_entry = $1, updated_at = NOW() WHERE business_id = $2`,
    [newFeePerLocation, sub.business_id],
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
      s.billing_interval,
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

  const interval = sub.billing_interval as 'monthly' | 'yearly';
  const envKey = tierConfig[interval].envKey;
  const priceId = process.env[envKey];
  if (!priceId) throw new Error(`Stripe price ID not configured for tier ${newEntriesPerLocation} (${interval})`);

  const locationCount = Math.max(1, Number(sub.location_count));
  const newFeePerLocation = tierConfig[interval].pricePerLocation;

  // Fetch current Stripe subscription to get the item ID
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['items'] });
  const itemId = stripeSub.items.data[0]?.id;
  if (!itemId) throw new Error('Stripe subscription item not found');

  // Update Stripe subscription — Stripe handles proration automatically
  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    items: [{ id: itemId, price: priceId, quantity: locationCount }],
    proration_behavior: 'create_prorations',
  });

  // Update DB
  await pool.query(
    `UPDATE subscription
     SET entries_per_location = $1, fee_at_entry = $2, updated_at = NOW()
     WHERE business_id = $3`,
    [newEntriesPerLocation, newFeePerLocation, sub.business_id],
  );
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
      ) AS founding_draws_remaining
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
    WHERE b.user_id = $1
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

  const stripeSubscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['items'] });
  const billingInterval: 'monthly' | 'yearly' =
    stripeSubscription.items.data[0]?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly';
  const resumeItem = stripeSubscription.items.data[0];
  const rawFee = Math.round((resumeItem?.price.unit_amount ?? 0) * (resumeItem?.quantity ?? 1)) / 100;
  const monthlyEquivalentFee = billingInterval === 'yearly' ? rawFee / 12 : rawFee;

  try {
    if (billingInterval === 'yearly') {
      await handleYearlyDrawParticipation(pool, sub.business_id, monthlyEquivalentFee);
    } else {
      await handleDrawParticipation(pool, sub.business_id, monthlyEquivalentFee);
    }
  } catch (err: any) {
    console.error(`[Stripe] Draw re-participation failed for business ${sub.business_id} (non-fatal):`, err.message);
  }
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

  // Set cancel at period end on Stripe — business keeps access until period ends
  await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
  await pool.query(
    `UPDATE subscription SET cancel_at_period_end = true, updated_at = NOW() WHERE id = $1`,
    [sub.id],
  );

  // Remove from next upcoming draw — no refund
  const deleteResult = await pool.query(
    `DELETE FROM draw_entry de
     USING draw d
     WHERE de.draw_id = d.id AND de.business_id = $1 AND d.status = 'Upcoming'
     RETURNING de.draw_id`,
    [sub.business_id],
  );
  const removedFromDraw = deleteResult.rowCount! > 0;

  console.log(`[Cancel] Business ${sub.business_id} set to cancel at period end. Removed from ${deleteResult.rowCount} upcoming draw(s). No refund issued.`);
  return { removedFromDraw, refundType: 'none', refundAmount: 0 };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
