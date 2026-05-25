import { getPool } from '../../shared/db/db.js';
import { decayAllUserRiskScores } from '../risk/risk.service.js';

export const getBusinessesWithStats = async (params: {
  page: number;
  limit: number;
  search?: string;
}) => {
  const pool = getPool();
  const { page, limit, search } = params;
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (search) {
    conditions.push(`(b.name ILIKE $${idx} OR u.full_name ILIKE $${idx} OR u.email ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rowsRes, countRes] = await Promise.all([
    pool.query(`
      SELECT
        b.id,
        b.name,
        b.sector,
        b.entry_cap,
        b.is_subscribed,
        u.full_name AS owner_name,
        u.email AS owner_email,
        s.status AS subscription_status,
        s.current_period_end,
        s.fee_at_entry,
        COALESCE(loc.location_count, 0) AS location_count,
        COALESCE(t.total_activated, 0) AS total_activated
      FROM business b
      LEFT JOIN "user" u ON b.user_id = u.id
      LEFT JOIN subscription s ON s.business_id = b.id
      LEFT JOIN (
        SELECT business_id, COUNT(*) AS location_count FROM business_location GROUP BY business_id
      ) loc ON loc.business_id = b.id
      LEFT JOIN (
        SELECT business_id, SUM(CASE WHEN UPPER(status) = 'ACTIVATED' THEN 1 ELSE 0 END) AS total_activated
        FROM ticket GROUP BY business_id
      ) t ON t.business_id = b.id
      ${where}
      ORDER BY b.name ASC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, [...values, limit, offset]),
    pool.query(`
      SELECT COUNT(*) AS total
      FROM business b
      LEFT JOIN "user" u ON b.user_id = u.id
      ${where}
    `, values),
  ]);

  return {
    rows: rowsRes.rows,
    total: Number(countRes.rows[0]?.total ?? 0),
    page,
    limit,
    totalPages: Math.ceil(Number(countRes.rows[0]?.total ?? 0) / limit),
  };
};

export const getActiveDraws = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT id, name, status
    FROM draw
    WHERE status = 'Open'
  `);
  return result.rows;
};

export const createBusinessService = async (data: {
  owner_user_id: number;
  name: string;
  sector: string;
  location: string;
  latitude?: number;
  longitude?: number;
  terms_text?: string;
}) => {
  const pool = getPool();
  const result = await pool.query(`
    INSERT INTO business (user_id, name, sector, location, latitude, longitude, terms_text)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [
    data.owner_user_id,
    data.name,
    data.sector,
    data.location,
    data.latitude ?? null,
    data.longitude ?? null,
    data.terms_text || 'Spend to get a ticket',
  ]);
  return result.rows[0];
};

