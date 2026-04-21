import { Router } from 'express';
import { subscribe, unsubscribe, broadcast } from './notifications.controller.js';
import { requireRole } from '../../shared/middleware/auth.middleware.js';

const router = Router();

router.post('/subscribe', subscribe);
router.post('/unsubscribe', unsubscribe);
router.post('/broadcast', requireRole('Admin'), broadcast);

export default router;
