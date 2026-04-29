import { Response } from 'express';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import { getBusinessActivity } from './activity.service.js';

export const getActivity = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const jwtLocationId = req.user!.location_id ?? null;

    const filterLocationId = req.query.location_id
      ? parseInt(req.query.location_id as string, 10)
      : undefined;

    const rawRange = req.query.date_range as string;
    const dateRange: 'today' | '7d' | '30d' =
      rawRange === '7d' ? '7d' : rawRange === '30d' ? '30d' : 'today';

    const cursor = req.query.cursor ? parseInt(req.query.cursor as string, 10) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 25;

    const data = await getBusinessActivity(userId, jwtLocationId, filterLocationId, dateRange, cursor, limit);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ message: err.message || 'Failed to load activity' });
  }
};
