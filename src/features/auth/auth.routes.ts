import { Router, type Request, type Response, type NextFunction } from 'express';
import * as authController from './auth.controller.js';
import { testSetup } from './test-setup.controller.js';
import { authenticateToken } from '../../shared/middleware/auth.middleware.js';

const router = Router();

// Pre-launch lock: ACCESS_LOCKED=true (set only on the production service until launch)
// closes every session-creating route. The client shows the access gate; this closes the
// API itself so a direct request can't bypass the gate. /refresh and /logout stay open so
// any session that existed before the lock keeps working. Flip the env var off at launch.
export const accessLock = (_req: Request, res: Response, next: NextFunction) => {
  if (process.env.ACCESS_LOCKED === 'true') {
    res.status(403).json({
      code: 'ACCESS_LOCKED',
      message: "We're so excited for you to join! Winnbell is coming very soon - stay tuned.",
    });
    return;
  }
  next();
};

router.get('/region-config', authController.getRegionConfig);
router.get('/region-check', authController.checkRegion);
// Legacy password endpoints: the real product flow is 100% Supabase (/sync). These have
// ZERO client consumers and /register would mint a JWT with NO email verification, so in
// production they simply do not exist. Kept for local dev tooling and tests only.
if (process.env.NODE_ENV !== 'production') {
  router.post('/register', accessLock, authController.register);
  router.post('/login', accessLock, authController.login);
}
router.post('/check-email', authController.checkEmail);
router.post('/sync', accessLock, authController.syncUser);
router.post('/refresh', authController.refreshTokenController);
router.post('/logout', authController.logoutController);
router.post('/revoke-sessions', authController.revokeAllSessions);
router.post('/profile-setup', authenticateToken, authController.profileSetup);
router.post('/update-name', authenticateToken, authController.updateName);
router.delete('/account', authenticateToken, authController.deleteAccount);
// Dev/test only — registered in app.ts with NODE_ENV guard

export default router;
