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
router.post('/refresh', authController.refreshTokenController);
router.post('/revoke-sessions', authController.revokeAllSessions);
router.post('/change-password', authenticateToken, authController.changePassword);
router.delete('/account', authenticateToken, authController.deleteAccount);
// Dev/test only — registered in app.ts with NODE_ENV guard

export default router;
