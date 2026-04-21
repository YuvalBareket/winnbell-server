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

    const url = await createCheckoutSession(business.id, business.email, entriesPerLocation);
    res.json({ url });
  } catch (err: any) {
    const status = err.message.includes('already has an active subscription') ? 409 : 500;
    res.status(status).json({ error: err.message });
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
  } catch (err: any) {
    console.error('[verifySession] Error:', err.message);
    res.status(400).json({ error: err.message });
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// POST /business/subscription/cancel
export const cancelSub = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await cancelSubscription(userId);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

// POST /business/subscription/resume
export const resumeSub = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await resumeSubscription(userId);
    res.json({ resumed: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
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
