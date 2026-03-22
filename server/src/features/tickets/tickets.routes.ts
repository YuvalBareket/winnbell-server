import { Router } from 'express';
import * as ticketController from './tickets.controller.js';
import { authenticateToken } from '../../shared/middleware/auth.middleware.js';

const router = Router();

router.post('/redeem', authenticateToken, ticketController.redeemCode);
router.get('/my-tickets', authenticateToken, ticketController.getMyTickets);
router.get('/free-status', authenticateToken, ticketController.getStatus);
router.post('/activate-free', authenticateToken, ticketController.activate);
router.post('/generate', authenticateToken, ticketController.generateTicket);
export default router;
