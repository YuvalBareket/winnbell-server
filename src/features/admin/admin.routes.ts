import { Router } from 'express';
import * as adminController from './admin.controller.js';
import { requireRole } from '../../shared/middleware/auth.middleware.js';

const router = Router();

router.use(requireRole('Admin'));

router.get('/overview', adminController.getOverview);
router.get('/businesses', adminController.getDashboardData);
router.get('/draws', adminController.getDraws);
router.get('/draws-all', adminController.getAllDraws);
router.get('/users', adminController.getUsers);
router.patch('/users/:userId/role', adminController.updateUserRole);
router.patch('/users/:userId/active', adminController.toggleUserActive);
router.post('/generate-tickets', adminController.createTickets);
router.post('/business', adminController.createBusiness);
router.post('/draw', adminController.createDraw);
router.post('/draws/:drawId/open', adminController.openDraw);
router.post('/draws/:drawId/close', adminController.closeDraw);
router.post('/draws/:drawId/pick-winner', adminController.pickWinner);
router.get('/draws/:drawId/businesses', adminController.getDrawBusinesses);
router.get('/settings', adminController.getPlatformSettings);
router.patch('/settings', adminController.updatePlatformSettings);

router.get('/promo-codes', adminController.getPromoCodes);
router.post('/promo-codes', adminController.createPromoCode);
router.patch('/promo-codes/:id/deactivate', adminController.deactivatePromoCode);

export default router;
