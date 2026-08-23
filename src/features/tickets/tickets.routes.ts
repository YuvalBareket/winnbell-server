import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import * as ticketController from './tickets.controller.js';
import { requireRole, requirePhoneVerified, requireProfileComplete } from '../../shared/middleware/auth.middleware.js';
import { requireEntryRegion } from '../auth/region.middleware.js';
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
  message: { message: 'You\'re moving fast! Give it a minute and try again.' },
});

// Receipt-scan autofill: each scan is a paid Gemini call, so cap it at 10 per user per day
// (honest use is 1-2 scans per entry, 5 entries/day max). Short-window burst protection is
// covered by sharing the per-minute entryLimiter on the route.
const scanLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 10 * (process.env.NODE_ENV === 'production' ? 1 : 5),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id?.toString() ?? getClientIpKey(req),
  store: makeRateLimitStore('rscan'),
  message: { message: 'Daily scan limit reached. You can still type the receipt details.' },
});

const router = Router();

// Entry-creating routes also require the step-2 profile (DOB + gender + state) on record -
// the server-side age gate; the client's /profile-setup redirect alone is trivially bypassed.
router.get('/my-tickets', ticketController.getMyTickets);
router.get('/free-status', ticketController.getStatus);
// requireEntryRegion sits AFTER the limiter so external geo-lookup quota is limiter-capped.
// It hard-blocks only non-US traffic (ToS physical presence at entry); a wrong-state result
// is a soft risk signal recorded on the entry, never a block (carrier IPs misresolve states).
router.post('/activate-free', requireRole('User'), requirePhoneVerified, requireProfileComplete, entryLimiter, requireEntryRegion, ticketController.activate);
router.post('/receipt-entry', requireRole('User'), requirePhoneVerified, requireProfileComplete, entryLimiter, requireEntryRegion, ticketController.submitReceiptEntry);
router.get('/receipt-upload-url', requireRole('User'), requirePhoneVerified, entryLimiter, ticketController.getReceiptUploadUrl);
router.post('/receipt-scan', requireRole('User'), requirePhoneVerified, entryLimiter, scanLimiter, ticketController.scanReceipt);
router.get('/my-risk-level', requireRole('User'), ticketController.getMyRiskLevel);
// STAGING DEMO ONLY (temporary). Self-service reset of the caller's OWN activity; the service
// gates on DEMO_USER_ENABLED (staging-only) so it is inert in production.
router.post('/reset-demo', requireRole('User'), ticketController.resetDemo);
router.post('/activate-promotional', requireRole('User'), requirePhoneVerified, requireProfileComplete, entryLimiter, requireEntryRegion, ticketController.activatePromotional);
export default router;
