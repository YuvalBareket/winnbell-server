import { getPool } from '../../shared/db/db.js';

export interface ActivitySummary {
  receipts_today: number;
  revenue_today: number;
  entries_today: number;
  entries_this_month: number;
  monthly_cap: number | null;
}

export interface ActivityItem {
  ticket_id: number;
  location_name: string;
  transaction_amount: number | null;
  receipt_identifier_masked: string | null;
  entry_source: string;
  status: 'active' | 'under_review';
  quarantine_reason: string | null;
  created_at: string;
  entry_count: number;
}

export interface ActivityResult {
  summary: ActivitySummary;
  items: ActivityItem[];
  next_cursor: number | null;
}

function maskReceiptId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (id.length <= 4) return '***' + id;
  return id.slice(0, 3) + '...' + id.slice(-4);
}

export const getBusinessActivity = async (
  userId: number,
  jwtLocationId: number | null | undefined,
  filterLocationId?: number,
  dateRange: 'today' | '7d' | '30d' = 'today',
  cursor?: number,
  limit = 25,
): Promise<ActivityResult> => {
  const pool = getPool();

  let businessId: number;
  let scopedLocationId: number | null = null;

  if (jwtLocationId) {
    // Location manager — always scoped to their location only
    const locRes = await pool.query(
      'SELECT business_id FROM business_location WHERE id = $1',
      [jwtLocationId],
    );
    const row = locRes.rows[0];
    if (!row) throw new Error('Location not found');
    businessId = row.business_id;
    scopedLocationId = jwtLocationId;
  } else {
    const bizRes = await pool.query('SELECT id FROM business WHERE user_id = $1', [userId]);
    const row = bizRes.rows[0];
    if (!row) throw new Error('Business not found');
    businessId = row.id;
    if (filterLocationId) scopedLocationId = filterLocationId;
  }

  // ── Today's summary KPIs (always scoped to today regardless of date range filter) ──
  const summaryParams: unknown[] = [businessId];
  const summaryLocClause = scopedLocationId
    ? (summaryParams.push(scopedLocationId), ` AND t.location_id = $${summaryParams.length}`)
    : '';

  const summaryRes = await pool.query(`
    SELECT
      -- receipts = distinct receipt submissions (anchor only); code/free/promo each count as 1
      COUNT(*) FILTER (WHERE t.entry_source != 'receipt' OR t.receipt_identifier IS NOT NULL)
                                                                  AS receipts_today,
      -- revenue = only anchor rows to avoid double-counting multi-entry amounts
      COALESCE(SUM(t.transaction_amount) FILTER (
        WHERE t.entry_source != 'receipt' OR t.receipt_identifier IS NOT NULL
      ), 0)                                                        AS revenue_today,
      -- entries = every ticket row, including bonus entries from multi-entry receipts
      COUNT(*)                                                     AS entries_today
    FROM ticket t
    JOIN business_location bl ON bl.id = t.location_id
    WHERE bl.business_id = $1
      AND t.created_at >= CURRENT_DATE
      AND t.is_quarantined = FALSE
      ${summaryLocClause}
  `, summaryParams);

  // ── Monthly entries stats ──
  const monthlyRes = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE t.is_quarantined = FALSE) AS entries_this_month,
      COALESCE(b.entry_cap, ps.global_entry_cap) AS monthly_cap
    FROM business b
    LEFT JOIN platform_settings ps ON ps.id = 1
    LEFT JOIN ticket t ON t.business_id = b.id
      AND t.created_at >= date_trunc('month', NOW())
      ${scopedLocationId ? 'AND t.location_id = $2' : ''}
    WHERE b.id = $1
    GROUP BY b.entry_cap, ps.global_entry_cap
  `, scopedLocationId ? [businessId, scopedLocationId] : [businessId]);

  const summary: ActivitySummary = {
    receipts_today: Number(summaryRes.rows[0]?.receipts_today ?? 0),
    revenue_today: parseFloat(summaryRes.rows[0]?.revenue_today ?? '0'),
    entries_today: Number(summaryRes.rows[0]?.entries_today ?? 0),
    entries_this_month: Number(monthlyRes.rows[0]?.entries_this_month ?? 0),
    monthly_cap: monthlyRes.rows[0]?.monthly_cap != null ? Number(monthlyRes.rows[0].monthly_cap) : null,
  };

  // ── Activity feed with cursor-based pagination ──
  // Only show primary receipt tickets (receipt_identifier IS NOT NULL) to avoid
  // showing blank secondary rows from multi-entry submissions.
  // Non-receipt tickets (code/free/promo) always have receipt_identifier = NULL,
  // so we exclude only receipt-source secondaries.
  const feedParams: unknown[] = [businessId];
  const conditions: string[] = [
    'bl.business_id = $1',
    't.is_quarantined = FALSE',
  ];

  if (dateRange === 'today') {
    conditions.push("t.created_at >= CURRENT_DATE");
  } else if (dateRange === '7d') {
    conditions.push("t.created_at >= NOW() - INTERVAL '7 days'");
  } else {
    conditions.push("t.created_at >= NOW() - INTERVAL '30 days'");
  }

  if (scopedLocationId) {
    feedParams.push(scopedLocationId);
    conditions.push(`t.location_id = $${feedParams.length}`);
  }

  if (cursor) {
    feedParams.push(cursor);
    conditions.push(`t.id < $${feedParams.length}`);
  }

  const safeLimit = Math.min(Math.max(1, limit), 50);
  feedParams.push(safeLimit + 1); // fetch one extra to detect next page
  const limitParam = feedParams.length;

  const feedRes = await pool.query(`
    SELECT
      t.id                                      AS ticket_id,
      COALESCE(bl.name, bl.address)             AS location_name,
      t.transaction_amount,
      t.receipt_identifier,
      t.entry_source,
      t.is_quarantined,
      t.quarantine_reason,
      t.created_at,
      -- Count all tickets (anchor + bonus) for the same submission
      (
        SELECT COUNT(*)
        FROM ticket t2
        WHERE t2.activated_by_user_id = t.activated_by_user_id
          AND t2.business_id = t.business_id
          AND t2.draw_id = t.draw_id
          AND t2.activated_at = t.activated_at
          AND t2.entry_source = 'receipt'
      )                                         AS entry_count
    FROM ticket t
    JOIN business_location bl ON bl.id = t.location_id
    WHERE ${conditions.join(' AND ')}
      AND (t.entry_source != 'receipt' OR t.receipt_identifier IS NOT NULL)
    ORDER BY t.id DESC
    LIMIT $${limitParam}
  `, feedParams);

  const rows = feedRes.rows;
  const hasMore = rows.length > safeLimit;
  if (hasMore) rows.pop();

  const items: ActivityItem[] = rows.map(r => ({
    ticket_id: Number(r.ticket_id),
    location_name: String(r.location_name),
    transaction_amount: r.transaction_amount != null ? parseFloat(r.transaction_amount) : null,
    receipt_identifier_masked: maskReceiptId(r.receipt_identifier),
    entry_source: r.entry_source ?? 'receipt',
    status: r.is_quarantined ? 'under_review' : 'active',
    quarantine_reason: r.quarantine_reason ?? null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    entry_count: Number(r.entry_count ?? 1),
  }));

  return {
    summary,
    items,
    next_cursor: hasMore ? items[items.length - 1].ticket_id : null,
  };
};

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
