import { Router } from 'express';
import { ingestEvents } from './analytics.controller.js';

const router = Router();

// Public (works pre-signup); optionalAuth + limiter + 10kb body cap attached in app.ts.
router.post('/', ingestEvents);

export default router;
