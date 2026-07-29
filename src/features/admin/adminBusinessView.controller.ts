import { Request, Response } from 'express';
import { getPool } from '../../shared/db/db.js';
import {
  listBusinessCampaignsForScope,
  getCampaignHeaderForScope,
  getCampaignKpisForScope,
  getCampaignEntriesForScope,
  type DateRange,
} from '../business/activity.service.js';
import {
  getOverviewAnalyticsForScope,
  getAcquisitionAnalyticsForScope,
  getEngagementAnalyticsForScope,
  getRevenueAnalyticsForScope,
  type AnalyticsCategory,
  type AnalyticsParams,
} from '../business/businessAnalytics.service.js';

// Validate that businessId exists in the DB and return it, or null if not found.
async function resolveAdminBusinessId(rawId: string | string[]): Promise<number | null> {
  const str = Array.isArray(rawId) ? rawId[0] : rawId;
  const id = parseInt(str, 10);
  if (isNaN(id) || id < 1) return null;
  const pool = getPool();
  const res = await pool.query('SELECT id FROM business WHERE id = $1', [id]);
  return res.rows[0] ? id : null;
}

// Validate that locationId belongs to businessId. Returns the locationId when valid,
// null when the location is absent or foreign (silent fallback: all-locations scope).
async function resolveAdminLocationId(
  businessId: number,
  rawLocId: string | undefined,
): Promise<number | null> {
  if (rawLocId == null || rawLocId === '' || rawLocId === 'all') return null;
  const locId = parseInt(rawLocId, 10);
  if (isNaN(locId) || locId < 1) return null;
  const pool = getPool();
  const res = await pool.query(
    'SELECT 1 FROM business_location WHERE id = $1 AND business_id = $2',
    [locId, businessId],
  );
  return res.rows.length > 0 ? locId : null;
}

// GET /admin/businesses/:businessId/campaign/list
export const adminGetCampaignList = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = await resolveAdminBusinessId(req.params.businessId);
    if (businessId == null) { res.status(404).json({ message: 'Business not found' }); return; }
    const data = await listBusinessCampaignsForScope(businessId);
    res.json(data);
  } catch (error: unknown) {
    console.error('[admin.adminGetCampaignList]', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ message: 'Failed to load campaign list' });
  }
};

// GET /admin/businesses/:businessId/campaign/header?location_id=&draw_id=
export const adminGetCampaignHeader = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = await resolveAdminBusinessId(req.params.businessId);
    if (businessId == null) { res.status(404).json({ message: 'Business not found' }); return; }
    const rawLoc = typeof req.query.location_id === 'string' ? req.query.location_id : undefined;
    const scopedLocationId = await resolveAdminLocationId(businessId, rawLoc);
    const rawDrawId = typeof req.query.draw_id === 'string' ? req.query.draw_id : undefined;
    const drawId = rawDrawId ? parseInt(rawDrawId, 10) : undefined;
    const data = await getCampaignHeaderForScope(businessId, scopedLocationId, drawId != null && !isNaN(drawId) ? drawId : undefined);
    res.json(data);
  } catch (error: unknown) {
    console.error('[admin.adminGetCampaignHeader]', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ message: 'Failed to load campaign header' });
  }
};

const parseRange = (raw: unknown): DateRange => {
  const r = String(raw);
  return (r === 'wtd' || r === 'mtd' || r === '7d' || r === '30d') ? r : 'today';
};

// GET /admin/businesses/:businessId/campaign/kpis?date_range=&location_id=&draw_id=
export const adminGetCampaignKpis = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = await resolveAdminBusinessId(req.params.businessId);
    if (businessId == null) { res.status(404).json({ message: 'Business not found' }); return; }
    const rawLoc = typeof req.query.location_id === 'string' ? req.query.location_id : undefined;
    const scopedLocationId = await resolveAdminLocationId(businessId, rawLoc);
    const rawDrawId = typeof req.query.draw_id === 'string' ? req.query.draw_id : undefined;
    const drawId = rawDrawId ? parseInt(rawDrawId, 10) : undefined;
    const data = await getCampaignKpisForScope(
      businessId,
      scopedLocationId,
      parseRange(req.query.date_range),
      drawId != null && !isNaN(drawId) ? drawId : undefined,
    );
    res.json(data);
  } catch (error: unknown) {
    console.error('[admin.adminGetCampaignKpis]', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ message: 'Failed to load campaign KPIs' });
  }
};