export const getAllDrawsService = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      d.id,
      d.name,
      d.prize_pool AS prize_amount,
      d.draw_date,
      d.status,
      d.winner_user_id,
      COALESCE(t.entry_count, 0) AS entry_count
    FROM draw d
    LEFT JOIN (
      SELECT draw_id, COUNT(*) AS entry_count
      FROM ticket
      WHERE UPPER(status) = 'ACTIVATED'
      GROUP BY draw_id
    ) t ON t.draw_id = d.id
    ORDER BY d.draw_date DESC
  `);
  return result.rows;
};

export const updateDrawService = async (
  drawId: number,
  data: { name?: string; prize_amount?: number; draw_date?: string },
) => {
  const pool = getPool();

  // Verify draw exists and is Upcoming
  const existing = await pool.query(
    `SELECT id, status FROM draw WHERE id = $1`,
    [drawId],
  );
  if (!existing.rows[0]) throw new Error('Campaign not found');
  if (existing.rows[0].status !== 'Upcoming')
    throw new Error('Only upcoming campaigns can be edited');

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (data.name !== undefined) {
    const trimmed = data.name.trim();
    if (!trimmed) throw new Error('name must not be empty');
    updates.push(`name = $${idx++}`);
    values.push(trimmed);
  }
  if (data.prize_amount !== undefined) {
    if (data.prize_amount <= 0) throw new Error('prize_amount must be positive');
    updates.push(`prize_pool = $${idx++}`);
    values.push(data.prize_amount);
  }
  if (data.draw_date !== undefined) {
    const nyDateStr = new Date(data.draw_date).toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const [month, , year] = nyDateStr.split('/').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0, 4, 0, 0));
    updates.push(`draw_date = $${idx++}`);
    values.push(lastDay);
  }

  if (updates.length === 0) throw new Error('No fields to update');

  values.push(drawId);
  const result = await pool.query(
    `UPDATE draw SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, name, prize_pool AS prize_amount, draw_date, status`,
    values,
  );
  return result.rows[0];
};

export const deleteDrawService = async (drawId: number) => {
  const pool = getPool();
  const existing = await pool.query(`SELECT id, status FROM draw WHERE id = $1`, [drawId]);
  if (!existing.rows[0]) throw new Error('Campaign not found');
  if (existing.rows[0].status !== 'Upcoming')
    throw new Error('Only upcoming campaigns can be deleted');
  await pool.query(`DELETE FROM draw WHERE id = $1`, [drawId]);
};

export const createDrawService = async (data: {
  name: string;
  prize_amount: number;
  draw_date: string;
}) => {
  // Campaigns must end on the last day of a month (00:00 NY time → last day 24:00 NY time).
  // Normalise the provided date to the last day of its month in NY timezone.
  const nyDateStr = new Date(data.draw_date).toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [month, , year] = nyDateStr.split('/').map(Number);
  // Last day of that month in NY time
  const lastDay = new Date(Date.UTC(year, month, 0, 4, 0, 0)); // month=next month, day=0 → last day; +4h offset = midnight NY (UTC-4/UTC-5)
  const drawDate = lastDay;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const drawResult = await client.query(`
      INSERT INTO draw (name, prize_pool, draw_date, status)
      VALUES ($1, $2, $3, 'Upcoming')
      RETURNING *
    `, [data.name, data.prize_amount, drawDate]);

    const draw = drawResult.rows[0];

    // Auto-enroll all currently subscribed businesses into this draw
    const subsResult = await client.query(`
      SELECT b.id AS business_id, COALESCE(s.fee_at_entry, 0) AS monthly_fee
      FROM business b
      JOIN subscription s ON s.business_id = b.id
      WHERE b.is_subscribed = true AND s.status = 'Active'
    `);

    for (const sub of subsResult.rows) {
      await client.query(`
        INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, contribution_amount)
        VALUES ($1, $2, $3, 0)
        ON CONFLICT (draw_id, business_id) DO NOTHING
      `, [draw.id, sub.business_id, sub.monthly_fee]);
    }

    await client.query('COMMIT');
    return draw;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const getDrawBusinessesService = async (drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      b.id,
      b.name,
      b.sector,
      b.logo_url,
      de.fee_at_entry,
      de.contribution_amount,
      de.created_at AS joined_at
    FROM draw_entry de
    JOIN business b ON b.id = de.business_id
    WHERE de.draw_id = $1
    ORDER BY b.name ASC
  `, [drawId]);
  return result.rows;
};

