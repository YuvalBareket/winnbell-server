import Stripe from 'stripe';
import { Pool } from 'pg';
import { getPool } from '../../shared/db/db.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

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
export const TIER_PRICE_MAP: Record<number, { envKey: string; pricePerLocation: number }> = {
  250:  { envKey: 'STRIPE_PRICE_ID_250',  pricePerLocation: 250  },
  500:  { envKey: 'STRIPE_PRICE_ID_500',  pricePerLocation: 490  },
  750:  { envKey: 'STRIPE_PRICE_ID_750',  pricePerLocation: 720  },
  1000: { envKey: 'STRIPE_PRICE_ID_1000', pricePerLocation: 940  },
  1250: { envKey: 'STRIPE_PRICE_ID_1250', pricePerLocation: 1150 },
  1500: { envKey: 'STRIPE_PRICE_ID_1500', pricePerLocation: 1350 },
  1750: { envKey: 'STRIPE_PRICE_ID_1750', pricePerLocation: 1540 },
  2000: { envKey: 'STRIPE_PRICE_ID_2000', pricePerLocation: 1720 },
  2250: { envKey: 'STRIPE_PRICE_ID_2250', pricePerLocation: 1890 },
  2500: { envKey: 'STRIPE_PRICE_ID_2500', pricePerLocation: 2000 },
};

// ─── Create Checkout Session ──────────────────────────────────────────────────

export const createCheckoutSession = async (
  businessId: number,
  userEmail: string,
  entriesPerLocation: number,
): Promise<string> => {
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

  // Get active location count (minimum 1). Quantity = locationCount — price per location already includes tier discount.
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
    metadata: { business_id: String(businessId), entries_per_location: String(entriesPerLocation) },
    subscription_data: { metadata: { business_id: String(businessId), entries_per_location: String(entriesPerLocation) } },
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
  const customerId = session.customer as string;
  const priceItem = subscription.items.data[0];
  const priceId = priceItem?.price.id ?? '';
  const quantity = priceItem?.quantity ?? 1;
  const monthlyFee = Math.round((priceItem?.price.unit_amount ?? 0) * quantity) / 100;
  const currentPeriodEnd = extractPeriodEnd(subscription);
  const entriesPerLocation = Number(session.metadata?.entries_per_location ?? 0);

  await activateBusinessSubscription(pool, businessId, subscription.id, customerId, priceId, currentPeriodEnd, monthlyFee, entriesPerLocation);
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
        const monthlyFee = Math.round((priceItem?.price.unit_amount ?? 0) * quantity) / 100;
        const currentPeriodEnd = extractPeriodEnd(subscription);
        const entriesPerLocation = Number(session.metadata?.entries_per_location ?? 0);

        await activateBusinessSubscription(pool, businessId, subscriptionId, customerId, priceId, currentPeriodEnd, monthlyFee, entriesPerLocation);
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
          const monthlyFee = Math.round((priceItem?.price.unit_amount ?? 0) * quantity) / 100;
          await handleDrawParticipation(pool, businessId, monthlyFee);
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
        const monthlyFee = Math.round((priceItem?.price.unit_amount ?? 0) * quantity) / 100;

        await handleDrawParticipation(pool, businessId, monthlyFee);
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
  monthlyFee: number,
  entriesPerLocation: number,
): Promise<void> {
  console.log(`[Stripe] Activating business ${businessId} — entries/location: ${entriesPerLocation}...`);

  // Set entry_cap per location on business
  const updateResult = await pool.query(
    `UPDATE business SET is_subscribed = true, entry_cap = $2 WHERE id = $1`,
    [businessId, entriesPerLocation || null],
  );
  console.log(`[Stripe] business.is_subscribed updated, rows affected: ${updateResult.rowCount}`);

  // Upsert subscription using ON CONFLICT
  await pool.query(`
    INSERT INTO subscription
      (business_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, status, current_period_end, cancel_at_period_end, fee_at_entry, entries_per_location)
    VALUES ($1, $2, $3, $4, 'Active', $5, false, $6, $7)
    ON CONFLICT (business_id) DO UPDATE
      SET stripe_customer_id     = EXCLUDED.stripe_customer_id,
          stripe_subscription_id = EXCLUDED.stripe_subscription_id,
          stripe_price_id        = EXCLUDED.stripe_price_id,
          status                 = 'Active',
          current_period_end     = EXCLUDED.current_period_end,
          cancel_at_period_end   = false,
          fee_at_entry           = EXCLUDED.fee_at_entry,
          entries_per_location   = EXCLUDED.entries_per_location,
          updated_at             = NOW()
  `, [businessId, customerId, subscriptionId, priceId, currentPeriodEnd, monthlyFee, entriesPerLocation || null]);
  console.log(`[Stripe] subscription row upserted for business ${businessId}`);

  try {
    await handleDrawParticipation(pool, businessId, monthlyFee);
  } catch (err: any) {
    console.error(`[Stripe] Draw participation failed for business ${businessId} (non-fatal):`, err.message);
  }
}

