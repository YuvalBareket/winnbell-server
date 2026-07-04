import { getPool } from '../../shared/db/db.js';

export type DateRange = 'today' | 'wtd' | 'mtd' | '7d' | '30d';

// ── Campaign Dashboard payloads (period KPIs + campaign-scoped feed) ──
export interface CampaignKpis {
  entries: number;
  revenue: number;
  customers: number;
}

export interface CampaignEntry {
  ticket_id: number;
  location_name: string;
  customer_masked: string;
  transaction_amount: number | null;
  entry_source: string;
  status: 'active' | 'under_review';
  created_at: string;
}

export interface CampaignEntriesResult {
  items: CampaignEntry[];
  next_cursor: string | null;
}

export interface CampaignListItem {
  draw_id: number;
  name: string;
  prize_amount: number;
  draw_date: string;
  status: string;      // 'Open' | 'Closed' | 'Upcoming'
  is_current: boolean; // status === 'Open'
}

// Campaign Dashboard header (current-campaign monitoring, NOT period-scoped).
export interface CampaignHeader {
  has_campaign: boolean;
  status: string;
  campaign_name: string | null;
  prize_amount: number | null;
  draw_date: string | null;
  days_remaining: number | null;
  entries_used: number;        // campaign-total, quarantined excluded, respecting scope
  entry_cap: number | null;
  cap_reached: boolean;
}