export const openDrawService = async (drawId: number): Promise<void> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the draw row first to prevent concurrent opens
    const check = await client.query(
      `SELECT id, status FROM draw WHERE id = $1 FOR UPDATE`,
      [drawId],
    );
    if (check.rows.length === 0) throw new Error('Draw not found');
    if (check.rows[0].status.toUpperCase() !== 'UPCOMING') throw new Error('Only Upcoming draws can be opened');

    // Atomically check for existing open draw
    const openCheck = await client.query(`SELECT id FROM draw WHERE status = 'Open' FOR UPDATE SKIP LOCKED`);
    if (openCheck.rows.length > 0) throw new Error('A draw is already Open. Close it before opening another.');

    await client.query(`UPDATE draw SET status = 'Open', opened_at = NOW() WHERE id = $1`, [drawId]);
    await client.query(`UPDATE business SET is_participating = true WHERE is_subscribed = true`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const closeDrawService = async (drawId: number): Promise<void> => {
  const pool = getPool();
  const check = await pool.query(`SELECT id, status FROM draw WHERE id = $1`, [drawId]);

  if (check.rows.length === 0) throw new Error('Draw not found');
  if (check.rows[0].status.toUpperCase() !== 'OPEN') throw new Error('Draw is not Open');

  await pool.query(`UPDATE draw SET status = 'Closed', closed_at = NOW() WHERE id = $1`, [drawId]);
  await decayAllUserRiskScores();
};

export const reopenDrawService = async (drawId: number): Promise<void> => {
  const pool = getPool();
  const check = await pool.query(`SELECT id, status, winner_user_id FROM draw WHERE id = $1`, [drawId]);
  if (check.rows.length === 0) throw new Error('Draw not found');
  if (check.rows[0].status.toUpperCase() !== 'CLOSED') throw new Error('Draw is not Closed');
  if (check.rows[0].winner_user_id !== null) throw new Error('Cannot reopen a draw that already has a winner');
  // Check no other draw is already open
  const openCheck = await pool.query(`SELECT id FROM draw WHERE status = 'Open'`);
  if (openCheck.rows.length > 0) throw new Error('A draw is already Open. Close it before reopening another.');
  await pool.query(`UPDATE draw SET status = 'Open', opened_at = COALESCE(opened_at, NOW()), closed_at = NULL WHERE id = $1`, [drawId]);
};

export const pickDrawWinnerService = async (drawId: number): Promise<{
  winnerId: number;
  winnerName: string;
  winnerEmail: string;
  ticketCode: string;
  businessName: string | null;
  locationName: string | null;
  prizePool: number;
}> => {
  const pool = getPool();
  const check = await pool.query(`SELECT id, status, prize_pool, winner_user_id FROM draw WHERE id = $1`, [drawId]);

  if (check.rows.length === 0) throw new Error('Draw not found');
  if (check.rows[0].status.toUpperCase() !== 'CLOSED') throw new Error('Draw is not Closed');
  if (check.rows[0].winner_user_id !== null) {
    throw new Error('Winner has already been picked for this draw');
  }

  const prizePool: number = check.rows[0].prize_pool;

  const ticketResult = await pool.query(`
    SELECT
      t.id AS ticket_id,
      t.code,
      t.activated_by_user_id,
      u.full_name,
      u.email,
      b.name AS business_name,
      bl.name AS location_name
    FROM ticket t
    JOIN "user" u ON t.activated_by_user_id = u.id AND u.risk_score < 20
    LEFT JOIN business b ON t.business_id = b.id
    LEFT JOIN business_location bl ON t.location_id = bl.id
    WHERE t.draw_id = $1 AND t.status = 'Activated' AND t.is_quarantined = FALSE
    ORDER BY random()
    LIMIT 1
  `, [drawId]);

  if (ticketResult.rows.length === 0) throw new Error('No activated tickets in this draw');

  const winner = ticketResult.rows[0];
  const winnerId: number = winner.activated_by_user_id;
  const winnerTicketId: number = winner.ticket_id;

  await pool.query(
    `UPDATE draw SET winner_user_id = $1, winner_ticket_id = $2 WHERE id = $3`,
    [winnerId, winnerTicketId, drawId],
  );

  return {
    winnerId,
    winnerName: winner.full_name,
    winnerEmail: winner.email,
    ticketCode: winner.code,
    businessName: winner.business_name,
    locationName: winner.location_name,
    prizePool,
  };
};

export const getAdminOverviewService = async () => {
  const pool = getPool();

  const [usersRes, bizRes, subRes, drawRes, ticketRes, flaggedRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total_users, SUM(CASE WHEN role='Business' THEN 1 ELSE 0 END) AS business_users, SUM(CASE WHEN role='User' THEN 1 ELSE 0 END) AS regular_users FROM "user" WHERE role != 'Admin'`),
    pool.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN is_subscribed=true THEN 1 ELSE 0 END) AS active FROM business`),
    pool.query(`SELECT COUNT(*) AS active_subs, COALESCE(SUM(fee_at_entry), 0) AS total_fees FROM subscription WHERE UPPER(status) = 'ACTIVE'`),
    pool.query(`SELECT id, name, prize_pool, draw_date FROM draw WHERE UPPER(status)='OPEN' ORDER BY draw_date ASC LIMIT 1`),
    pool.query(`SELECT COUNT(*) AS total_tickets, SUM(CASE WHEN UPPER(status)='ACTIVATED' THEN 1 ELSE 0 END) AS activated FROM ticket WHERE draw_id=(SELECT id FROM draw WHERE UPPER(status)='OPEN' ORDER BY draw_date ASC LIMIT 1)`),
    pool.query(`SELECT COUNT(*) AS flagged_users FROM "user" WHERE risk_score >= 20 AND role != 'Admin'`),
  ]);

  return {
    users: usersRes.rows[0],
    businesses: bizRes.rows[0],
    subscriptions: subRes.rows[0],
    currentDraw: drawRes.rows[0] ?? null,
    currentDrawTickets: ticketRes.rows[0],
    attention: {
      flagged_users: Number(flaggedRes.rows[0]?.flagged_users ?? 0),
    },
  };
};

