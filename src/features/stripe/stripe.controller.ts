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
  setParticipationPaused,
  createUpdatePaymentMethodSession,
  createFoundingRenewalCheckoutSession,
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
// Body: { founding: true }  → founding partner one-time per-location fee (FOUNDING_PRICE_PER_LOCATION, fixed term)
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
      res.status(400).json({ error: 'Invalid entries_per_location. Must be 1000, 2500, or 5000.' });
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
    const { subscriptionStatus } = await verifyAndActivateSession(sessionId, userId);
    // subscriptionStatus 'Incomplete' = the in-window signup charge was DECLINED: the
    // subscription exists but the business is NOT enrolled until the card is fixed. The
    // success page must not celebrate in that case.
    res.json({ activated: true, subscriptionStatus });
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
    // The owner's explicit dialog choice: true = also remove from participation now
    // (off the map, not in the paid upcoming campaign, no refund). Default false =
    // keep everything already paid for; the plan just does not renew.
    const immediate = req.body?.immediate === true;
    const result = await cancelSubscription(userId, immediate);
    res.json(result);
  } catch (err: unknown) {
    console.error('[stripe.cancelSub]', err);
    // Founding Partner Special Terms: fixed term, no early termination, no refund.
    if (err instanceof Error && err.message === 'FOUNDING_NO_CANCEL') {
      res.status(400).json({ error: 'Founding Partner plans run for a fixed term and do not renew, so there is nothing to cancel. Your membership stays active through its full term.' });
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
    if (msg === 'SUBSCRIPTION_CANCELLING') {
      res.status(409).json({ error: 'Your plan is set to cancel. Resume it before changing your plan.' });
      return;
    }
    console.error('[stripe.updatePlan]', err);
    res.status(400).json({ error: 'Failed to update plan' });
  }
};

// POST /business/subscription/participation
// Body: { paused: boolean } — founding only. Voluntary cancel of participation: no
// refund, off the map immediately, no new customer entries, not enrolled in upcoming
// campaigns. Reactivation allowed while the founding term still runs.
export const setParticipation = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const paused = req.body?.paused !== false; // default true
    await setParticipationPaused(userId, paused);
    res.json({ paused });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'FOUNDING_ONLY') {
      res.status(409).json({ error: 'This action is only available for Founding Partner plans.' });
      return;
    }
    if (msg === 'FOUNDING_TERM_ENDED') {
      res.status(409).json({ error: 'Your founding term has ended. Start a new plan to join upcoming campaigns.' });
      return;
    }
    if (msg === 'No active subscription found') {
      res.status(404).json({ error: 'No active subscription found.' });
      return;
    }
    console.error('[stripe.setParticipation]', err);
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

// POST /business/subscription/founding-renewal
// Special Terms Section 6: renew the founding membership for one additional fixed
// term at the original monthly rate (rate x 12). Only available in the final 30 days of the term.
export const foundingRenewal = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await createFoundingRenewalCheckoutSession(userId);
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'RENEWAL_NOT_OPEN') {
      res.status(409).json({ error: 'Renewal opens in the final 30 days of your founding term.' });
      return;
    }
    if (msg === 'RENEWAL_EXPIRED') {
      res.status(409).json({ error: 'Your founding term has ended, so the founding renewal is no longer available. You can start a regular plan instead.' });
      return;
    }
    if (msg === 'RENEWAL_ALREADY_USED') {
      res.status(409).json({ error: 'The founding renewal can only be used once. When your renewed term ends, you can continue with a regular plan.' });
      return;
    }
    if (msg.includes('No active founding membership')) {
      res.status(404).json({ error: 'No active founding membership found.' });
      return;
    }
    console.error('[stripe.foundingRenewal]', err);
    res.status(500).json({ error: 'Could not start the renewal. Please try again.' });
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
