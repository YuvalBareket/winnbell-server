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
    res.status(403).json({ message: 'Winnbell is not open yet.' });
    return;
  }
  next();
};

router.get('/region-config', authController.getRegionConfig);
router.get('/region-check', authController.checkRegion);
router.post('/register', accessLock, authController.register);
router.post('/check-email', authController.checkEmail);
router.post('/login', accessLock, authController.login);
router.post('/sync', accessLock, authController.syncUser);
router.post('/refresh', authController.refreshTokenController);
router.post('/logout', authController.logoutController);
router.post('/revoke-sessions', authController.revokeAllSessions);
router.post('/profile-setup', authenticateToken, authController.profileSetup);
router.delete('/account', authenticateToken, authController.deleteAccount);
// Dev/test only — registered in app.ts with NODE_ENV guard

export default router;
