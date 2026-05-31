import { Router } from 'express';
import * as authController from './auth.controller.js';
import { testSetup } from './test-setup.controller.js';
import { authenticateToken } from '../../shared/middleware/auth.middleware.js';

const router = Router();

router.get('/region-config', authController.getRegionConfig);
router.get('/region-check', authController.checkRegion);
router.post('/register', authController.register);
router.post('/check-email', authController.checkEmail);
router.post('/login', authController.login);
router.post('/sync', authController.syncUser);
router.post('/change-password', authenticateToken, authController.changePassword);
// Dev/test only — blocked in production
router.post('/test-setup', testSetup);

export default router;
