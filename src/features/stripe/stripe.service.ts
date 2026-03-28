import Stripe from 'stripe';
import { getPool, sql } from '../../shared/db/db.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);

// ─── Create Checkout Session ──────────────────────────────────────────────────

export const createCheckoutSession = async (
  businessId: number,
  userEmail: string,
): Promise<string> => {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) throw new Error('STRIPE_PRICE_ID is not configured');

  // Block if business already has a non-cancelled subscription
  const pool = getPool();
  const existing = await pool.request()
    .input('businessId', sql.Int, businessId)
    .query(`SELECT id FROM subscription WHERE business_id = @businessId AND status != 'Cancelled'`);

  if (existing.recordset.length > 0) {
    throw new Error('This business already has an active subscription');
  }

  const baseUrl = process.env.CLIENT_URL || 'http://localhost:8081';

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: userEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { business_id: String(businessId) },
    subscription_data: { metadata: { business_id: String(businessId) } },
    success_url: `${baseUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/subscribe`,
  });

  return session.url as string;
};

// ─── Verify Session (called from success page as reliable fallback) ───────────

export const verifyAndActivateSession = async (sessionId: string, userId: number): Promise<void> => {
  const pool = getPool();

  // Get the business for this user
  const bizResult = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`SELECT id FROM business WHERE user_id = @userId`);

  const businessId = bizResult.recordset[0]?.id;
  if (!businessId) throw new Error('Business not found');

  // Retrieve and validate the session from Stripe
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription', 'subscription.items'],
  });

  if (session.payment_status !== 'paid') {
    throw new Error('Payment not completed');
  }

  // Guard: make sure this session belongs to this business
  if (session.metadata?.business_id !== String(businessId)) {
    throw new Error('Session does not belong to this business');
  }

  const subscription = session.subscription as Stripe.Subscription;
  const customerId = session.customer as string;
  const priceItem = subscription.items.data[0];
  const priceId = priceItem?.price.id ?? '';
  const monthlyFee = (priceItem?.price.unit_amount ?? 0) / 100;
  const currentPeriodEnd = extractPeriodEnd(subscription);

  await activateBusinessSubscription(pool, businessId, subscription.id, customerId, priceId, currentPeriodEnd, monthlyFee);
};

// ─── Handle Webhook ───────────────────────────────────────────────────────────

