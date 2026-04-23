import { Router } from 'express';
import * as ticketController from './tickets.controller.js';
import { requireRole } from '../../shared/middleware/auth.middleware.js';

const router = Router();

router.post('/redeem', ticketController.redeemCode);
router.get('/my-tickets', ticketController.getMyTickets);
router.get('/free-status', ticketController.getStatus);
router.post('/activate-free', ticketController.activate);
router.post('/generate', requireRole('Business', 'Admin'), ticketController.generateTicket);
router.post('/receipt-entry', ticketController.submitReceiptEntry);
router.get('/receipt-upload-url', ticketController.getReceiptUploadUrl);
router.get('/my-risk-level', ticketController.getMyRiskLevel);
router.post('/activate-promotional', ticketController.activatePromotional);
export default router;
