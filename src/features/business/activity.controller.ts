import { Response } from 'express';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import {
  setTicketQualification,
  getCampaignHeader, getCampaignKpis, getCampaignEntries, listBusinessCampaigns,
} from './activity.service.js';
import type { DateRange } from './activity.service.js';

const parseRange = (raw: unknown): DateRange => {
  const r = String(raw);
  return (r === 'wtd' || r === 'mtd' || r === '7d' || r === '30d') ? r : 'today';
};
const parseLoc = (req: AuthRequest): number | undefined =>
  req.query.location_id ? parseInt(req.query.location_id as string, 10) : undefined;
const parseDrawId = (req: AuthRequest): number | undefined =>
  req.query.draw_id ? parseInt(req.query.draw_id as string, 10) : undefined;

export const getCampaignHeaderController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const data = await getCampaignHeader(req.user!.id, req.user!.location_id ?? null, parseLoc(req), parseDrawId(req));
    res.json(data);
  } catch {
    res.status(500).json({ message: 'Failed to load campaign' });
  }
};

export const getCampaignKpisController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const data = await getCampaignKpis(req.user!.id, req.user!.location_id ?? null, parseLoc(req), parseRange(req.query.date_range), parseDrawId(req));
    res.json(data);
  } catch {
    res.status(500).json({ message: 'Failed to load KPIs' });
  }
};

export const getCampaignEntriesController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const needsReviewOnly = req.query.needs_review === 'true' || req.query.needs_review === '1';
    const cursor = req.query.cursor ? (req.query.cursor as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 25;
    const data = await getCampaignEntries(req.user!.id, req.user!.location_id ?? null, parseLoc(req), needsReviewOnly, parseDrawId(req), cursor, limit);
    res.json(data);
  } catch {
    res.status(500).json({ message: 'Failed to load entries' });
  }
};

export const getCampaignsController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const data = await listBusinessCampaigns(req.user!.id, req.user!.location_id ?? null);
    res.json(data);
  } catch {
    res.status(500).json({ message: 'Failed to load campaigns' });
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