// Customer display for the business feed: first name + last initial (e.g. "Jane D."). Never the
// full name/email, so it stays privacy-light while still being human to the business.
function maskCustomer(fullName: string | null | undefined): string {
  const name = (fullName ?? '').trim();
  if (!name) return 'Customer';
  const parts = name.split(/\s+/);
  const first = parts[0];
  if (parts.length === 1) return first;
  return `${first} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

// created_at period predicate. WTD/MTD use calendar boundaries (week starts Monday in PG),
// which is NOT the same as "last 7/30 days" — important so month-end numbers aren't misleading.
function periodPredicate(range: DateRange): string {
  switch (range) {
    case '7d':  return "t.created_at >= NOW() - INTERVAL '7 days'";
    case '30d': return "t.created_at >= NOW() - INTERVAL '30 days'";
    case 'wtd': return "t.created_at >= date_trunc('week', CURRENT_DATE)";
    case 'mtd': return "t.created_at >= date_trunc('month', CURRENT_DATE)";
    default:    return 't.created_at >= CURRENT_DATE'; // today
  }
}

// Resolve the caller's business + the location they are scoped to. Managers (jwtLocationId set)
// are always locked to their own location; owners see all unless they pass a location filter.
export async function resolveScope(
  userId: number,
  jwtLocationId: number | null | undefined,
  filterLocationId?: number,
): Promise<{ businessId: number | null; scopedLocationId: number | null }> {
  const pool = getPool();
  if (jwtLocationId) {
    const locRes = await pool.query('SELECT business_id FROM business_location WHERE id = $1', [jwtLocationId]);
    const row = locRes.rows[0];
    if (!row) throw new Error('Location not found');
    return { businessId: row.business_id, scopedLocationId: jwtLocationId };
  }
  const bizRes = await pool.query('SELECT id FROM business WHERE user_id = $1', [userId]);
  const row = bizRes.rows[0];
  if (!row) return { businessId: null, scopedLocationId: null };
  // An owner-supplied location filter must belong to THIS business; a foreign/stale id is ignored
  // (fall back to all-locations) so it can't skew the cap display. No data leak either way, since
  // every downstream query also filters on business_id.
  let scopedLocationId: number | null = null;
  if (filterLocationId != null) {
    const owns = await pool.query(
      'SELECT 1 FROM business_location WHERE id = $1 AND business_id = $2',
      [filterLocationId, row.id],
    );
    if (owns.rows.length > 0) scopedLocationId = filterLocationId;
  }
  return { businessId: row.id, scopedLocationId };
}

export const listBusinessCampaigns = async (
  userId: number,
  jwtLocationId: number | null | undefined,
): Promise<CampaignListItem[]> => {
  const pool = getPool();
  const { businessId } = await resolveScope(userId, jwtLocationId);
  if (businessId == null) return [];
  const res = await pool.query(
    `SELECT DISTINCT d.id AS draw_id, d.name, d.prize_pool, d.draw_date, d.status
     FROM draw d JOIN draw_entry de ON de.draw_id = d.id AND de.business_id = $1
     ORDER BY d.draw_date DESC
     LIMIT 60`,
    [businessId],
  );
  return res.rows.map((r) => ({
    draw_id: r.draw_id,
    name: r.name,
    prize_amount: Number(r.prize_pool),
    draw_date: (r.draw_date instanceof Date ? r.draw_date : new Date(r.draw_date)).toISOString(),
    status: r.status,
    is_current: r.status === 'Open',
  }));
};

// ── Campaign Dashboard: monitoring header (NOT period-scoped) ──────────────────
export const getCampaignHeader = async (
  userId: number,
  jwtLocationId: number | null | undefined,
  filterLocationId?: number,
  drawId?: number,
): Promise<CampaignHeader> => {
  const pool = getPool();
  const empty: CampaignHeader = {
    has_campaign: false, status: 'Closed', campaign_name: null, prize_amount: null, draw_date: null,
    days_remaining: null, entries_used: 0, entry_cap: null, cap_reached: false,
  };
  const { businessId, scopedLocationId } = await resolveScope(userId, jwtLocationId, filterLocationId);
  if (businessId == null) return empty;

  // Resolve the target draw: specific draw if drawId given, else the Open draw.
  let drawRes;
  if (drawId != null) {
    drawRes = await pool.query(
      `SELECT d.id, d.name, d.prize_pool, d.draw_date, d.status
       FROM draw d JOIN draw_entry de ON de.draw_id = d.id AND de.business_id = $1
       WHERE d.id = $2 LIMIT 1`,
      [businessId, drawId],
    );
  } else {
    drawRes = await pool.query(
      `SELECT d.id, d.name, d.prize_pool, d.draw_date, d.status
       FROM draw d JOIN draw_entry de ON de.draw_id = d.id AND de.business_id = $1
       WHERE d.status = 'Open' ORDER BY d.draw_date ASC LIMIT 1`,
      [businessId],
    );
  }
  const draw = drawRes.rows[0];
  if (!draw) return empty;

  const usedParams: unknown[] = [businessId, draw.id];
  const usedLoc = scopedLocationId ? (usedParams.push(scopedLocationId), ` AND location_id = $${usedParams.length}`) : '';
  const usedRes = await pool.query(
    `SELECT COUNT(*)::int AS used FROM ticket
     WHERE business_id = $1 AND draw_id = $2 AND is_quarantined = FALSE
       AND activated_by_user_id IS NOT NULL ${usedLoc}`,
    usedParams,
  );

  const capRes = await pool.query(
    `SELECT COALESCE(s.entries_per_location, ps.global_entry_cap) AS per_loc,
            (SELECT COUNT(*) FROM business_location WHERE business_id = $1 AND is_active = TRUE) AS loc_count
     FROM business b
     LEFT JOIN subscription s ON s.business_id = b.id
     LEFT JOIN platform_settings ps ON ps.id = 1
     WHERE b.id = $1`,
    [businessId],
  );
  const perLoc = capRes.rows[0]?.per_loc != null ? Number(capRes.rows[0].per_loc) : null;
  const locCount = Number(capRes.rows[0]?.loc_count ?? 0);
  const entryCap = perLoc != null ? perLoc * (scopedLocationId ? 1 : Math.max(locCount, 1)) : null;

  const used = Number(usedRes.rows[0]?.used ?? 0);
  const drawDate = draw.draw_date instanceof Date ? draw.draw_date : new Date(draw.draw_date);
  const daysRemaining = draw.status === 'Open'
    ? Math.max(0, Math.ceil((drawDate.getTime() - Date.now()) / 86400000))
    : null;

  return {
    has_campaign: true,
    status: draw.status,
    campaign_name: draw.name,
    prize_amount: Number(draw.prize_pool),
    draw_date: drawDate.toISOString(),
    days_remaining: daysRemaining,
    entries_used: used,
    entry_cap: entryCap,
    cap_reached: entryCap != null && used >= entryCap,
  };
};

// ── Campaign Dashboard: light KPIs (period-scoped: today / wtd / mtd) ──────────
export const getCampaignKpis = async (
  userId: number,
  jwtLocationId: number | null | undefined,
  filterLocationId: number | undefined,
  dateRange: DateRange = 'today',
  drawId?: number,
): Promise<CampaignKpis> => {
  const pool = getPool();
  const { businessId, scopedLocationId } = await resolveScope(userId, jwtLocationId, filterLocationId);
  if (businessId == null) return { entries: 0, revenue: 0, customers: 0 };

  if (drawId != null) {
    const pDraw: unknown[] = [businessId, drawId];
    const drawLocClause = scopedLocationId ? (pDraw.push(scopedLocationId), ` AND t.location_id = $${pDraw.length}`) : '';
    const res = await pool.query(
      `SELECT COUNT(*) AS entries, COALESCE(SUM(t.transaction_amount),0) AS revenue, COUNT(DISTINCT t.activated_by_user_id) AS customers
       FROM ticket t WHERE t.business_id = $1 AND t.draw_id = $2 AND t.is_quarantined = FALSE
         AND t.activated_by_user_id IS NOT NULL ${drawLocClause}`,
      pDraw,
    );
    return {
      entries: Number(res.rows[0]?.entries ?? 0),
      revenue: parseFloat(res.rows[0]?.revenue ?? '0'),
      customers: Number(res.rows[0]?.customers ?? 0),
    };
  }

  const params: unknown[] = [businessId];
  const locClause = scopedLocationId ? (params.push(scopedLocationId), ` AND t.location_id = $${params.length}`) : '';
  const res = await pool.query(
    `SELECT COUNT(*) AS entries,
            COALESCE(SUM(t.transaction_amount), 0) AS revenue,
            COUNT(DISTINCT t.activated_by_user_id) AS customers
     FROM ticket t
     WHERE t.business_id = $1 AND ${periodPredicate(dateRange)} AND t.is_quarantined = FALSE
       AND t.activated_by_user_id IS NOT NULL ${locClause}`,
    params,
  );
  return {
    entries: Number(res.rows[0]?.entries ?? 0),
    revenue: parseFloat(res.rows[0]?.revenue ?? '0'),
    customers: Number(res.rows[0]?.customers ?? 0),
  };
};

// ── Campaign Dashboard: entries feed (current-campaign scoped, NOT date-scoped) ─
export const getCampaignEntries = async (
  userId: number,
  jwtLocationId: number | null | undefined,
  filterLocationId: number | undefined,
  drawId?: number,
  cursor?: string,
  limit = 25,
): Promise<CampaignEntriesResult> => {
  const pool = getPool();
  const { businessId, scopedLocationId } = await resolveScope(userId, jwtLocationId, filterLocationId);
  if (businessId == null) return { items: [], next_cursor: null };

  let resolvedDrawId: number | undefined;
  if (drawId != null) {
    const drawRes = await pool.query(
      `SELECT d.id FROM draw d JOIN draw_entry de ON de.draw_id = d.id AND de.business_id = $1
       WHERE d.id = $2 LIMIT 1`,
      [businessId, drawId],
    );
    resolvedDrawId = drawRes.rows[0]?.id;
  } else {
    const drawRes = await pool.query(
      `SELECT d.id FROM draw d JOIN draw_entry de ON de.draw_id = d.id AND de.business_id = $1
       WHERE d.status = 'Open' ORDER BY d.draw_date ASC LIMIT 1`,
      [businessId],
    );
    resolvedDrawId = drawRes.rows[0]?.id;
  }
  if (!resolvedDrawId) return { items: [], next_cursor: null };

  const params: unknown[] = [businessId, resolvedDrawId];
  const conditions: string[] = ['t.business_id = $1', 't.draw_id = $2'];
  if (scopedLocationId) { params.push(scopedLocationId); conditions.push(`t.location_id = $${params.length}`); }
  // Keyset on (created_at, id): the feed is ordered by date, and id only breaks ties, so paging
  // follows the exact same order. Cursor format is "<created_at ISO>|<id>".
  if (cursor) {
    const sep = cursor.lastIndexOf('|');
    if (sep > 0) {
      params.push(cursor.slice(0, sep)); const tsIdx = params.length;
      params.push(parseInt(cursor.slice(sep + 1), 10)); const idIdx = params.length;
      conditions.push(`(t.created_at, t.id) < ($${tsIdx}::timestamp, $${idIdx}::int)`);
    }
  }
  const safeLimit = Math.min(Math.max(1, limit), 50);
  params.push(safeLimit + 1);

  const res = await pool.query(
    `SELECT t.id AS ticket_id, COALESCE(bl.name, bl.address) AS location_name,
            u.full_name AS customer_name, t.transaction_amount, t.entry_source,
            t.is_quarantined, t.created_at
     FROM ticket t
     JOIN business_location bl ON bl.id = t.location_id
     LEFT JOIN "user" u ON u.id = t.activated_by_user_id
     WHERE ${conditions.join(' AND ')}
       AND (t.entry_source != 'receipt' OR t.receipt_identifier IS NOT NULL)
     ORDER BY t.created_at DESC, t.id DESC LIMIT $${params.length}`,
    params,
  );

  const rows = res.rows;
  const hasMore = rows.length > safeLimit;
  if (hasMore) rows.pop();
  const items: CampaignEntry[] = rows.map(r => ({
    ticket_id: Number(r.ticket_id),
    location_name: String(r.location_name),
    customer_masked: maskCustomer(r.customer_name),
    transaction_amount: r.transaction_amount != null ? parseFloat(r.transaction_amount) : null,
    entry_source: r.entry_source ?? 'receipt',
    status: r.is_quarantined ? 'under_review' : 'active',
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
  const last = items[items.length - 1];
  return { items, next_cursor: hasMore && last ? `${last.created_at}|${last.ticket_id}` : null };
};
