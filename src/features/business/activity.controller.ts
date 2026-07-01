import { Response } from 'express';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import {
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
    const cursor = req.query.cursor ? (req.query.cursor as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 25;
    const data = await getCampaignEntries(req.user!.id, req.user!.location_id ?? null, parseLoc(req), parseDrawId(req), cursor, limit);
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
