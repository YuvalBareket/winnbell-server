import { getPool } from '../../shared/db/db.js';

export interface ActivitySummary {
  receipts_period: number;
  revenue_period: number;
  entries_period: number;
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
    if (!row) {
      return {
        summary: { receipts_period: 0, revenue_period: 0, entries_period: 0, monthly_cap: null },
        items: [],
        next_cursor: null,
      };
    }
    businessId = row.id;
    if (filterLocationId) scopedLocationId = filterLocationId;
  }

  // ── Period summary KPIs (follows date_range filter) ──
  const summaryParams: unknown[] = [businessId];
  const summaryLocClause = scopedLocationId
    ? (summaryParams.push(scopedLocationId), ` AND t.location_id = $${summaryParams.length}`)
    : '';

  let periodClause: string;
  if (dateRange === 'today') {
    periodClause = 'AND t.created_at >= CURRENT_DATE';
  } else if (dateRange === '7d') {
    periodClause = "AND t.created_at >= NOW() - INTERVAL '7 days'";
  } else {
    periodClause = "AND t.created_at >= NOW() - INTERVAL '30 days'";
  }

  const summaryRes = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE t.entry_source != 'receipt' OR t.receipt_identifier IS NOT NULL)
                                                                  AS receipts_period,
      COALESCE(SUM(t.transaction_amount) FILTER (
        WHERE t.entry_source != 'receipt' OR t.receipt_identifier IS NOT NULL
      ), 0)                                                        AS revenue_period,
      COUNT(*)                                                     AS entries_period
    FROM ticket t
    WHERE t.business_id = $1
      ${periodClause}
      AND t.is_quarantined = FALSE
      ${summaryLocClause}
  `, summaryParams);

  // ── Monthly cap ──
  const capRes = await pool.query(`
    SELECT COALESCE(s.entries_per_location, ps.global_entry_cap) AS monthly_cap
    FROM business b
    LEFT JOIN subscription s ON s.business_id = b.id
    LEFT JOIN platform_settings ps ON ps.id = 1
    WHERE b.id = $1
  `, [businessId]);

  const summary: ActivitySummary = {
    receipts_period: Number(summaryRes.rows[0]?.receipts_period ?? 0),
    revenue_period: parseFloat(summaryRes.rows[0]?.revenue_period ?? '0'),
    entries_period: Number(summaryRes.rows[0]?.entries_period ?? 0),
    monthly_cap: capRes.rows[0]?.monthly_cap != null ? Number(capRes.rows[0].monthly_cap) : null,
  };

  // ── Activity feed with cursor-based pagination ──
  // Only show primary receipt tickets (receipt_identifier IS NOT NULL) to avoid
  // showing blank secondary rows from multi-entry submissions.
  // Non-receipt tickets (code/free/promo) always have receipt_identifier = NULL,
  // so we exclude only receipt-source secondaries.
  const feedParams: unknown[] = [businessId];
  const conditions: string[] = [
    // Filter on the ticket's own business_id (indexed) rather than through the
    // business_location join — the join is kept only to resolve the location name.
    't.business_id = $1',
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
      t.created_at
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
