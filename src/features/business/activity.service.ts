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
  reviewable: boolean;        // true only for business_review quarantines the business can approve
  created_at: string;
}

export interface CampaignEntriesResult {
  items: CampaignEntry[];
  next_cursor: number | null;
}

// Campaign Dashboard header (current-campaign monitoring, NOT period-scoped).
export interface CampaignHeader {
  has_campaign: boolean;
  campaign_name: string | null;
  prize_amount: number | null;
  draw_date: string | null;
  days_remaining: number | null;
  entries_used: number;        // campaign-total, quarantined excluded, respecting scope
  entry_cap: number | null;
  cap_reached: boolean;
  needs_review_count: number;  // actionable (business_review) under-review entries in this campaign
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
async function resolveScope(
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
  return { businessId: row.id, scopedLocationId: filterLocationId ?? null };
}

/**
 * Business owner or location manager manually disqualifies (or restores) a receipt entry.
 *
 * Rules:
 *  - disqualify=true  → quarantine with reason 'business_review' (frees cap slot)
 *  - disqualify=false → only clears quarantine if reason is 'business_review';
 *                       system/admin quarantines are left untouched
 *  - Ownership: business owner matches via business_id; manager matches via location_id
 */
export const setTicketQualification = async (
  ticketId: number,
  userId: number,
  jwtLocationId: number | null | undefined,
  disqualify: boolean,
): Promise<void> => {
  const pool = getPool();

  // Verify the caller owns this ticket (owner via business, manager via location)
  const authRes = await pool.query(
    `SELECT t.id, t.quarantine_reason
     FROM ticket t
     JOIN business_location bl ON bl.id = t.location_id
     JOIN business b ON b.id = bl.business_id
     WHERE t.id = $1
       AND (
         b.user_id = $2
         OR (bl.manager_user_id = $2 AND ($3::int IS NULL OR bl.id = $3))
       )`,
    [ticketId, userId, jwtLocationId ?? null],
  );

  if (authRes.rows.length === 0) {
    throw Object.assign(new Error('Ticket not found or access denied'), { status: 403 });
  }

  const { quarantine_reason } = authRes.rows[0];

  // Apply to all tickets from the same submission (primary + all secondary multi-entry rows).
  // They share the same activated_by_user_id, business_id, draw_id, and activated_at.
  const groupClause = `
    WHERE activated_by_user_id = (SELECT activated_by_user_id FROM ticket WHERE id = $1)
      AND business_id           = (SELECT business_id           FROM ticket WHERE id = $1)
      AND draw_id               = (SELECT draw_id               FROM ticket WHERE id = $1)
      AND activated_at          = (SELECT activated_at          FROM ticket WHERE id = $1)
      AND entry_source = 'receipt'
  `;

  if (disqualify) {
    await pool.query(
      `UPDATE ticket SET is_quarantined = TRUE, quarantine_reason = 'business_review', quarantined_at = NOW()
       ${groupClause}`,
      [ticketId],
    );
  } else {
    // Only restore tickets the business itself disqualified — never override system/admin quarantines
    if (quarantine_reason !== 'business_review') {
      throw Object.assign(new Error('This entry was flagged by the system and cannot be restored here.'), { status: 400 });
    }
    await pool.query(
      `UPDATE ticket SET is_quarantined = FALSE, quarantine_reason = NULL, quarantined_at = NULL
       ${groupClause} AND quarantine_reason = 'business_review'`,
      [ticketId],
    );
  }
};

// ── Campaign Dashboard: monitoring header (NOT period-scoped) ──────────────────
export const getCampaignHeader = async (
  userId: number,
  jwtLocationId: number | null | undefined,
  filterLocationId?: number,
): Promise<CampaignHeader> => {
  const pool = getPool();
  const empty: CampaignHeader = {
    has_campaign: false, campaign_name: null, prize_amount: null, draw_date: null,
    days_remaining: null, entries_used: 0, entry_cap: null, cap_reached: false, needs_review_count: 0,
  };
  const { businessId, scopedLocationId } = await resolveScope(userId, jwtLocationId, filterLocationId);
  if (businessId == null) return empty;

  // Current campaign = the Open draw this business is enrolled in.
  const drawRes = await pool.query(
    `SELECT d.id, d.name, d.prize_pool, d.draw_date
     FROM draw d JOIN draw_entry de ON de.draw_id = d.id AND de.business_id = $1
     WHERE d.status = 'Open' ORDER BY d.draw_date ASC LIMIT 1`,
    [businessId],
  );
  const draw = drawRes.rows[0];
  if (!draw) return empty;

  const usedParams: unknown[] = [businessId, draw.id];
  const usedLoc = scopedLocationId ? (usedParams.push(scopedLocationId), ` AND location_id = $${usedParams.length}`) : '';
  const usedRes = await pool.query(
    `SELECT COUNT(*)::int AS used FROM ticket
     WHERE business_id = $1 AND draw_id = $2 AND is_quarantined = FALSE ${usedLoc}`,
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

  const nrParams: unknown[] = [businessId, draw.id];
  const nrLoc = scopedLocationId ? (nrParams.push(scopedLocationId), ` AND location_id = $${nrParams.length}`) : '';
  const nrRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ticket
     WHERE business_id = $1 AND draw_id = $2 AND is_quarantined = TRUE AND quarantine_reason = 'business_review' ${nrLoc}`,
    nrParams,
  );

  const used = Number(usedRes.rows[0]?.used ?? 0);
  const drawDate = draw.draw_date instanceof Date ? draw.draw_date : new Date(draw.draw_date);
  const daysRemaining = Math.max(0, Math.ceil((drawDate.getTime() - Date.now()) / 86400000));

  return {
    has_campaign: true,
    campaign_name: draw.name,
    prize_amount: Number(draw.prize_pool),
    draw_date: drawDate.toISOString(),
    days_remaining: daysRemaining,
    entries_used: used,
    entry_cap: entryCap,
    cap_reached: entryCap != null && used >= entryCap,
    needs_review_count: Number(nrRes.rows[0]?.n ?? 0),
  };
};

// ── Campaign Dashboard: light KPIs (period-scoped: today / wtd / mtd) ──────────
export const getCampaignKpis = async (
  userId: number,
  jwtLocationId: number | null | undefined,
  filterLocationId: number | undefined,
  dateRange: DateRange = 'today',
): Promise<CampaignKpis> => {
  const pool = getPool();
  const { businessId, scopedLocationId } = await resolveScope(userId, jwtLocationId, filterLocationId);
  if (businessId == null) return { entries: 0, revenue: 0, customers: 0 };

  const params: unknown[] = [businessId];
  const locClause = scopedLocationId ? (params.push(scopedLocationId), ` AND t.location_id = $${params.length}`) : '';
  const res = await pool.query(
    `SELECT COUNT(*) AS entries,
            COALESCE(SUM(t.transaction_amount), 0) AS revenue,
            COUNT(DISTINCT t.activated_by_user_id) AS customers
     FROM ticket t
     WHERE t.business_id = $1 AND ${periodPredicate(dateRange)} AND t.is_quarantined = FALSE ${locClause}`,
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
  needsReviewOnly = false,
  cursor?: number,
  limit = 25,
): Promise<CampaignEntriesResult> => {
  const pool = getPool();
  const { businessId, scopedLocationId } = await resolveScope(userId, jwtLocationId, filterLocationId);
  if (businessId == null) return { items: [], next_cursor: null };

  const drawRes = await pool.query(
    `SELECT d.id FROM draw d JOIN draw_entry de ON de.draw_id = d.id AND de.business_id = $1
     WHERE d.status = 'Open' ORDER BY d.draw_date ASC LIMIT 1`,
    [businessId],
  );
  const drawId = drawRes.rows[0]?.id;
  if (!drawId) return { items: [], next_cursor: null };

  const params: unknown[] = [businessId, drawId];
  const conditions: string[] = ['t.business_id = $1', 't.draw_id = $2'];
  if (scopedLocationId) { params.push(scopedLocationId); conditions.push(`t.location_id = $${params.length}`); }
  if (needsReviewOnly) conditions.push(`t.is_quarantined = TRUE AND t.quarantine_reason = 'business_review'`);
  if (cursor) { params.push(cursor); conditions.push(`t.id < $${params.length}`); }
  const safeLimit = Math.min(Math.max(1, limit), 50);
  params.push(safeLimit + 1);

  const res = await pool.query(
    `SELECT t.id AS ticket_id, COALESCE(bl.name, bl.address) AS location_name,
            u.full_name AS customer_name, t.transaction_amount, t.entry_source,
            t.is_quarantined, t.quarantine_reason, t.created_at
     FROM ticket t
     JOIN business_location bl ON bl.id = t.location_id
     LEFT JOIN "user" u ON u.id = t.activated_by_user_id
     WHERE ${conditions.join(' AND ')}
       AND (t.entry_source != 'receipt' OR t.receipt_identifier IS NOT NULL)
     ORDER BY t.id DESC LIMIT $${params.length}`,
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
    reviewable: r.is_quarantined === true && r.quarantine_reason === 'business_review',
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
  return { items, next_cursor: hasMore ? items[items.length - 1].ticket_id : null };
};
