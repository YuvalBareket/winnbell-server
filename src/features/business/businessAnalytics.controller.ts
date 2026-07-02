import { Response } from 'express';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import {
  getOverviewAnalytics,
  getAcquisitionAnalytics,
  getEngagementAnalytics,
  getRevenueAnalytics,
  type AnalyticsCategory,
  type AnalyticsParams,
} from './businessAnalytics.service.js';

const HANDLERS: Record<AnalyticsCategory, (
  userId: number, jwt: number | null, filter: number | undefined, p: AnalyticsParams,
) => Promise<unknown>> = {
  overview: getOverviewAnalytics,
  acquisition: getAcquisitionAnalytics,
  engagement: getEngagementAnalytics,
  revenue: getRevenueAnalytics,
};

// GET /business/analytics/:category?locationId=&from=&to=&bucket=day|month  (Business owner or manager)
// Only the active tab's section is fetched — the page never loads all four categories at once.
export const getBusinessAnalytics = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const category = req.params.category as AnalyticsCategory;
    const handler = HANDLERS[category];
    if (!handler) { res.status(400).json({ message: 'Unknown analytics category' }); return; }

    const userId = req.user!.id;
    const jwtLocationId = req.user!.location_id ?? null;

    const rawLoc = req.query.locationId;
    let filterLocationId: number | undefined;
    if (rawLoc != null && rawLoc !== 'all' && rawLoc !== '') {
      const lid = Number(rawLoc);
      if (!Number.isInteger(lid) || lid < 1) { res.status(400).json({ message: 'Invalid locationId' }); return; }
      filterLocationId = lid;
    }

    const now = Date.now();
    const parseDate = (v: unknown, fb: number): string => {
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      return new Date(Number.isNaN(t) ? fb : t).toISOString();
    };
    const from = parseDate(req.query.from, now - 30 * 864e5);
    const to = parseDate(req.query.to, now + 864e5);
    if (Date.parse(from) >= Date.parse(to)) { res.status(400).json({ message: 'from must be before to' }); return; }
    // Cap the window so a caller can't drive a multi-decade ticket-table scan (pool exhaustion).
    if (Date.parse(to) - Date.parse(from) > 366 * 864e5) { res.status(400).json({ message: 'Date range too large (max 366 days)' }); return; }
    const bucket = req.query.bucket === 'month' ? 'month' : 'day';

    const data = await handler(userId, jwtLocationId, filterLocationId, { from, to, bucket });
    res.json(data);
  } catch (err) {
    console.error('[business.getBusinessAnalytics]', err instanceof Error ? err.message : err);
    res.status(500).json({ message: 'Failed to fetch analytics' });
  }
};
