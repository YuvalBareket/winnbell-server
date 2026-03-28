import { Response } from 'express';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import { getBusinessStats } from './stats.service.js';

export const getStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const jwtLocationId = req.user!.location_id ?? null;
    const filterLocationId = req.query.location_id
      ? parseInt(req.query.location_id as string, 10)
      : undefined;
    const filterDrawId = req.query.draw_id
      ? parseInt(req.query.draw_id as string, 10)
      : undefined;

    const data = await getBusinessStats(userId, jwtLocationId, filterLocationId, filterDrawId);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ message: err.message || 'Failed to load stats' });
  }
};