// ─── Draw Participation ───────────────────────────────────────────────────────

async function handleDrawParticipation(pool: Pool, businessId: number, monthlyFee: number): Promise<void> {
  const client = await pool.connect();
  await client.query('BEGIN');

  try {
    const drawResult = await client.query(`
      SELECT id, prize_percentage FROM draw
      WHERE EXTRACT(MONTH FROM draw_date) = EXTRACT(MONTH FROM NOW() + INTERVAL '1 month')
        AND EXTRACT(YEAR FROM draw_date)  = EXTRACT(YEAR FROM NOW() + INTERVAL '1 month')
        AND status = 'Upcoming'
      LIMIT 1
    `);

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

      console.log(`[Draw] Business ${businessId} entered draw ${existingDraw.id} — fee $${monthlyFee}, contribution $${contribution} (${existingDraw.prize_percentage}%)`);
    } else {
      const DEFAULT_PRIZE_PCT = 80.00;

      // Create draw with prize_pool = 0 first, then sum all contributions
      const newDrawResult = await client.query(`
        INSERT INTO draw (name, prize_pool, prize_percentage, draw_date, status)
        VALUES (
          TRIM(TO_CHAR(NOW() + INTERVAL '1 month', 'Month')) || ' ' || TO_CHAR(NOW() + INTERVAL '1 month', 'YYYY') || ' Monthly Draw',
          0,
          $1,
          DATE_TRUNC('month', NOW() + INTERVAL '1 month') + INTERVAL '1 month' - INTERVAL '1 day',
          'Upcoming'
        )
        RETURNING id, prize_percentage
      `, [DEFAULT_PRIZE_PCT]);

      const newDraw = newDrawResult.rows[0] as { id: number; prize_percentage: number };

      // Enroll the triggering business
      const triggerContribution = parseFloat((monthlyFee * DEFAULT_PRIZE_PCT / 100).toFixed(2));
      await client.query(
        `INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, contribution_amount) VALUES ($1, $2, $3, $4)`,
        [newDraw.id, businessId, monthlyFee, triggerContribution],
      );
      let totalPrizePool = triggerContribution;

      // Enroll all other currently subscribed businesses
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

      await client.query(`UPDATE draw SET prize_pool = $1 WHERE id = $2`, [totalPrizePool, newDraw.id]);

      console.log(`[Draw] Created new draw ${newDraw.id} with ${1 + otherSubsResult.rows.length} businesses — total pool $${totalPrizePool}`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Get Subscription Details ─────────────────────────────────────────────────

export const getSubscriptionDetails = async (userId: number) => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT
      s.id, s.status, s.current_period_end, s.cancel_at_period_end,
      s.stripe_subscription_id, s.stripe_price_id,
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
  const resumeItem = stripeSubscription.items.data[0];
  const monthlyFee = Math.round((resumeItem?.price.unit_amount ?? 0) * (resumeItem?.quantity ?? 1)) / 100;

  try {
    await handleDrawParticipation(pool, sub.business_id, monthlyFee);
  } catch (err: any) {
    console.error(`[Stripe] Draw re-participation failed for business ${sub.business_id} (non-fatal):`, err.message);
  }
};

// ─── Cancel Subscription ──────────────────────────────────────────────────────

export const cancelSubscription = async (userId: number): Promise<{ removedFromDraw: boolean }> => {
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

  console.log(`[Cancel] business_id=${sub.business_id} draw rows found: ${drawResult.rows.length}`);
  drawResult.rows.forEach(r => console.log(`[Cancel] draw: id=${r.id} status=${r.status} date=${r.draw_date} contribution=${r.contribution_amount} pool=${r.prize_pool}`));

  const nextDraw = drawResult.rows[0];
  let removedFromDraw = false;

  if (nextDraw) {
    const drawDate = new Date(nextDraw.draw_date);
    const lockDate = new Date(drawDate.getFullYear(), drawDate.getMonth(), 1);
    const isLocked = new Date() >= lockDate;
    console.log(`[Cancel] draw ${nextDraw.id} lockDate=${lockDate.toISOString()} isLocked=${isLocked} contribution=${nextDraw.contribution_amount}`);

    if (!isLocked) {
      const client = await pool.connect();
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE draw SET prize_pool = GREATEST(0, prize_pool - $1) WHERE id = $2`,
          [nextDraw.contribution_amount, nextDraw.id],
        );
        await client.query(
          `DELETE FROM draw_entry WHERE draw_id = $1 AND business_id = $2`,
          [nextDraw.id, sub.business_id],
        );
        await client.query('COMMIT');
        removedFromDraw = true;
        console.log(`[Cancel] Removed business ${sub.business_id} from draw ${nextDraw.id}, prize_pool reduced by $${nextDraw.contribution_amount}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      console.log(`[Cancel] Draw ${nextDraw.id} is locked — business stays in draw`);
    }
  }

  return { removedFromDraw };
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
