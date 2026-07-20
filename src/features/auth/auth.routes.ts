import { Router } from 'express';
import * as authController from './auth.controller.js';
import { testSetup } from './test-setup.controller.js';
import { authenticateToken } from '../../shared/middleware/auth.middleware.js';

const router = Router();

router.get('/region-config', authController.getRegionConfig);
router.get('/region-check', authController.checkRegion);
// Legacy password endpoints: the real product flow is 100% Supabase (/sync). These have
// ZERO client consumers and /register would mint a JWT with NO email verification, so in
// production they simply do not exist. Kept for local dev tooling and tests only.
if (process.env.NODE_ENV !== 'production') {
  router.post('/register', authController.register);
  router.post('/login', authController.login);
}
router.post('/check-email', authController.checkEmail);
router.post('/sync', authController.syncUser);
router.post('/refresh', authController.refreshTokenController);
router.post('/logout', authController.logoutController);
router.post('/revoke-sessions', authController.revokeAllSessions);
router.post('/profile-setup', authenticateToken, authController.profileSetup);
router.post('/update-name', authenticateToken, authController.updateName);
router.delete('/account', authenticateToken, authController.deleteAccount);
// Dev/test only — registered in app.ts with NODE_ENV guard

export default router;
