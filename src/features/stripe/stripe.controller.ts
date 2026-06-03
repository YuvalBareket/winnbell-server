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
// Body: { founding: true }  → founding partner one-time $1,000
// Body: { entries_per_location, billing_interval } → regular recurring subscription
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
      res.status(400).json({ error: 'Invalid entries_per_location. Must be 250–2500 in steps of 250.' });
      return;
    }
    const billingInterval: 'monthly' | 'yearly' = req.body.billing_interval === 'yearly' ? 'yearly' : 'monthly';
    const result = await createCheckoutSession(business.id, business.email, entriesPerLocation, billingInterval);
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
    console.error('[stripe.createCheckout]', err);
    res.status(500).json({ error: 'Subscription setup failed. Please try again.' });
  }
};

// POST /business/subscription/verify-session
export const verifySession = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.body;
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    await verifyAndActivateSession(sessionId, userId);
    res.json({ activated: true });
  } catch (err: unknown) {
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
    res.status(400).json({ error: err instanceof Error ? err.message : 'Cancellation failed. Please try again.' });
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
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not resume subscription. Please try again.' });
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
  } catch (err: any) {
    console.error('[stripe.updatePlan]', err);
    res.status(400).json({ error: err.message ?? 'Failed to update plan' });
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
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};
