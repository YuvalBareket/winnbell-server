// src/features/business/business.routes.ts
import { Router } from 'express';
import { authenticateToken, requireRole } from '../../shared/middleware/auth.middleware.js';
import {
  createInviteLink,
  getAddressController,
  getMyBusiness,
  getNearby,
  setupBusiness,
  updateBusiness,
  updateLocation,
} from './business.controller.js';
import { getStats } from './stats.controller.js';
import { createCheckout, verifySession, getSubscription, cancelSub, resumeSub } from '../stripe/stripe.controller.js';

const router = Router();

router.get('/nearby', getNearby);
router.post('/address', getAddressController);
router.post('/setup', setupBusiness);
router.get('/my-business', authenticateToken, getMyBusiness);
router.patch('/', authenticateToken, updateBusiness);
router.patch('/locations/:locationId', authenticateToken, updateLocation);
router.post(
  '/locations/:locationId/invite',
  authenticateToken,
  createInviteLink,
);
router.get('/stats', authenticateToken, requireRole('Business', 'Admin'), getStats);
router.post('/subscription/checkout', authenticateToken, createCheckout);
router.post('/subscription/verify-session', authenticateToken, verifySession);
router.get('/subscription', authenticateToken, getSubscription);
router.post('/subscription/cancel', authenticateToken, cancelSub);
router.post('/subscription/resume', authenticateToken, resumeSub);

export default router;
