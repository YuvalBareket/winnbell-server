import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import * as ticketController from './tickets.controller.js';
import { requireRole, requirePhoneVerified, requireProfileComplete, requireActive } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimitStore } from '../../shared/rateLimitStore.js';
import { getClientIpKey } from '../../shared/clientIp.js';

// 5 entry attempts per minute per user (keyed on JWT user ID, not IP)
const entryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id?.toString() ?? getClientIpKey(req),
  store: makeRateLimitStore('entry'),
  message: { message: 'Too many attempts, please slow down.' },
});

const router = Router();

// Entry-creating routes also require the step-2 profile (DOB + gender) on record - the
// server-side age gate; the client's /profile-setup redirect alone is trivially bypassed.
router.post('/redeem', requireRole('User'), requirePhoneVerified, requireProfileComplete, entryLimiter, ticketController.redeemCode);
router.get('/my-tickets', ticketController.getMyTickets);
router.get('/free-status', ticketController.getStatus);
router.post('/activate-free', requireRole('User'), requirePhoneVerified, requireProfileComplete, entryLimiter, ticketController.activate);
router.post('/generate', requireRole('Business', 'Admin'), requireActive, entryLimiter, ticketController.generateTicket);
router.post('/receipt-entry', requireRole('User'), requirePhoneVerified, requireProfileComplete, entryLimiter, ticketController.submitReceiptEntry);
router.get('/receipt-upload-url', requireRole('User'), requirePhoneVerified, entryLimiter, ticketController.getReceiptUploadUrl);
router.get('/my-risk-level', ticketController.getMyRiskLevel);
router.post('/activate-promotional', requireRole('User'), requirePhoneVerified, requireProfileComplete, entryLimiter, ticketController.activatePromotional);
export default router;
