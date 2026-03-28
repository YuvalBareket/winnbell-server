import { Router } from 'express';
import { stripeWebhook } from './stripe.controller.js';

// This router handles the public Stripe webhook (no auth, raw body)
const router = Router();

router.post('/', stripeWebhook);

export default router;
