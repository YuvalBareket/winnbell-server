import { Router } from 'express';
import * as adminController from './admin.controller.js';

const router = Router();

// Get the main dashboard stats (Businesses + Ticket counts)
router.get('/businesses', adminController.getDashboardData);

// Get available draws for the generation modal
router.get('/draws', adminController.getDraws);

// Handle the batch ticket generation
router.post('/generate-tickets', adminController.createTickets);
router.post('/business', adminController.createBusiness);

router.get('/draws-all', adminController.getAllDraws); // Renamed to avoid confusion with the active-only list
router.post('/draw', adminController.createDraw);
export default router;
