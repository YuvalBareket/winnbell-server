import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import * as ticketController from './tickets.controller.js';
import { requireRole, requirePhoneVerified, requireProfileComplete } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimitStore } from '../../shared/rateLimitStore.js';
import { getClientIpKey } from '../../shared/clientIp.js';

// 5 entry attempts per minute per user (keyed on JWT user ID, not IP).
// Outside production the cap scales up (same policy as the app.ts limiters) so E2E
// entry flows and rapid manual testing never trip 429s on the dev machine.
const entryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5 * (process.env.NODE_ENV === 'production' ? 1 : 5),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id?.toString() ?? getClientIpKey(req),
  store: makeRateLimitStore('entry'),
  message: { message: 'Too many attempts, please slow down.' },
});

const router = Router();

// Entry-creating routes also require the step-2 profile (DOB + gender + state) on record -
// the server-side age gate; the client's /profile-setup redirect alone is trivially bypassed.
router.get('/my-tickets', ticketController.getMyTickets);
router.get('/free-status', ticketController.getStatus);
router.post('/activate-free', requireRole('User'), requirePhoneVerified, requireProfileComplete, entryLimiter, ticketController.activate);
router.post('/receipt-entry', requireRole('User'), requirePhoneVerified, requireProfileComplete, entryLimiter, ticketController.submitReceiptEntry);
router.get('/receipt-upload-url', requireRole('User'), requirePhoneVerified, entryLimiter, ticketController.getReceiptUploadUrl);
router.get('/my-risk-level', ticketController.getMyRiskLevel);
// STAGING DEMO ONLY (temporary). Self-service reset for the demo account; the service
// double-gates on isDemoUser so it is inert in production and for every other user.
router.post('/reset-demo', requireRole('User'), ticketController.resetDemo);
router.post('/activate-promotional', requireRole('User'), requirePhoneVerified, requireProfileComplete, entryLimiter, ticketController.activatePromotional);
export default router;
