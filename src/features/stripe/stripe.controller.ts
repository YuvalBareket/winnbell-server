import { Request, Response } from 'express';
import {
  createCheckoutSession,
  handleStripeWebhook,
  verifyAndActivateSession,
  getSubscriptionDetails,
  cancelSubscription,
  resumeSubscription,
  getBusinessForCheckout,
  TIER_PRICE_MAP,
} from './stripe.service.js';

// POST /business/subscription/checkout
export const createCheckout = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const business = await getBusinessForCheckout(userId);
    if (!business) {
      res.status(404).json({ error: 'Business not found' });
      return;
    }

    const entriesPerLocation = Number(req.body.entries_per_location);
    if (!TIER_PRICE_MAP[entriesPerLocation]) {
      res.status(400).json({ error: 'Invalid entries_per_location. Must be 250–2500 in steps of 250.' });
      return;
    }

    const billingInterval: 'monthly' | 'yearly' = req.body.billing_interval === 'yearly' ? 'yearly' : 'monthly';
    const url = await createCheckoutSession(business.id, business.email, entriesPerLocation, billingInterval);
    res.json({ url });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('already has an active subscription')) {
      res.status(409).json({ error: 'This business already has an active subscription.' });
      return;
    }
    if (msg.includes('CAMPAIGN_CUTOFF:')) {
      res.status(409).json({ error: msg.replace('CAMPAIGN_CUTOFF:', '') });
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
    if (!details) {
      res.status(404).json({ error: 'No subscription found' });
      return;
    }
    res.json(details);
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
