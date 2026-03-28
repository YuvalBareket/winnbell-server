import { Router } from 'express';
import * as adminController from './admin.controller.js';
import { requireRole } from '../../shared/middleware/auth.middleware.js';

const router = Router();

router.use(requireRole('Admin'));

router.get('/businesses', adminController.getDashboardData);
router.get('/draws', adminController.getDraws);
router.post('/generate-tickets', adminController.createTickets);
router.post('/business', adminController.createBusiness);
router.get('/draws-all', adminController.getAllDraws);
router.post('/draw', adminController.createDraw);

export default router;
