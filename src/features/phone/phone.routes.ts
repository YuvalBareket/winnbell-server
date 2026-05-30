import { Router } from 'express';
import { authenticateToken } from '../../shared/middleware/auth.middleware.js';
import * as phoneController from './phone.controller.js';

const router = Router();

router.post('/send-otp', authenticateToken, phoneController.sendOtp);
router.post('/verify-otp', authenticateToken, phoneController.verifyOtp);

export default router;
