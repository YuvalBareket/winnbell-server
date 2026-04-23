import { Router } from 'express';
import * as drawsController from './draws.controller.js';
const router = Router();

router.get('/active', drawsController.getActiveDraws);
router.get('/history', drawsController.getDrawHistory);
router.get('/:drawId/result', drawsController.getDrawResult);
export default router;
