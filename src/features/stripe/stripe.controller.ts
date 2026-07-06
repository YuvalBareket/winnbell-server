import { Request, Response } from 'express';
import {
  createFoundingMemberCheckoutSession,
  createCheckoutSession,
  getFoundingMemberCount,
  handleStripeWebhook,
  verifyAndActivateSession,
  getSubscriptionDetails,
  cancelSubscription,
  resumeSubscription,
  getBusinessForCheckout,
  TIER_PRICE_MAP,
  updateSubscriptionPlan,
  getSubscriptionInvoices,
  setSkipNextCampaign,
  createUpdatePaymentMethodSession,
} from './stripe.service.js';

// GET /business/subscription/founding-availability  (public — no auth)
export const getFoundingAvailability = async (_req: Request, res: Response) => {
  try {
    const availability = await getFoundingMemberCount();
    res.set('Cache-Control', 'public, max-age=10');
    res.json(availability);
  } catch (err: unknown) {
    console.error('[stripe.getFoundingAvailability]', err);
    res.status(500).json({ error: 'Failed to fetch availability.' });
  }
};

// POST /business/subscription/checkout
// Body: { founding: true }  → founding partner one-time $1,200
// Body: { entries_per_location } → regular monthly subscription
export const createCheckout = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const business = await getBusinessForCheckout(userId);
    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    // ── Founding member flow ───────────────────────────────────────────────
    if (req.body.founding === true) {
      const result = await createFoundingMemberCheckoutSession(business.id, business.email);
      res.json(result);
      return;
    }

    // ── Regular recurring subscription flow ────────────────────────────────
    const entriesPerLocation = Number(req.body.entries_per_location);
    if (!TIER_PRICE_MAP[entriesPerLocation]) {
      res.status(400).json({ error: 'Invalid entries_per_location. Must be 250–3000 in steps of 250.' });
      return;
    }
    const result = await createCheckoutSession(business.id, business.email, entriesPerLocation);
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('already has an active subscription')) {
      res.status(409).json({ error: 'This business already has an active subscription.' });
      return;
    }
    if (msg.includes('not currently active')) {
      res.status(403).json({ error: 'The founding partner program is not currently active.' });
      return;
    }
    if (msg.includes('spots have been claimed')) {
      res.status(409).json({ error: 'All founding partner spots have been claimed.' });
      return;
    }
    if (msg === 'FOUNDING_LOCATION_LIMIT') {
      res.status(403).json({ error: 'The founding partner plan covers up to 3 locations. Please choose a regular plan for more locations.' });
      return;
    }
    console.error('[stripe.createCheckout]', err);
    res.status(500).json({ error: 'Subscription setup failed. Please try again.' });
  }
};

// POST /business/subscription/verify-session
export const verifySession = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.body;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 200) {
      res.status(400).json({ error: 'Invalid or missing sessionId.' });
      return;
    }
    await verifyAndActivateSession(sessionId, userId);
    res.json({ activated: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    // Sold-out founding payment was already auto-refunded — the client must tell the
    // truth ("your money is back") instead of a generic "contact support" failure.
    if (msg.includes('A full refund has been issued')) {
      res.status(409).json({ error: msg, code: 'FOUNDING_SOLD_OUT_REFUNDED' });
      return;
    }
    console.error('[stripe.verifySession]', err);
    res.status(400).json({ error: 'Session verification failed. Please try again.' });
  }
};

// GET /business/subscription
export const getSubscription = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const details = await getSubscriptionDetails(userId);
    res.json(details ?? null);
  } catch (err: unknown) {
    console.error('[stripe.getSubscription]', err);
    res.status(500).json({ error: 'Failed to retrieve subscription.' });
  }
};