export const handleStripeWebhook = async (
  rawBody: Buffer,
  signature: string,
): Promise<void> => {
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
        if (!businessId) {
          console.error('[Stripe] checkout.session.completed: missing business_id in metadata', session.id);
          break;
        }

        const subscriptionId = session.subscription as string;
        if (!subscriptionId) {
          console.error('[Stripe] checkout.session.completed: session has no subscription', session.id);
          break;
        }

        const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ['items'],
        });
        const customerId = session.customer as string;
        const priceItem = subscription.items.data[0];
        const priceId = priceItem?.price.id ?? '';
        const monthlyFee = (priceItem?.price.unit_amount ?? 0) / 100;
        const currentPeriodEnd = extractPeriodEnd(subscription);

        await activateBusinessSubscription(pool, businessId, subscriptionId, customerId, priceId, currentPeriodEnd, monthlyFee);
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
        const cancelAtPeriodEnd = subscription.cancel_at_period_end ? 1 : 0;
        const isActive = status === 'Active' || status === 'Trialing' ? 1 : 0;
        const previousStatus = (event.data as any).previous_attributes?.status;

        await pool.request()
          .input('businessId', sql.Int, businessId)
          .input('status', sql.NVarChar, status)
          .input('periodEnd', sql.DateTime2, currentPeriodEnd)
          .input('cancelAtPeriodEnd', sql.Bit, cancelAtPeriodEnd)
          .input('isActive', sql.Bit, isActive)
          .query(`
            UPDATE subscription
            SET status = @status, current_period_end = @periodEnd,
                cancel_at_period_end = @cancelAtPeriodEnd, updated_at = GETDATE()
            WHERE business_id = @businessId;
            UPDATE business SET is_active = @isActive WHERE id = @businessId;
          `);

        if (isActive === 1 && previousStatus && previousStatus !== 'active') {
          const priceItem = subscription.items.data[0];
          const monthlyFee = (priceItem?.price.unit_amount ?? 0) / 100;
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

        await pool.request()
          .input('businessId', sql.Int, businessId)
          .query(`
            UPDATE subscription SET status = 'Cancelled', updated_at = GETDATE() WHERE business_id = @businessId;
            UPDATE business SET is_active = 0 WHERE id = @businessId;
          `);
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

        // Only process recurring renewals (billing_reason = 'subscription_cycle')
        // The first payment ('subscription_create') is already handled by checkout.session.completed
        // but the duplicate-participant guard makes it safe to process both
        const billingReason = (invoice as any).billing_reason as string | null;
        if (billingReason !== 'subscription_cycle') break;

        const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items'] });
        const businessId = Number(subscription.metadata?.business_id);
        if (!businessId) break;

        const priceItem = subscription.items.data[0];
        const monthlyFee = (priceItem?.price.unit_amount ?? 0) / 100;

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

        await pool.request()
          .input('subscriptionId', sql.NVarChar, subscriptionId)
          .query(`UPDATE subscription SET status = 'Past_Due', updated_at = GETDATE() WHERE stripe_subscription_id = @subscriptionId;`);
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
  pool: ReturnType<typeof getPool>,
  businessId: number,
  subscriptionId: string,
  customerId: string,
  priceId: string,
  currentPeriodEnd: Date,
  monthlyFee: number,
): Promise<void> {
  console.log(`[Stripe] Activating business ${businessId}...`);

  // Step 1: Activate business
  const updateResult = await pool.request()
    .input('businessId', sql.Int, businessId)
    .query(`UPDATE business SET is_active = 1 WHERE id = @businessId`);
  console.log(`[Stripe] business.is_active updated, rows affected: ${updateResult.rowsAffected[0]}`);

  // Step 2: Upsert subscription row using IF EXISTS (more reliable than MERGE)
  const existing = await pool.request()
    .input('businessId', sql.Int, businessId)
    .query(`SELECT id FROM subscription WHERE business_id = @businessId`);

  if (existing.recordset.length > 0) {
    await pool.request()
      .input('businessId', sql.Int, businessId)
      .input('customerId', sql.NVarChar, customerId)
      .input('subscriptionId', sql.NVarChar, subscriptionId)
      .input('priceId', sql.NVarChar, priceId)
      .input('periodEnd', sql.DateTime2, currentPeriodEnd)
      .query(`
        UPDATE subscription
        SET stripe_customer_id     = @customerId,
            stripe_subscription_id = @subscriptionId,
            stripe_price_id        = @priceId,
            status                 = 'Active',
            current_period_end     = @periodEnd,
            cancel_at_period_end   = 0,
            updated_at             = GETDATE()
        WHERE business_id = @businessId
      `);
    console.log(`[Stripe] subscription row updated for business ${businessId}`);
  } else {
    await pool.request()
      .input('businessId', sql.Int, businessId)
      .input('customerId', sql.NVarChar, customerId)
      .input('subscriptionId', sql.NVarChar, subscriptionId)
      .input('priceId', sql.NVarChar, priceId)
      .input('periodEnd', sql.DateTime2, currentPeriodEnd)
      .query(`
        INSERT INTO subscription (business_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, status, current_period_end, cancel_at_period_end)
        VALUES (@businessId, @customerId, @subscriptionId, @priceId, 'Active', @periodEnd, 0)
      `);
    console.log(`[Stripe] subscription row inserted for business ${businessId}`);
  }

  // Step 3: Draw participation (isolated — never blocks activation)
  try {
    await handleDrawParticipation(pool, businessId, monthlyFee);
  } catch (err: any) {
    console.error(`[Stripe] Draw participation failed for business ${businessId} (non-fatal):`, err.message);
  }
}

// ─── Draw Participation ───────────────────────────────────────────────────────

