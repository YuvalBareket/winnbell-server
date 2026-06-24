import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as ticketController from './tickets.controller.js';
import { requireRole, requirePhoneVerified, requireActive } from '../../shared/middleware/auth.middleware.js';
import { makeRateLimitStore } from '../../shared/rateLimitStore.js';

// 5 entry attempts per minute per user (keyed on JWT user ID, not IP)
const entryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.id?.toString(),
  store: makeRateLimitStore('entry'),
  message: { message: 'Too many attempts, please slow down.' },
});

const router = Router();

router.post('/redeem', requireRole('User'), requirePhoneVerified, entryLimiter, ticketController.redeemCode);
router.get('/my-tickets', ticketController.getMyTickets);
router.get('/free-status', ticketController.getStatus);
router.post('/activate-free', requireRole('User'), requirePhoneVerified, entryLimiter, ticketController.activate);
router.post('/generate', requireRole('Business', 'Admin'), requireActive, entryLimiter, ticketController.generateTicket);
router.post('/receipt-entry', requireRole('User'), requirePhoneVerified, entryLimiter, ticketController.submitReceiptEntry);
router.get('/receipt-upload-url', requireRole('User'), requirePhoneVerified, entryLimiter, ticketController.getReceiptUploadUrl);
router.get('/my-risk-level', ticketController.getMyRiskLevel);
router.post('/activate-promotional', requireRole('User'), requirePhoneVerified, entryLimiter, ticketController.activatePromotional);
export default router;
