import { Response } from 'express';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import { getBusinessActivity, setTicketQualification } from './activity.service.js';

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
  } catch (err: unknown) {
    res.status(500).json({ message: 'Failed to load activity' });
  }
};

export const qualifyTicket = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const jwtLocationId = req.user!.location_id ?? null;
    const ticketId = parseInt(req.params['ticketId'] as string, 10);
    const { disqualify } = req.body;

    if (isNaN(ticketId)) {
      res.status(400).json({ message: 'Invalid ticket ID' });
      return;
    }
    if (typeof disqualify !== 'boolean') {
      res.status(400).json({ message: 'disqualify must be a boolean' });
      return;
    }

    await setTicketQualification(ticketId, userId, jwtLocationId, disqualify);
    res.status(200).json({ success: true });
  } catch (err: unknown) {
    const status = (err instanceof Error && 'status' in err) ? ((err as Error & { status: number }).status ?? 500) : 500;
    res.status(status).json({ message: 'Failed to update ticket' });
  }
};