async function handleDrawParticipation(
  pool: ReturnType<typeof getPool>,
  businessId: number,
  monthlyFee: number,
): Promise<void> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    // Find the upcoming draw for next calendar month (status must be 'Upcoming' — never touch the current open draw)
    const drawResult = await transaction.request().query(`
      SELECT TOP 1 id, prize_percentage FROM draw
      WHERE MONTH(draw_date) = MONTH(DATEADD(month, 1, GETDATE()))
        AND YEAR(draw_date)  = YEAR(DATEADD(month, 1, GETDATE()))
        AND status = 'Upcoming'
    `);

    const existingDraw = drawResult.recordset[0] as { id: number; prize_percentage: number } | undefined;

    if (existingDraw) {
      const contribution = parseFloat((monthlyFee * existingDraw.prize_percentage / 100).toFixed(2));

      // INSERT ... WHERE NOT EXISTS is atomic — handles concurrent duplicate calls without throwing
      const insertResult = await transaction.request()
        .input('drawId', sql.Int, existingDraw.id)
        .input('businessId', sql.Int, businessId)
        .input('fee', sql.Decimal(10, 2), monthlyFee)
        .input('contribution', sql.Decimal(10, 2), contribution)
        .query(`
          INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, contribution_amount)
          SELECT @drawId, @businessId, @fee, @contribution
          WHERE NOT EXISTS (
            SELECT 1 FROM draw_entry WHERE draw_id = @drawId AND business_id = @businessId
          )
        `);

      if (insertResult.rowsAffected[0] === 0) {
        console.log(`[Draw] Business ${businessId} already in draw ${existingDraw.id} — skipped`);
        await transaction.commit();
        return;
      }

      await transaction.request()
        .input('drawId', sql.Int, existingDraw.id)
        .input('contribution', sql.Decimal(10, 2), contribution)
        .query(`UPDATE draw SET prize_pool = prize_pool + @contribution WHERE id = @drawId`);

      console.log(`[Draw] Business ${businessId} entered draw ${existingDraw.id} — fee $${monthlyFee}, contribution $${contribution} (${existingDraw.prize_percentage}%)`);
    } else {
      // No draw for next month — create one with default 80% prize percentage
      const DEFAULT_PRIZE_PCT = 80.00;
      const contribution = parseFloat((monthlyFee * DEFAULT_PRIZE_PCT / 100).toFixed(2));

      const newDrawResult = await transaction.request()
        .input('contribution', sql.Decimal(10, 2), contribution)
        .query(`
          INSERT INTO draw (name, prize_pool, prize_percentage, draw_date, status)
          OUTPUT INSERTED.id, INSERTED.prize_percentage
          VALUES (
            FORMAT(DATEADD(month, 1, GETDATE()), 'MMMM yyyy') + ' Monthly Draw',
            @contribution,
            ${DEFAULT_PRIZE_PCT},
            EOMONTH(DATEADD(month, 1, GETDATE())),
            'Upcoming'
          )
        `);

      const newDraw = newDrawResult.recordset[0] as { id: number; prize_percentage: number };

      await transaction.request()
        .input('drawId', sql.Int, newDraw.id)
        .input('businessId', sql.Int, businessId)
        .input('fee', sql.Decimal(10, 2), monthlyFee)
        .input('contribution', sql.Decimal(10, 2), contribution)
        .query(`INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, contribution_amount) VALUES (@drawId, @businessId, @fee, @contribution)`);

      console.log(`[Draw] Created new draw ${newDraw.id} for business ${businessId} — fee $${monthlyFee}, contribution $${contribution}`);
    }

    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// ─── Get Subscription Details ─────────────────────────────────────────────────

export const getSubscriptionDetails = async (userId: number) => {
  const pool = getPool();

  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT
        s.id, s.status, s.current_period_end, s.cancel_at_period_end,
        s.stripe_subscription_id, s.stripe_price_id,
        -- Next month's draw this business is participating in
        d.id        AS draw_id,
        d.name      AS draw_name,
        d.draw_date AS draw_date,
        d.status    AS draw_status,
        d.prize_pool AS prize_amount
      FROM business b
      JOIN subscription s ON s.business_id = b.id
      LEFT JOIN draw_entry de ON de.business_id = b.id
      LEFT JOIN draw d ON d.id = de.draw_id
        AND MONTH(d.draw_date) = MONTH(DATEADD(month, 1, GETDATE()))
        AND YEAR(d.draw_date)  = YEAR(DATEADD(month, 1, GETDATE()))
        AND d.status = 'Upcoming'
      WHERE b.user_id = @userId
    `);

  return result.recordset[0] ?? null;
};

// ─── Resume Subscription ──────────────────────────────────────────────────────

export const resumeSubscription = async (userId: number): Promise<void> => {
  const pool = getPool();

  const subResult = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT s.id, s.stripe_subscription_id, b.id AS business_id
      FROM subscription s
      JOIN business b ON b.id = s.business_id
      WHERE b.user_id = @userId AND s.cancel_at_period_end = 1 AND s.status != 'Cancelled'
    `);

  const sub = subResult.recordset[0];
  if (!sub) throw new Error('No pending cancellation found to resume');

  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    cancel_at_period_end: false,
  });

  await pool.request()
    .input('subId', sql.Int, sub.id)
    .query(`UPDATE subscription SET cancel_at_period_end = 0, updated_at = GETDATE() WHERE id = @subId`);

  // Re-add to next month's draw if not already in it
  const priceResult = await pool.request()
    .input('subId', sql.Int, sub.id)
    .query(`SELECT stripe_price_id FROM subscription WHERE id = @subId`);

  const stripeSubscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['items'] });
  const monthlyFee = (stripeSubscription.items.data[0]?.price.unit_amount ?? 0) / 100;

  try {
    await handleDrawParticipation(pool, sub.business_id, monthlyFee);
  } catch (err: any) {
    console.error(`[Stripe] Draw re-participation failed for business ${sub.business_id} (non-fatal):`, err.message);
  }
};

