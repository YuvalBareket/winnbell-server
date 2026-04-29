import Stripe from 'stripe';
import { Pool } from 'pg';
import { getPool } from '../../shared/db/db.js';

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

// ─── Create Checkout Session ──────────────────────────────────────────────────

export const createCheckoutSession = async (
  businessId: number,
  userEmail: string,
  entriesPerLocation: number,
  billingInterval: 'monthly' | 'yearly' = 'monthly',
): Promise<string> => {
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

  return session.url as string;
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

        await pool.query(`UPDATE business SET is_subscribed = $1 WHERE id = $2`, [isActive, businessId]);

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
        await pool.query(`UPDATE business SET is_subscribed = false, is_participating = false WHERE id = $1`, [businessId]);
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

    const updateResult = await client.query(
      `UPDATE business SET is_subscribed = true, entry_cap = $2 WHERE id = $1`,
      [businessId, entriesPerLocation || null],
    );
    console.log(`[Stripe] business.is_subscribed updated, rows affected: ${updateResult.rowCount}`);

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
  // ISO string for first-of-month — used as a TIMESTAMP parameter in draw creation SQL
  const targetIso = new Date(targetYear, targetMonth - 1, 1).toISOString();

  const client = await pool.connect();
  await client.query('BEGIN');

  try {
    const drawResult = await client.query(`
      SELECT id, prize_percentage FROM draw
      WHERE EXTRACT(MONTH FROM draw_date) = $1
        AND EXTRACT(YEAR FROM draw_date)  = $2
        AND status = 'Upcoming'
      LIMIT 1
    `, [targetMonth, targetYear]);

    const existingDraw = drawResult.rows[0] as { id: number; prize_percentage: number } | undefined;

    if (existingDraw) {
      const contribution = parseFloat((monthlyFee * existingDraw.prize_percentage / 100).toFixed(2));

      const insertResult = await client.query(`
        INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, contribution_amount)
        SELECT $1, $2, $3, $4
        WHERE NOT EXISTS (
          SELECT 1 FROM draw_entry WHERE draw_id = $1 AND business_id = $2
        )
      `, [existingDraw.id, businessId, monthlyFee, contribution]);

      if (insertResult.rowCount === 0) {
        console.log(`[Draw] Business ${businessId} already in draw ${existingDraw.id} — skipped`);
        await client.query('COMMIT');
        return;
      }

      await client.query(
        `UPDATE draw SET prize_pool = prize_pool + $1 WHERE id = $2`,
        [contribution, existingDraw.id],
      );
      console.log(`[Draw] Business ${businessId} entered draw ${existingDraw.id} (${targetYear}-${targetMonth}) — fee $${monthlyFee}, contribution $${contribution}`);
    } else {
      const DEFAULT_PRIZE_PCT = 80.00;

      const newDrawResult = await client.query(`
        INSERT INTO draw (name, prize_pool, prize_percentage, draw_date, status)
        VALUES (
          TRIM(TO_CHAR($1::TIMESTAMP, 'Month')) || ' ' || TO_CHAR($1::TIMESTAMP, 'YYYY') || ' Monthly Draw',
          0,
          $2,
          DATE_TRUNC('month', $1::TIMESTAMP) + INTERVAL '1 month' - INTERVAL '1 day',
          'Upcoming'
        )
        RETURNING id, prize_percentage
      `, [targetIso, DEFAULT_PRIZE_PCT]);

      const newDraw = newDrawResult.rows[0] as { id: number; prize_percentage: number };
      const triggerContribution = parseFloat((monthlyFee * DEFAULT_PRIZE_PCT / 100).toFixed(2));

      await client.query(
        `INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, contribution_amount) VALUES ($1, $2, $3, $4)`,
        [newDraw.id, businessId, monthlyFee, triggerContribution],
      );
      let totalPrizePool = triggerContribution;

      // Only catch up other businesses when creating the immediate next-month draw.
      // For future months (yearly pre-enrollment) each business will enroll via their own renewal.
      if (!skipEnrollOthers) {
        const otherSubsResult = await client.query(`
          SELECT b.id AS business_id, COALESCE(s.fee_at_entry, 0) AS monthly_fee
          FROM business b
          JOIN subscription s ON s.business_id = b.id
          WHERE b.is_subscribed = true AND s.status = 'Active' AND b.id != $1
        `, [businessId]);

        for (const sub of otherSubsResult.rows) {
          const contribution = parseFloat((sub.monthly_fee * DEFAULT_PRIZE_PCT / 100).toFixed(2));
          await client.query(
            `INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, contribution_amount) VALUES ($1, $2, $3, $4)
             ON CONFLICT (draw_id, business_id) DO NOTHING`,
            [newDraw.id, sub.business_id, sub.monthly_fee, contribution],
          );
          totalPrizePool += contribution;
        }
      }

      await client.query(`UPDATE draw SET prize_pool = $1 WHERE id = $2`, [totalPrizePool, newDraw.id]);
      console.log(`[Draw] Created new draw ${newDraw.id} for ${targetYear}-${targetMonth} with ${skipEnrollOthers ? 1 : 'all'} businesses — pool $${totalPrizePool}`);
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

// ─── Get Subscription Details ─────────────────────────────────────────────────

export const getSubscriptionDetails = async (userId: number) => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT
      s.id, s.status, s.current_period_end, s.cancel_at_period_end,
      s.stripe_subscription_id, s.stripe_price_id, s.billing_interval,
      d.id        AS draw_id,
      d.name      AS draw_name,
      d.draw_date AS draw_date,
      d.status    AS draw_status,
      d.prize_pool AS prize_amount
    FROM business b
    JOIN subscription s ON s.business_id = b.id
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

export type CancelRefundType = 'full' | 'partial_40' | 'none';

export interface CancelResult {
  removedFromDraw: boolean;
  refundType: CancelRefundType;
  refundAmount: number; // actual dollars refunded (0 if none)
}

export const cancelSubscription = async (userId: number): Promise<CancelResult> => {
  const pool = getPool();

  const subResult = await pool.query(`
    SELECT s.id, s.stripe_subscription_id, b.id AS business_id
    FROM subscription s
    JOIN business b ON b.id = s.business_id
    WHERE b.user_id = $1 AND s.status != 'Cancelled'
  `, [userId]);

  const sub = subResult.rows[0];
  if (!sub) throw new Error('No active subscription found');

  await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
  await pool.query(
    `UPDATE subscription SET cancel_at_period_end = true, updated_at = NOW() WHERE id = $1`,
    [sub.id],
  );

  const drawResult = await pool.query(`
    SELECT d.id, d.status, d.prize_pool, de.contribution_amount, d.draw_date
    FROM draw_entry de
    JOIN draw d ON d.id = de.draw_id
    WHERE de.business_id = $1 AND d.status = 'Upcoming'
  `, [sub.business_id]);

  const nextDraw = drawResult.rows[0];
  let removedFromDraw = false;
  let refundType: CancelRefundType = 'none';
  let refundAmount = 0;

  if (nextDraw) {
    const now = new Date();
    const drawDate = new Date(nextDraw.draw_date);
    const cutoffDate = new Date(drawDate);
    cutoffDate.setDate(cutoffDate.getDate() - ONBOARDING_CUTOFF_DAYS);

    const contribution = parseFloat(nextDraw.contribution_amount);

    if (now < cutoffDate) {
      // ── Before cutoff: full draw removal + full refund ──────────────────────
      refundType = 'full';
      const poolClient = await pool.connect();
      await poolClient.query('BEGIN');
      try {
        await poolClient.query(
          `UPDATE draw SET prize_pool = GREATEST(0, prize_pool - $1) WHERE id = $2`,
          [contribution, nextDraw.id],
        );
        await poolClient.query(
          `DELETE FROM draw_entry WHERE draw_id = $1 AND business_id = $2`,
          [nextDraw.id, sub.business_id],
        );
        await poolClient.query('COMMIT');
        removedFromDraw = true;
      } catch (err) {
        await poolClient.query('ROLLBACK');
        throw err;
      } finally {
        poolClient.release();
      }

      // Issue full Stripe refund for current billing period
      try {
        const invoices = await stripe.invoices.list({ subscription: sub.stripe_subscription_id, limit: 1 });
        const latestInvoice = invoices.data[0];
        const paymentIntentId = (latestInvoice as any)?.payment_intent as string | null;
        if (paymentIntentId && latestInvoice.amount_paid > 0) {
          await stripe.refunds.create({ payment_intent: paymentIntentId });
          refundAmount = latestInvoice.amount_paid / 100;
        }
      } catch (err: any) {
        console.error(`[Cancel] Stripe full refund failed (non-fatal): ${err.message}`);
      }

      console.log(`[Cancel] Before cutoff — full removal + full refund $${refundAmount} for business ${sub.business_id}`);

    } else if (now < drawDate) {
      // ── After cutoff, before draw: remove from draw, 40% refund ─────────────
      refundType = 'partial_40';
      const poolRetained = parseFloat((contribution * 0.6).toFixed(2));
      const poolClient = await pool.connect();
      await poolClient.query('BEGIN');
      try {
        // Keep 60% of contribution in prize pool, remove 40%
        await poolClient.query(
          `UPDATE draw SET prize_pool = GREATEST(0, prize_pool - $1) WHERE id = $2`,
          [parseFloat((contribution * 0.4).toFixed(2)), nextDraw.id],
        );
        await poolClient.query(
          `DELETE FROM draw_entry WHERE draw_id = $1 AND business_id = $2`,
          [nextDraw.id, sub.business_id],
        );
        await poolClient.query('COMMIT');
        removedFromDraw = true;
      } catch (err) {
        await poolClient.query('ROLLBACK');
        throw err;
      } finally {
        poolClient.release();
      }

      // Issue 40% Stripe refund
      try {
        const invoices = await stripe.invoices.list({ subscription: sub.stripe_subscription_id, limit: 1 });
        const latestInvoice = invoices.data[0];
        const paymentIntentId = (latestInvoice as any)?.payment_intent as string | null;
        if (paymentIntentId && latestInvoice.amount_paid > 0) {
          const refundCents = Math.round(latestInvoice.amount_paid * 0.4);
          await stripe.refunds.create({ payment_intent: paymentIntentId, amount: refundCents });
          refundAmount = refundCents / 100;
        }
      } catch (err: any) {
        console.error(`[Cancel] Stripe 40% refund failed (non-fatal): ${err.message}`);
      }

      console.log(`[Cancel] After cutoff — partial removal, 40% refund $${refundAmount} for business ${sub.business_id}`);

    } else {
      // ── After draw commenced: no removal, no refund ──────────────────────────
      refundType = 'none';
      console.log(`[Cancel] Draw already commenced — no removal, no refund for business ${sub.business_id}`);
    }
  }

  return { removedFromDraw, refundType, refundAmount };
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
