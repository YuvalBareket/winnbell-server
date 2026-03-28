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

export default router;