// ─── Cancel Subscription ──────────────────────────────────────────────────────

export const cancelSubscription = async (userId: number): Promise<{ removedFromDraw: boolean }> => {
  const pool = getPool();

  // Get subscription record
  const subResult = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`
      SELECT s.id, s.stripe_subscription_id, b.id AS business_id
      FROM subscription s
      JOIN business b ON b.id = s.business_id
      WHERE b.user_id = @userId AND s.status != 'Cancelled'
    `);

  const sub = subResult.recordset[0];
  if (!sub) throw new Error('No active subscription found');

  // Cancel in Stripe at period end
  await stripe.subscriptions.update(sub.stripe_subscription_id, {
    cancel_at_period_end: true,
  });

  // Update our DB
  await pool.request()
    .input('subId', sql.Int, sub.id)
    .query(`UPDATE subscription SET cancel_at_period_end = 1, updated_at = GETDATE() WHERE id = @subId`);

  // Find any upcoming draw this business is registered for (next calendar month, not yet locked)
  const drawResult = await pool.request()
    .input('businessId', sql.Int, sub.business_id)
    .query(`
      SELECT d.id, d.status, d.prize_pool, de.contribution_amount, d.draw_date
      FROM draw_entry de
      JOIN draw d ON d.id = de.draw_id
      WHERE de.business_id = @businessId
        AND d.status = 'Upcoming'
    `);

  console.log(`[Cancel] business_id=${sub.business_id} draw rows found: ${drawResult.recordset.length}`);
  drawResult.recordset.forEach(r => console.log(`[Cancel] draw: id=${r.id} status=${r.status} date=${r.draw_date} contribution=${r.contribution_amount} pool=${r.prize_pool}`));

  const nextDraw = drawResult.recordset[0];
  let removedFromDraw = false;

  if (nextDraw) {
    // Locked once we are on or past the 1st day of the draw's month
    const drawDate = new Date(nextDraw.draw_date);
    const lockDate = new Date(drawDate.getFullYear(), drawDate.getMonth(), 1);
    const isLocked = new Date() >= lockDate;
    console.log(`[Cancel] draw ${nextDraw.id} lockDate=${lockDate.toISOString()} isLocked=${isLocked} contribution=${nextDraw.contribution_amount}`);

    if (!isLocked) {
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        await transaction.request()
          .input('drawId', sql.Int, nextDraw.id)
          .input('contribution', sql.Decimal(10, 2), nextDraw.contribution_amount)
          .query(`UPDATE draw SET prize_pool = IIF(prize_pool - @contribution < 0, 0, prize_pool - @contribution) WHERE id = @drawId`);

        await transaction.request()
          .input('drawId', sql.Int, nextDraw.id)
          .input('businessId', sql.Int, sub.business_id)
          .query(`DELETE FROM draw_entry WHERE draw_id = @drawId AND business_id = @businessId`);

        await transaction.commit();
        removedFromDraw = true;
        console.log(`[Cancel] Removed business ${sub.business_id} from draw ${nextDraw.id}, prize_pool reduced by $${nextDraw.contribution_amount}`);
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
    } else {
      console.log(`[Cancel] Draw ${nextDraw.id} is locked — business stays in draw`);
    }
  }

  return { removedFromDraw };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Stripe moved current_period_end around across API versions — try every known location
function extractPeriodEnd(subscription: Stripe.Subscription): Date {
  const raw =
    (subscription as any).current_period_end ??
    (subscription.items?.data?.[0] as any)?.current_period_end ??
    (subscription as any).billing_cycle_anchor;

  if (raw && typeof raw === 'number' && raw > 0) {
    return new Date(raw * 1000);
  }

  // Safe fallback: 30 days from now
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
