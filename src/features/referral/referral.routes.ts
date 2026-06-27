import { Router } from 'express';
import { getMyReferralLink } from './referral.controller.js';

// Authenticated referral routes (mounted behind authenticateToken in app.ts).
// The public /referral/resolve endpoint is registered separately in the public section.
const router = Router();

router.get('/link', getMyReferralLink);

export default router;