// GET /admin/businesses/:businessId/campaign/entries?cursor=&location_id=&draw_id=&range=&limit=
export const adminGetCampaignEntries = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = await resolveAdminBusinessId(req.params.businessId);
    if (businessId == null) { res.status(404).json({ message: 'Business not found' }); return; }
    const rawLoc = typeof req.query.location_id === 'string' ? req.query.location_id : undefined;
    const scopedLocationId = await resolveAdminLocationId(businessId, rawLoc);
    const rawDrawId = typeof req.query.draw_id === 'string' ? req.query.draw_id : undefined;
    const drawId = rawDrawId ? parseInt(rawDrawId, 10) : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const rawLimit = typeof req.query.limit === 'string' ? req.query.limit : undefined;
    const parsedLimit = rawLimit ? parseInt(rawLimit, 10) : NaN;
    // NaN would sail through the service's Math.min/max clamp (NaN propagates) into the SQL LIMIT.
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 25;
    const rawRange = typeof req.query.range === 'string' ? req.query.range : undefined;
    const range: DateRange | undefined = (rawRange === 'today' || rawRange === 'wtd' || rawRange === 'mtd') ? rawRange : undefined;
    const data = await getCampaignEntriesForScope(
      businessId,
      scopedLocationId,
      drawId != null && !isNaN(drawId) ? drawId : undefined,
      cursor,
      limit,
      range,
    );
    res.json(data);
  } catch (error: unknown) {
    console.error('[admin.adminGetCampaignEntries]', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ message: 'Failed to load campaign entries' });
  }
};

const ANALYTICS_HANDLERS: Record<AnalyticsCategory, (
  businessId: number, loc: number | null, p: AnalyticsParams,
) => Promise<unknown>> = {
  overview: getOverviewAnalyticsForScope,
  acquisition: getAcquisitionAnalyticsForScope,
  engagement: getEngagementAnalyticsForScope,
  revenue: getRevenueAnalyticsForScope,
};

// GET /admin/businesses/:businessId/analytics/:category?locationId=&from=&to=&bucket=
export const adminGetBusinessAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = await resolveAdminBusinessId(req.params.businessId);
    if (businessId == null) { res.status(404).json({ message: 'Business not found' }); return; }

    // Own-property check: a plain [] lookup with a URL-controlled key would also match
    // inherited Object.prototype members ('constructor', 'hasOwnProperty', ...) and call them.
    const category = req.params.category as AnalyticsCategory;
    const handler = Object.prototype.hasOwnProperty.call(ANALYTICS_HANDLERS, category)
      ? ANALYTICS_HANDLERS[category]
      : undefined;
    if (!handler) { res.status(400).json({ message: 'Unknown analytics category' }); return; }

    const rawLocId = typeof req.query.locationId === 'string' ? req.query.locationId : undefined;
    const scopedLocationId = await resolveAdminLocationId(businessId, rawLocId);

    const now = Date.now();
    const parseDate = (v: unknown, fb: number): string => {
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      return new Date(Number.isNaN(t) ? fb : t).toISOString();
    };
    const from = parseDate(req.query.from, now - 30 * 864e5);
    const to = parseDate(req.query.to, now + 864e5);
    if (Date.parse(from) >= Date.parse(to)) { res.status(400).json({ message: 'from must be before to' }); return; }
    if (Date.parse(to) - Date.parse(from) > 366 * 864e5) { res.status(400).json({ message: 'Date range too large (max 366 days)' }); return; }
    const bucket = req.query.bucket === 'month' ? 'month' : 'day';

    const data = await handler(businessId, scopedLocationId, { from, to, bucket });
    res.json(data);
  } catch (error: unknown) {
    console.error('[admin.adminGetBusinessAnalytics]', error instanceof Error ? error.message : 'Unknown error');
    res.status(500).json({ message: 'Failed to fetch analytics' });
  }
};