export const getAllUsersService = async (params: {
  page: number;
  limit: number;
  search?: string;
  role?: string;
  riskLevel?: 'high' | 'medium' | 'low';
}) => {
  const pool = getPool();
  const { page, limit, search, role, riskLevel } = params;
  const offset = (page - 1) * limit;

  const conditions: string[] = [`u.role != 'Admin'`];
  const values: unknown[] = [];
  let idx = 1;

  if (search) {
    conditions.push(`(u.full_name ILIKE $${idx} OR u.email ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }
  if (role) {
    conditions.push(`u.role = $${idx}`);
    values.push(role);
    idx++;
  }
  if (riskLevel === 'high') {
    conditions.push(`u.risk_score >= 20`);
  } else if (riskLevel === 'medium') {
    conditions.push(`u.risk_score >= 10 AND u.risk_score < 20`);
  } else if (riskLevel === 'low') {
    conditions.push(`u.risk_score < 10`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [rowsRes, countRes] = await Promise.all([
    pool.query(
      `SELECT u.id, u.full_name, u.email, u.role, u.is_active, u.is_email_verified, u.created_at,
          u.risk_score, u.risk_last_flagged_at,
          b.id AS business_id, b.name AS business_name, b.is_subscribed AS business_active,
          (SELECT COUNT(*) FROM ticket t WHERE t.activated_by_user_id = u.id AND t.status = 'Activated'
           AND t.draw_id = (SELECT id FROM draw WHERE UPPER(status)='OPEN' ORDER BY draw_date ASC LIMIT 1)
          ) AS entry_count,
          (SELECT MAX(t2.activated_at) FROM ticket t2 WHERE t2.activated_by_user_id = u.id) AS last_active_at
       FROM "user" u
       LEFT JOIN business b ON b.user_id = u.id
       ${where}
       ORDER BY u.risk_score DESC, u.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(*) FROM "user" u ${where}`,
      values,
    ),
  ]);

  const total = parseInt(countRes.rows[0].count, 10);
  return {
    rows: rowsRes.rows,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

export const adminSetUserRiskService = async (userId: number, riskScore: number): Promise<void> => {
  const pool = getPool();
  // Clamp to valid range, never touch Admins
  const clamped = Math.max(0, Math.min(99, riskScore));
  await pool.query(
    `UPDATE "user" SET risk_score = $1, risk_last_flagged_at = CASE WHEN $1 > 0 THEN NOW() ELSE risk_last_flagged_at END
     WHERE id = $2 AND role != 'Admin'`,
    [clamped, userId],
  );
  // Sync quarantine for the active draw
  const drawResult = await pool.query(
    `SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1`,
  );
  const drawId = drawResult.rows[0]?.id;
  if (drawId) {
    // Import syncUserQuarantineState from risk service
    const { syncUserQuarantineState } = await import('../risk/risk.service.js');
    await syncUserQuarantineState(userId, drawId);
  }
};

export const updateUserRoleService = async (userId: number, role: string) => {
  const allowed = ['User', 'Business'];
  if (!allowed.includes(role)) throw new Error('Invalid role');
  const pool = getPool();
  await pool.query(
    `UPDATE "user" SET role=$1 WHERE id=$2 AND role!='Admin'`,
    [role, userId],
  );
};

export const toggleUserActiveService = async (userId: number, isActive: boolean) => {
  const pool = getPool();
  await pool.query(
    `UPDATE "user" SET is_active=$1 WHERE id=$2 AND role!='Admin'`,
    [isActive, userId],
  );
};

export const getPlatformSettingsService = async (): Promise<{ global_entry_cap: number | null; allowed_states: string[] }> => {
  const pool = getPool();
  const result = await pool.query(`SELECT global_entry_cap, allowed_states FROM platform_settings WHERE id = 1`);
  return result.rows[0] ?? { global_entry_cap: null, allowed_states: ['FL'] };
};

export const updatePlatformSettingsService = async (
  global_entry_cap: number | null,
  allowed_states?: string[],
): Promise<void> => {
  const pool = getPool();
  await pool.query(
    `INSERT INTO platform_settings (id, global_entry_cap, allowed_states, updated_at)
     VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET global_entry_cap = $1, allowed_states = $2, updated_at = NOW()`,
    [global_entry_cap, allowed_states ?? ['FL']],
  );
};

export const getPromoCodesService = async () => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT pc.id, pc.code, pc.is_active, pc.max_uses, pc.created_at,
            COUNT(pe.id)::int AS use_count
     FROM promotional_code pc
     LEFT JOIN promotional_entry pe ON pe.code = pc.code
     GROUP BY pc.id
     ORDER BY pc.created_at DESC`,
  );
  return result.rows;
};

export const createPromoCodeService = async (
  code: string,
  maxUses?: number | null,
): Promise<{ id: number; code: string }> => {
  const pool = getPool();
  const normalized = code.toUpperCase().trim();
  if (!normalized || normalized.length < 3 || normalized.length > 100) {
    throw new Error('Code must be between 3 and 100 characters.');
  }
  if (!/^[A-Z0-9_-]+$/.test(normalized)) {
    throw new Error('Code may only contain letters, numbers, hyphens, and underscores.');
  }
  if (maxUses !== undefined && maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
    throw new Error('max_uses must be a positive integer or null (unlimited).');
  }
  try {
    const result = await pool.query(
      `INSERT INTO promotional_code (code, max_uses) VALUES ($1, $2) RETURNING id, code`,
      [normalized, maxUses ?? null],
    );
    return result.rows[0];
  } catch (err: any) {
    if (err.code === '23505') throw new Error('A promo code with that name already exists.');
    throw err;
  }
};

export const deactivatePromoCodeService = async (id: number): Promise<void> => {
  const pool = getPool();
  await pool.query(`UPDATE promotional_code SET is_active = false WHERE id = $1`, [id]);
};

export const getAdminAnalyticsService = async (businessId?: number, drawId?: number) => {
  const pool = getPool();
  // $1 = optional business filter, $2 = optional draw filter. NULL = no filter.
  const biz = businessId ?? null;
  const draw = drawId ?? null;

  const [
    entrySrcRes,
    promoCountRes,
    amoeRes,
    fraudRes,
    quarantineRes,
    quarantineReasonsRes,
    repeatRes,
    userGrowthRes,
  ] = await Promise.all([
    pool.query(
      `SELECT entry_source, COUNT(*) AS count
       FROM ticket
       WHERE ($1::int IS NULL OR business_id = $1)
         AND ($2::int IS NULL OR draw_id = $2)
       GROUP BY entry_source`,
      [biz, draw],
    ),
    // Promo entries have no business_id / draw_id — only include when no filter active
    pool.query(
      `SELECT COUNT(*) AS count FROM promotional_entry WHERE ($1::int IS NULL AND $2::int IS NULL)`,
      [biz, draw],
    ),
    // AMOE: filter by draw_id when provided
    pool.query(
      `SELECT
         COUNT(*) AS total_requests,
         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
         SUM(CASE WHEN rejection_reason = 'weekly_limit_reached' THEN 1 ELSE 0 END) AS weekly_limit_count,
         SUM(CASE WHEN rejection_reason = 'campaign_ended' THEN 1 ELSE 0 END) AS campaign_ended_count
       FROM free_ticket_usage
       WHERE ($1::int IS NULL OR draw_id = $1)`,
      [draw],
    ),
    // Fraud is always platform-wide
    pool.query(
      `SELECT
         SUM(CASE WHEN risk_score >= 20 THEN 1 ELSE 0 END) AS high_risk,
         SUM(CASE WHEN risk_score >= 10 AND risk_score < 20 THEN 1 ELSE 0 END) AS medium_risk,
         SUM(CASE WHEN risk_score < 10 THEN 1 ELSE 0 END) AS low_risk
       FROM "user" WHERE role = 'User'`,
    ),
    pool.query(
      `SELECT
         SUM(CASE WHEN is_quarantined = TRUE THEN 1 ELSE 0 END) AS quarantined,
         SUM(CASE WHEN is_quarantined = FALSE AND status = 'Activated' THEN 1 ELSE 0 END) AS accepted,
         COUNT(*) AS total
       FROM ticket
       WHERE ($1::int IS NULL OR business_id = $1)
         AND ($2::int IS NULL OR draw_id = $2)`,
      [biz, draw],
    ),
    pool.query(
      `SELECT quarantine_reason, COUNT(*) AS count
       FROM ticket
       WHERE is_quarantined = TRUE AND quarantine_reason IS NOT NULL
         AND ($1::int IS NULL OR business_id = $1)
         AND ($2::int IS NULL OR draw_id = $2)
       GROUP BY quarantine_reason
       ORDER BY count DESC`,
      [biz, draw],
    ),
    pool.query(
      `SELECT
         COUNT(*) AS users_with_submissions,
         ROUND(AVG(submission_count)::numeric, 1) AS avg_submissions_per_user,
         SUM(CASE WHEN submission_count >= 2 THEN 1 ELSE 0 END) AS users_2_plus,
         SUM(CASE WHEN business_count >= 2 THEN 1 ELSE 0 END) AS multi_business_users
       FROM (
         SELECT activated_by_user_id,
                COUNT(*) AS submission_count,
                COUNT(DISTINCT business_id) AS business_count
         FROM ticket
         WHERE status = 'Activated' AND activated_by_user_id IS NOT NULL
           AND ($1::int IS NULL OR business_id = $1)
           AND ($2::int IS NULL OR draw_id = $2)
         GROUP BY activated_by_user_id
       ) sub`,
      [biz, draw],
    ),
    // User growth is always platform-wide
    pool.query(
      `SELECT
         SUM(CASE WHEN created_at >= DATE_TRUNC('week', NOW()) THEN 1 ELSE 0 END) AS new_this_week,
         SUM(CASE WHEN created_at >= DATE_TRUNC('month', NOW()) THEN 1 ELSE 0 END) AS new_this_month,
         COUNT(*) AS total
       FROM "user" WHERE role != 'Admin'`,
    ),
  ]);

  const entrySrcMap: Record<string, number> = {};
  for (const row of entrySrcRes.rows) {
    entrySrcMap[row.entry_source] = parseInt(row.count);
  }
  const promoCount = parseInt(promoCountRes.rows[0].count) || 0;
  // promo entries live in promotional_entry, not ticket — add separately
  entrySrcMap['promo'] = (entrySrcMap['promo'] ?? 0) + promoCount;
  const entryTotal = Object.values(entrySrcMap).reduce((a, b) => a + b, 0);

  return {
    entrySourceMix: {
      code: entrySrcMap['code'] ?? 0,
      receipt: entrySrcMap['receipt'] ?? 0,
      free: entrySrcMap['free'] ?? 0,
      promo: entrySrcMap['promo'] ?? 0,
      total: entryTotal,
    },
    amoe: {
      total_requests: parseInt(amoeRes.rows[0].total_requests) || 0,
      approved: parseInt(amoeRes.rows[0].approved) || 0,
      rejected: parseInt(amoeRes.rows[0].rejected) || 0,
      weekly_limit_count: parseInt(amoeRes.rows[0].weekly_limit_count) || 0,
      campaign_ended_count: parseInt(amoeRes.rows[0].campaign_ended_count) || 0,
    },
    fraud: {
      high_risk: parseInt(fraudRes.rows[0].high_risk) || 0,
      medium_risk: parseInt(fraudRes.rows[0].medium_risk) || 0,
      low_risk: parseInt(fraudRes.rows[0].low_risk) || 0,
    },
    validation: {
      quarantined: parseInt(quarantineRes.rows[0].quarantined) || 0,
      accepted: parseInt(quarantineRes.rows[0].accepted) || 0,
      total: parseInt(quarantineRes.rows[0].total) || 0,
      quarantine_reasons: quarantineReasonsRes.rows.map((r) => ({
        reason: r.quarantine_reason as string,
        count: parseInt(r.count),
      })),
    },
    repeatBehavior: {
      users_with_submissions: parseInt(repeatRes.rows[0].users_with_submissions) || 0,
      avg_submissions_per_user: parseFloat(repeatRes.rows[0].avg_submissions_per_user) || 0,
      users_2_plus: parseInt(repeatRes.rows[0].users_2_plus) || 0,
      multi_business_users: parseInt(repeatRes.rows[0].multi_business_users) || 0,
    },
    userGrowth: {
      new_this_week: parseInt(userGrowthRes.rows[0].new_this_week) || 0,
      new_this_month: parseInt(userGrowthRes.rows[0].new_this_month) || 0,
      total: parseInt(userGrowthRes.rows[0].total) || 0,
    },
  };
};

export const getEntryVolumeService = async (drawId?: number, businessId?: number) => {
  const pool = getPool();
  const draw = drawId ?? null;
  const biz = businessId ?? null;
  const result = await pool.query(
    `SELECT
       DATE_TRUNC('day', activated_at)::date AS date,
       COUNT(*) AS count
     FROM ticket
     WHERE UPPER(status) = 'ACTIVATED'
       AND activated_at IS NOT NULL
       AND ($1::int IS NULL OR draw_id = $1)
       AND ($2::int IS NULL OR business_id = $2)
     GROUP BY DATE_TRUNC('day', activated_at)
     ORDER BY DATE_TRUNC('day', activated_at) ASC`,
    [draw, biz],
  );
  return result.rows.map((r) => ({
    date: r.date as string,
    count: parseInt(r.count),
  }));
};

export const getCampaignComparisonService = async () => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      d.id,
      d.name,
      d.status,
      d.prize_pool AS prize_amount,
      d.draw_date,
      COALESCE(t.total_entries, 0) AS total_entries,
      COALESCE(t.quarantined, 0) AS quarantined,
      COALESCE(de.business_count, 0) AS business_count
    FROM draw d
    LEFT JOIN (
      SELECT draw_id,
        COUNT(*) FILTER (WHERE UPPER(status) = 'ACTIVATED') AS total_entries,
        COUNT(*) FILTER (WHERE is_quarantined = TRUE) AS quarantined
      FROM ticket GROUP BY draw_id
    ) t ON t.draw_id = d.id
    LEFT JOIN (
      SELECT draw_id, COUNT(*) AS business_count FROM draw_entry GROUP BY draw_id
    ) de ON de.draw_id = d.id
    ORDER BY d.draw_date DESC
  `);
  return result.rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    status: r.status as string,
    prize_amount: parseFloat(r.prize_amount) || 0,
    draw_date: r.draw_date as string,
    total_entries: parseInt(r.total_entries),
    quarantined: parseInt(r.quarantined),
    business_count: parseInt(r.business_count),
  }));
};

export const duplicateDrawService = async (drawId: number) => {
  const pool = getPool();
  const existing = await pool.query(`SELECT name, prize_pool FROM draw WHERE id = $1`, [drawId]);
  if (!existing.rows[0]) throw new Error('Draw not found');
  const { name, prize_pool } = existing.rows[0];
  const result = await pool.query(
    `INSERT INTO draw (name, prize_pool, draw_date, status)
     VALUES ($1, $2, NOW() + INTERVAL '30 days', 'Upcoming')
     RETURNING id, name, prize_pool AS prize_amount, draw_date, status`,
    [`${name} (Copy)`, prize_pool],
  );
  return result.rows[0];
};

export const getLocationBreakdownService = async (params: {
  businessId?: number;
  search?: string;
  page: number;
  limit: number;
}) => {
  const pool = getPool();
  const { businessId, search, page, limit } = params;
  const biz = businessId ?? null;
  const q = search?.trim() || null;
  const offset = (page - 1) * limit;

  const [rowsRes, countRes] = await Promise.all([
    pool.query(
      `SELECT
         b.id AS business_id,
         b.name AS business_name,
         b.entry_cap,
         b.min_transaction_amount AS threshold,
         bl.id AS location_id,
         COALESCE(bl.name, 'Main Location') AS location_name,
         bl.address,
         COUNT(t.id) AS total_tickets,
         SUM(CASE WHEN t.status = 'Activated' THEN 1 ELSE 0 END) AS activated,
         SUM(CASE WHEN t.is_quarantined = TRUE THEN 1 ELSE 0 END) AS quarantined,
         SUM(CASE WHEN t.entry_source = 'receipt' THEN 1 ELSE 0 END) AS receipt_tickets,
         SUM(CASE WHEN t.entry_source = 'code' THEN 1 ELSE 0 END) AS code_tickets,
         ROUND(AVG(CASE WHEN t.transaction_amount IS NOT NULL THEN t.transaction_amount END)::numeric, 2) AS avg_transaction,
         ROUND(
           100.0 * SUM(CASE WHEN t.transaction_amount IS NOT NULL
             AND b.min_transaction_amount IS NOT NULL
             AND t.transaction_amount >= b.min_transaction_amount
             AND t.transaction_amount <= b.min_transaction_amount * 1.2
             THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN t.entry_source = 'receipt' THEN 1 ELSE 0 END), 0),
           1
         ) AS pct_just_above_threshold
       FROM business b
       JOIN business_location bl ON bl.business_id = b.id AND bl.is_active = TRUE
       LEFT JOIN ticket t ON t.location_id = bl.id
       WHERE ($1::int IS NULL OR b.id = $1)
         AND ($2::text IS NULL OR b.name ILIKE '%' || $2 || '%' OR bl.name ILIKE '%' || $2 || '%')
       GROUP BY b.id, b.name, b.entry_cap, b.min_transaction_amount, bl.id, bl.name, bl.address
       ORDER BY b.name, COALESCE(bl.name, 'Main Location')
       LIMIT $3 OFFSET $4`,
      [biz, q, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(*) AS total
       FROM business b
       JOIN business_location bl ON bl.business_id = b.id AND bl.is_active = TRUE
       WHERE ($1::int IS NULL OR b.id = $1)
         AND ($2::text IS NULL OR b.name ILIKE '%' || $2 || '%' OR bl.name ILIKE '%' || $2 || '%')`,
      [biz, q],
    ),
  ]);

  const total = parseInt(countRes.rows[0].total) || 0;
  return {
    rows: rowsRes.rows.map((r) => ({
      business_id: r.business_id as number,
      business_name: r.business_name as string,
      entry_cap: r.entry_cap ? parseInt(r.entry_cap) : null,
      threshold: r.threshold ? parseFloat(r.threshold) : null,
      location_id: r.location_id as number,
      location_name: r.location_name as string,
      address: r.address as string | null,
      total_tickets: parseInt(r.total_tickets) || 0,
      activated: parseInt(r.activated) || 0,
      quarantined: parseInt(r.quarantined) || 0,
      receipt_tickets: parseInt(r.receipt_tickets) || 0,
      code_tickets: parseInt(r.code_tickets) || 0,
      avg_transaction: r.avg_transaction ? parseFloat(r.avg_transaction) : null,
      pct_just_above_threshold: r.pct_just_above_threshold ? parseFloat(r.pct_just_above_threshold) : null,
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
};

export const getUserDetailService = async (userId: number) => {
  const pool = getPool();

  const [userRes, entriesRes] = await Promise.all([
    pool.query(`
      SELECT
        u.id,
        u.full_name,
        u.email,
        u.role,
        u.is_active,
        u.is_email_verified,
        u.risk_score,
        u.risk_flags,
        u.risk_last_flagged_at,
        u.created_at,
        b.id AS business_id,
        b.name AS business_name,
        b.is_subscribed AS business_active
      FROM "user" u
      LEFT JOIN business b ON b.user_id = u.id
      WHERE u.id = $1
    `, [userId]),
    pool.query(`
      SELECT
        t.id,
        t.code,
        t.status,
        t.entry_source,
        t.activated_at,
        t.is_quarantined,
        t.quarantine_reason,
        t.risk_flags,
        t.receipt_image_url,
        t.image_validation_status,
        t.risk_score_delta,
        d.name AS draw_name,
        b.name AS business_name
      FROM ticket t
      LEFT JOIN draw d ON d.id = t.draw_id
      LEFT JOIN business b ON b.id = t.business_id
      WHERE t.activated_by_user_id = $1
      ORDER BY t.activated_at DESC
      LIMIT 50
    `, [userId]),
  ]);

  if (!userRes.rows[0]) return null;

  return {
    user: userRes.rows[0],
    entries: entriesRes.rows,
  };
};