// POST /business/subscription/cancel
export const cancelSub = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await cancelSubscription(userId);
    res.json(result);
  } catch (err: unknown) {
    console.error('[stripe.cancelSub]', err);
    if (err instanceof Error && err.message === 'REFUND_FAILED') {
      res.status(502).json({ error: 'Your refund could not be processed, so the membership was NOT cancelled. Please try again or contact support.' });
      return;
    }
    res.status(400).json({ error: 'Cancellation failed. Please try again.' });
  }
};

// POST /business/subscription/resume
export const resumeSub = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await resumeSubscription(userId);
    res.json({ resumed: true });
  } catch (err: unknown) {
    console.error('[stripe.resumeSub]', err);
    res.status(400).json({ error: 'Could not resume subscription. Please try again.' });
  }
};

// PUT /business/subscription/plan
// Body: { entries_per_location: number }
export const updatePlan = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const { entries_per_location } = req.body as { entries_per_location: number };
  if (!entries_per_location || !Number.isInteger(entries_per_location) || entries_per_location < 1) {
    res.status(400).json({ error: 'entries_per_location must be a positive integer' });
    return;
  }
  try {
    await updateSubscriptionPlan(userId, entries_per_location);
    res.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'PAYMENT_ISSUE') {
      res.status(402).json({ error: 'Please update your payment method before changing your plan.' });
      return;
    }
    if (msg === 'CHARGE_FAILED') {
      res.status(402).json({ error: 'We could not charge your card for the plan difference, so nothing was changed. Please try again.' });
      return;
    }
    if (msg.startsWith('REFUND_INCOMPLETE')) {
      res.status(502).json({ error: 'We could not process the refund for this change, so nothing was changed. Please try again or contact support.' });
      return;
    }
    if (msg === 'Already on this tier') {
      res.status(400).json({ error: 'You are already on this plan.' });
      return;
    }
    console.error('[stripe.updatePlan]', err);
    res.status(400).json({ error: 'Failed to update plan' });
  }
};

// POST /business/subscription/skip-campaign
// Body: { skip: boolean } — opt out of (or back into) the campaign already paid for.
// Only available between the charge on the 24th and the campaign open. No refund.
export const skipCampaign = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const skip = req.body?.skip !== false; // default true
    await setSkipNextCampaign(userId, skip);
    res.json({ skipped: skip });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'SKIP_WINDOW_CLOSED') {
      res.status(409).json({ error: 'The next campaign has already opened. Contact support to be removed from a running campaign.' });
      return;
    }
    if (msg === 'No active subscription found') {
      res.status(404).json({ error: 'No active subscription found.' });
      return;
    }
    console.error('[stripe.skipCampaign]', err);
    res.status(400).json({ error: 'Could not update campaign participation. Please try again.' });
  }
};

// GET /business/subscription/invoices
export const getInvoices = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const invoices = await getSubscriptionInvoices(userId);
    res.json(invoices);
  } catch (err: unknown) {
    console.error('[stripe.getInvoices]', err);
    res.status(500).json({ error: 'Failed to retrieve invoices.' });
  }
};

// POST /business/subscription/update-payment-method
// Opens a Stripe setup session on the existing customer to save a new card. On completion
// the card becomes the default and outstanding invoices are retried with it immediately.
export const updatePaymentMethod = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await createUpdatePaymentMethodSession(userId);
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'SUBSCRIPTION_CANCELLED') {
      res.status(409).json({ error: 'Your subscription has ended. Start a new plan instead.' });
      return;
    }
    if (msg === 'No billing account found') {
      res.status(404).json({ error: 'No billing account found.' });
      return;
    }
    console.error('[stripe.updatePaymentMethod]', err);
    res.status(500).json({ error: 'Could not open the payment update page. Please try again.' });
  }
};

// POST /webhooks/stripe  (raw body, no auth middleware)
export const stripeWebhook = async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'] as string;
  if (!signature) {
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }
  try {
    await handleStripeWebhook(req.body as Buffer, signature);
    res.json({ received: true });
  } catch (err: unknown) {
    res.status(400).json({ error: 'Webhook processing failed.' });
  }
};
