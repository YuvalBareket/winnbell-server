import { Router } from 'express';
import { authenticateToken } from '../../shared/middleware/auth.middleware.js';
import * as drawsController from './draws.controller.js';
const router = Router();

router.get('/active', authenticateToken, drawsController.getActiveDraws);
export default router;
