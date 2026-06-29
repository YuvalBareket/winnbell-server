import { getPool } from '../../shared/db/db.js';
import { getPlatformSettings, invalidatePlatformSettings, invalidatePublicBusinessData } from '../../shared/cache/cache.js';
import { decayAllUserRiskScores } from '../risk/risk.service.js';

const logDrawAudit = async (
  client: import('pg').PoolClient,
  drawId: number,
  action: string,
  metadata?: Record<string, unknown>,
) => {
  await client.query(
    `INSERT INTO draw_audit_log (draw_id, action, metadata) VALUES ($1, $2, $3)`,
    [drawId, action, metadata ? JSON.stringify(metadata) : null],
  );
};

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
        s.entries_per_location,
        (s.status IN ('Active', 'Trialing')) AS is_subscribed,
        u.full_name AS owner_name,
        u.email AS owner_email,
        s.status AS subscription_status,
        s.current_period_end,
        s.fee_at_entry,
        COALESCE(loc.location_count, 0) AS location_count,
        (SELECT COUNT(*)::int FROM ticket WHERE business_id = b.id AND status = 'Activated') AS total_activated
      FROM business b
      LEFT JOIN "user" u ON b.user_id = u.id
      LEFT JOIN subscription s ON s.business_id = b.id
      LEFT JOIN (
        SELECT business_id, COUNT(*) AS location_count FROM business_location GROUP BY business_id
      ) loc ON loc.business_id = b.id
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
}) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bizResult = await client.query(
      `INSERT INTO business (user_id, name, sector) VALUES ($1, $2, $3) RETURNING *`,
      [data.owner_user_id, data.name, data.sector],
    );
    const business = bizResult.rows[0];
    await client.query(
      `INSERT INTO business_location (business_id, name, address, latitude, longitude, is_active)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [business.id, data.name, data.location, data.latitude ?? null, data.longitude ?? null],
    );
    await client.query('COMMIT');
    return business;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
      d.winner_ticket_id,
      d.winner_confirmed,
      array_length(d.rejected_ticket_ids, 1) AS rejected_count,
      (SELECT COUNT(*)::int FROM ticket WHERE draw_id = d.id AND status = 'Activated') AS entry_count
    FROM draw d
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
  invalidatePublicBusinessData();
  return result.rows[0];
};

export const deleteDrawService = async (drawId: number) => {
  const pool = getPool();
  const existing = await pool.query(`SELECT id, status FROM draw WHERE id = $1`, [drawId]);
  if (!existing.rows[0]) throw new Error('Campaign not found');
  if (existing.rows[0].status !== 'Upcoming')
    throw new Error('Only upcoming campaigns can be deleted');
  await pool.query(`DELETE FROM draw WHERE id = $1`, [drawId]);
  invalidatePublicBusinessData();
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

    // NOTE: businesses are NOT enrolled at create. Enrollment happens at OPEN
    // (openDrawService), which is the single point a business joins a draw and
    // runs after the month-end charges, so only paid businesses get in. Creating
    // a campaign early or creating several has no effect on who participates.

    await client.query('COMMIT');
    invalidatePublicBusinessData();
    return draw;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const getDrawBusinessesService = async (
  drawId: number,
  page = 1,
  limit = 25,
  search = '',
  sector = '',
) => {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const params: (string | number)[] = [drawId];
  const filters: string[] = [];

  if (search) filters.push(`b.name ILIKE $${params.push('%' + search + '%')}`);
  if (sector) filters.push(`b.sector = $${params.push(sector)}`);

  const whereExtra = filters.length ? `AND ${filters.join(' AND ')}` : '';

  const [rows, count] = await Promise.all([
    pool.query(`
      SELECT
        b.id, b.name, b.sector, b.logo_url,
        de.fee_at_entry, de.created_at AS joined_at
      FROM draw_entry de
      JOIN business b ON b.id = de.business_id
      WHERE de.draw_id = $1 ${whereExtra}
      ORDER BY b.name ASC
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
    `, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM draw_entry de JOIN business b ON b.id = de.business_id WHERE de.draw_id = $1 ${whereExtra}`,
      params.slice(0, params.length - 2),
    ),
  ]);

  return { rows: rows.rows, total: count.rows[0].total };
};

// Open a draw inside an EXISTING transaction: flip to Open, enrol the currently-paid
// businesses (the single enrolment point), and log the audit event. The caller must have
// already verified the draw is Upcoming and that no other draw is Open (the close hand-off
// guarantees this by closing the current Open draw first, in the same transaction).
//
// Enrollment happens HERE — the single point a business joins a draw. Open runs from the 1st
// (after month-end charges), so only paid businesses get in:
//  - regular subs (stripe_subscription_id NOT NULL): Active/Trialing, plus Past_Due during
//    Stripe's retry grace (the draw-time check at close removes any still-unpaid).
//  - founding members (no stripe sub): only while their prepaid year still covers this draw's
//    date (current_period_end >= draw_date) — expires them automatically after 12 months.
const openDrawInTx = async (client: import('pg').PoolClient, drawId: number): Promise<void> => {
  await client.query(`UPDATE draw SET status = 'Open', opened_at = NOW() WHERE id = $1`, [drawId]);
  await client.query(`
    INSERT INTO draw_entry (draw_id, business_id, fee_at_entry)
    SELECT d.id, b.id, COALESCE(s.fee_at_entry, 0)
    FROM draw d
    JOIN subscription s ON s.status IN ('Active', 'Trialing', 'Past_Due')
    JOIN business b ON b.id = s.business_id
    WHERE d.id = $1
      AND (s.stripe_subscription_id IS NOT NULL OR s.current_period_end >= d.draw_date)
    ON CONFLICT (draw_id, business_id) DO NOTHING
  `, [drawId]);
  await logDrawAudit(client, drawId, 'opened');
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

    await openDrawInTx(client, drawId);
    await client.query('COMMIT');
    invalidatePublicBusinessData();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const closeDrawService = async (drawId: number): Promise<void> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(`SELECT id, status FROM draw WHERE id = $1 FOR UPDATE`, [drawId]);

    if (check.rows.length === 0) throw new Error('Draw not found');
    if (check.rows[0].status.toUpperCase() !== 'OPEN') throw new Error('Draw is not Open');

    // Always keep exactly one Open draw. Closing the current one atomically opens the next
    // Upcoming draw (earliest draw_date). If there is no Upcoming draw to take over, the close
    // is blocked entirely so the platform is never left with zero Open draws — this is the
    // safeguard against an accidental close. It is all one transaction, so any failure here
    // rolls the close back and the current draw stays Open.
    const nextUpcoming = await client.query(
      `SELECT id FROM draw WHERE status = 'Upcoming' ORDER BY draw_date ASC LIMIT 1 FOR UPDATE`,
    );
    if (nextUpcoming.rows.length === 0) throw new Error('NO_UPCOMING_DRAW');
    const nextDrawId = nextUpcoming.rows[0].id as number;

    await client.query(`UPDATE draw SET status = 'Closed', closed_at = NOW() WHERE id = $1`, [drawId]);
    await logDrawAudit(client, drawId, 'closed');

    // Draw-time safety net: drop any business whose payment never cleared
    // (Past_Due/Incomplete left over from the open-time grace window) so an
    // unpaid business can never be in the final draw. Active businesses — and
    // those who cancelled mid-month but were paid when the draw opened — stay.
    await client.query(`
      DELETE FROM draw_entry de
      USING subscription s
      WHERE de.draw_id = $1 AND s.business_id = de.business_id
        AND s.status IN ('Past_Due', 'Incomplete')
    `, [drawId]);

    // Apply any pending threshold changes that businesses set during the active campaign
    await client.query(`
      UPDATE business
      SET min_transaction_amount         = pending_min_transaction_amount,
          pending_min_transaction_amount = NULL
      WHERE pending_min_transaction_amount IS NOT NULL
    `);

    // Hand off: open the next Upcoming draw in the SAME transaction so there is never a gap.
    await openDrawInTx(client, nextDrawId);

    await client.query('COMMIT');
    invalidatePublicBusinessData();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const reopenDrawService = async (drawId: number): Promise<void> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(
      `SELECT id, status, winner_confirmed FROM draw WHERE id = $1 FOR UPDATE`,
      [drawId],
    );
    if (check.rows.length === 0) throw new Error('Draw not found');
    if (check.rows[0].status.toUpperCase() !== 'CLOSED') throw new Error('Draw is not Closed');
    if (check.rows[0].winner_confirmed === true) throw new Error('Cannot reopen a draw whose winner has been confirmed');

    // Closing a draw auto-opens the next Upcoming one, so there is normally exactly one Open
    // draw when an admin reopens. To preserve the "always one Open" invariant, reopening does an
    // atomic SWAP: revert that auto-opened draw back to Upcoming (un-enrol it) and reopen this one.
    // The swap is only safe while the auto-opened draw has NO activity yet (no tickets) — i.e. the
    // close is being undone before anything happened on the new draw. If it already has any tickets,
    // we block, because reverting it would strand real entries.
    const openRows = await client.query(`SELECT id FROM draw WHERE status = 'Open' FOR UPDATE`);
    for (const row of openRows.rows) {
      if (row.id === drawId) continue; // defensive: this draw is Closed, so it won't be here
      const activity = await client.query(`SELECT 1 FROM ticket WHERE draw_id = $1 LIMIT 1`, [row.id]);
      if (activity.rows.length > 0) throw new Error('NEXT_DRAW_HAS_ACTIVITY');
      // Revert the auto-opened draw to its exact pre-open state: Upcoming, no enrolment, no opened_at.
      await client.query(`DELETE FROM draw_entry WHERE draw_id = $1`, [row.id]);
      await client.query(`UPDATE draw SET status = 'Upcoming', opened_at = NULL WHERE id = $1`, [row.id]);
      await logDrawAudit(client, row.id, 'reverted_to_upcoming', { reason: 'reopen_swap', reopened_draw_id: drawId });
    }

    await client.query(
      `UPDATE draw
       SET status = 'Open',
           opened_at = COALESCE(opened_at, NOW()),
           closed_at = NULL,
           winner_user_id = NULL,
           winner_ticket_id = NULL,
           rejected_ticket_ids = '{}'
       WHERE id = $1`,
      [drawId],
    );
    await logDrawAudit(client, drawId, 'reopened');

    await client.query('COMMIT');
    invalidatePublicBusinessData();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const pickDrawWinnerService = async (drawId: number, applyPenalty = false, reason?: string): Promise<{
  winnerId: number;
  winnerName: string;
  winnerEmail: string;
  ticketCode: string;
  businessName: string | null;
  locationName: string | null;
  prizePool: number;
  receiptIdentifier: string | null;
  transactionAmount: number | null;
  transactionDate: string | null;
  receiptImageUrl: string | null;
  entrySource: string | null;
  imageValidationStatus: string | null;
  riskScore: number;
}> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(
      `SELECT id, status, prize_pool, winner_user_id, winner_ticket_id, winner_confirmed, rejected_ticket_ids
       FROM draw WHERE id = $1 FOR UPDATE`,
      [drawId],
    );

    if (check.rows.length === 0) throw new Error('Draw not found');
    if (check.rows[0].status.toUpperCase() !== 'CLOSED') throw new Error('Draw is not Closed');
    if (check.rows[0].winner_confirmed === true) throw new Error('Winner has already been confirmed for this draw');

    const prizePool: number = check.rows[0].prize_pool;
    let rejectedIds: number[] = check.rows[0].rejected_ticket_ids ?? [];

    // If there is an unconfirmed candidate, reject it and clear it before picking again
    const prevTicketId: number | null = check.rows[0].winner_ticket_id;
    const prevUserId: number | null = check.rows[0].winner_user_id;
    if (prevTicketId !== null) {
      // Disqualifying the current candidate requires a documented reason (legal/regulatory trail).
      const disqualifyReason = (reason ?? '').trim();
      if (!disqualifyReason) {
        throw new Error('A reason is required to disqualify the current winner.');
      }
      rejectedIds = [...rejectedIds, prevTicketId];
      await client.query(
        `UPDATE draw SET winner_user_id = NULL, winner_ticket_id = NULL, rejected_ticket_ids = $1 WHERE id = $2`,
        [rejectedIds, drawId],
      );
      if (prevUserId !== null) {
        const penalty = applyPenalty ? 12 : 0;
        // Always quarantine the rejected ticket - the entry is invalid regardless of penalty
        await client.query(
          `UPDATE ticket SET is_quarantined = TRUE, quarantine_reason = 'admin_rejected_winner', quarantined_at = NOW() WHERE id = $1`,
          [prevTicketId],
        );
        if (applyPenalty) {
          await client.query(`UPDATE "user" SET risk_score = risk_score + $2 WHERE id = $1`, [prevUserId, penalty]);
        }
        // Log rejection (always) with the admin's documented reason — append-only record.
        await client.query(
          `INSERT INTO draw_rejected_winner (draw_id, ticket_id, user_id, risk_penalty, reason) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [drawId, prevTicketId, prevUserId, penalty, disqualifyReason],
        );
        await logDrawAudit(client, drawId, 'winner_rejected', { ticket_id: prevTicketId, user_id: prevUserId, penalty, reason: disqualifyReason });
      }
    }

    // Winner selection scans this draw's eligible tickets once (ORDER BY random() LIMIT 1 is a
    // single O(n) pass keeping the lowest random value, not a full sort). At a very large draw
    // this can exceed the pool's default 10s statement_timeout, so raise it for THIS transaction
    // only (SET LOCAL reverts at COMMIT/ROLLBACK). This is a once-a-month admin operation and a
    // plain SELECT does not block normal user traffic, so a slower run is acceptable.
    await client.query(`SET LOCAL statement_timeout = '60s'`);

    const ticketResult = await client.query(`
      SELECT
        t.id AS ticket_id,
        t.code,
        t.activated_by_user_id,
        t.receipt_identifier,
        t.transaction_amount,
        t.transaction_date,
        t.receipt_image_url,
        t.entry_source,
        t.image_validation_status,
        u.full_name,
        u.email,
        u.risk_score,
        b.name AS business_name,
        bl.name AS location_name
      FROM ticket t
      JOIN "user" u ON t.activated_by_user_id = u.id AND u.risk_score < 20
      LEFT JOIN business b ON t.business_id = b.id
      LEFT JOIN business_location bl ON t.location_id = bl.id
      WHERE t.draw_id = $1
        AND t.status = 'Activated'
        AND t.is_quarantined = FALSE
        AND t.id != ALL($2::int[])
      ORDER BY random()
      LIMIT 1
    `, [drawId, rejectedIds]);

    if (ticketResult.rows.length === 0) throw new Error('No eligible tickets remaining in this draw');

    const winner = ticketResult.rows[0];
    const winnerId: number = winner.activated_by_user_id;
    const winnerTicketId: number = winner.ticket_id;

    await client.query(
      `UPDATE draw SET winner_user_id = $1, winner_ticket_id = $2, rejected_ticket_ids = $3 WHERE id = $4`,
      [winnerId, winnerTicketId, rejectedIds, drawId],
    );
    await logDrawAudit(client, drawId, 'winner_picked', { ticket_id: winnerTicketId, user_id: winnerId });

    await client.query('COMMIT');
    invalidatePublicBusinessData();

    // Sync quarantine state for rejected user (outside transaction, only if penalty applied)
    if (applyPenalty && prevTicketId !== null && prevUserId !== null) {
      try {
        const { syncUserQuarantineState } = await import('../risk/risk.service.js');
        await syncUserQuarantineState(prevUserId, drawId);
      } catch (err) {
        console.error('[pickDrawWinnerService] syncUserQuarantineState failed:', err);
      }
    }

    return {
      winnerId,
      winnerName: winner.full_name,
      winnerEmail: winner.email,
      ticketCode: winner.code,
      businessName: winner.business_name,
      locationName: winner.location_name,
      prizePool,
      receiptIdentifier: winner.receipt_identifier ?? null,
      transactionAmount: winner.transaction_amount ? parseFloat(winner.transaction_amount) : null,
      transactionDate: winner.transaction_date ?? null,
      receiptImageUrl: winner.receipt_image_url ?? null,
      entrySource: winner.entry_source ?? null,
      imageValidationStatus: winner.image_validation_status ?? null,
      riskScore: winner.risk_score ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const confirmWinnerService = async (drawId: number): Promise<{
  winnerId: number;
  winnerName: string;
  winnerEmail: string;
  ticketCode: string;
  businessName: string | null;
  locationName: string | null;
  prizePool: number;
  receiptIdentifier: string | null;
  transactionAmount: number | null;
  transactionDate: string | null;
  receiptImageUrl: string | null;
  entrySource: string | null;
  imageValidationStatus: string | null;
  riskScore: number;
}> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(
      `SELECT id, status, prize_pool, winner_user_id, winner_ticket_id, winner_confirmed
       FROM draw WHERE id = $1 FOR UPDATE`,
      [drawId],
    );

    if (check.rows.length === 0) throw new Error('Draw not found');
    if (check.rows[0].status.toUpperCase() !== 'CLOSED') throw new Error('Draw is not Closed');
    if (check.rows[0].winner_user_id === null || check.rows[0].winner_ticket_id === null) {
      throw new Error('No candidate winner has been picked yet');
    }
    if (check.rows[0].winner_confirmed === true) throw new Error('Winner has already been confirmed');

    const prizePool: number = check.rows[0].prize_pool;
    const winnerTicketId: number = check.rows[0].winner_ticket_id;
    const winnerId: number = check.rows[0].winner_user_id;

    const winnerRes = await client.query(`
      SELECT
        t.code,
        t.receipt_identifier,
        t.transaction_amount,
        t.transaction_date,
        t.receipt_image_url,
        t.entry_source,
        t.image_validation_status,
        u.full_name,
        u.email,
        u.risk_score,
        b.name AS business_name,
        bl.name AS location_name
      FROM ticket t
      JOIN "user" u ON u.id = t.activated_by_user_id
      LEFT JOIN business b ON b.id = t.business_id
      LEFT JOIN business_location bl ON bl.id = t.location_id
      WHERE t.id = $1
    `, [winnerTicketId]);

    if (winnerRes.rows.length === 0) throw new Error('Winner ticket not found');

    const winner = winnerRes.rows[0];

    await client.query(
      `UPDATE draw SET winner_confirmed = TRUE WHERE id = $1`,
      [drawId],
    );
    await logDrawAudit(client, drawId, 'winner_confirmed', { ticket_id: winnerTicketId, user_id: winnerId });

    await client.query('COMMIT');
    invalidatePublicBusinessData();

    // Run decay outside transaction so failure does not roll back confirmation
    try {
      const { unquarantinedUserIds } = await decayAllUserRiskScores();
      if (unquarantinedUserIds.length > 0) {
        // The just-confirmed draw is over, so its quarantine state is irrelevant. Re-validate
        // these now-lower-risk users' entries ONLY in the current open draw (freshly opened, so
        // very few tickets), in ONE bulk query instead of one call per user (pool-safe at scale).
        // If no draw is open, the subquery is NULL and zero rows match (safe no-op).
        await getPool().query(
          `UPDATE ticket SET is_quarantined = FALSE, quarantine_reason = NULL, quarantined_at = NULL
           WHERE draw_id = (SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1)
             AND activated_by_user_id = ANY($1::int[])
             AND is_quarantined = TRUE
             AND quarantine_reason = 'high_risk_user'`,
          [unquarantinedUserIds],
        );
      }
    } catch (err) {
      console.error('[confirmWinnerService] decayAllUserRiskScores failed (winner confirmation succeeded):', err);
    }

    return {
      winnerId,
      winnerName: winner.full_name,
      winnerEmail: winner.email,
      ticketCode: winner.code,
      businessName: winner.business_name,
      locationName: winner.location_name,
      prizePool,
      receiptIdentifier: winner.receipt_identifier ?? null,
      transactionAmount: winner.transaction_amount ? parseFloat(winner.transaction_amount) : null,
      transactionDate: winner.transaction_date ?? null,
      receiptImageUrl: winner.receipt_image_url ?? null,
      entrySource: winner.entry_source ?? null,
      imageValidationStatus: winner.image_validation_status ?? null,
      riskScore: winner.risk_score ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const getAdminOverviewService = async () => {
  const pool = getPool();

  const [usersRes, bizRes, subRes, drawRes, ticketRes, flaggedRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total_users, SUM(CASE WHEN role='Business' THEN 1 ELSE 0 END) AS business_users, SUM(CASE WHEN role='User' THEN 1 ELSE 0 END) AS regular_users FROM "user" WHERE role != 'Admin'`),
    pool.query(`SELECT COUNT(DISTINCT b.id) AS total, COUNT(DISTINCT s.business_id) AS active FROM business b LEFT JOIN subscription s ON s.business_id = b.id AND s.status IN ('Active', 'Trialing')`),
    pool.query(`SELECT COUNT(*) AS active_subs, COALESCE(SUM(fee_at_entry), 0) AS total_fees FROM subscription WHERE status = 'Active'`),
    pool.query(`SELECT id, name, prize_pool, draw_date FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1`),
    pool.query(`SELECT COUNT(*) AS total_tickets, SUM(CASE WHEN status = 'Activated' THEN 1 ELSE 0 END) AS activated FROM ticket WHERE draw_id=(SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1)`),
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
    const normalizedRole = role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
    conditions.push(`u.role = $${idx}`);
    values.push(normalizedRole);
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
          b.id AS business_id, b.name AS business_name, (s2.status IN ('Active', 'Trialing')) AS business_active,
          (SELECT COUNT(*) FROM ticket t WHERE t.activated_by_user_id = u.id AND t.status = 'Activated'
           AND t.draw_id = (SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1)
          ) AS entry_count,
          (SELECT MAX(t2.activated_at) FROM ticket t2 WHERE t2.activated_by_user_id = u.id) AS last_active_at
       FROM "user" u
       LEFT JOIN LATERAL (SELECT id, name FROM business WHERE user_id = u.id ORDER BY id LIMIT 1) b ON true
       LEFT JOIN subscription s2 ON s2.business_id = b.id
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
  // Sync quarantine for all draws that haven't been confirmed yet (Open and Closed without a confirmed winner)
  const drawResult = await pool.query(
    `SELECT id FROM draw WHERE status IN ('Open', 'Closed') AND winner_confirmed IS NOT TRUE`,
  );
  if (drawResult.rows.length > 0) {
    const { syncUserQuarantineState } = await import('../risk/risk.service.js');
    await Promise.all(drawResult.rows.map(row => syncUserQuarantineState(userId, row.id)));
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

export const getPlatformSettingsService = async (): Promise<{
  global_entry_cap: number | null;
  allowed_states: string[];
  founding_member_cap: number;
  founding_phase_active: boolean;
}> => {
  const settings = await getPlatformSettings();
  return {
    global_entry_cap: (settings.global_entry_cap as number | undefined) ?? null,
    // Empty array = no region restriction (matches evaluateRegionRestriction semantics)
    allowed_states: settings.allowed_states ?? [],
    founding_member_cap: settings.founding_member_cap ?? 30,
    founding_phase_active: settings.founding_phase_active ?? true,
  };
};

export const getFoundingMembersTakenCount = async (): Promise<number> => {
  const pool = getPool();
  const result = await pool.query(`SELECT COUNT(*)::int AS taken FROM founding_member`);
  return result.rows[0]?.taken ?? 0;
};

export const updatePlatformSettingsService = async (
  global_entry_cap: number | null,
  allowed_states?: string[],
  founding_member_cap?: number,
  founding_phase_active?: boolean,
): Promise<void> => {
  const pool = getPool();
  // Use COALESCE($n, col) so omitted fields keep their current value.
  // allowed_states: undefined = keep current; [] = explicitly clear (no restriction).
  // Note: founding_phase_active=false works correctly because false ?? null = false (not null).
  await pool.query(
    `INSERT INTO platform_settings (id, global_entry_cap, allowed_states, founding_member_cap, founding_phase_active, updated_at)
     VALUES (1, $1, $2, COALESCE($3, 30), COALESCE($4, TRUE), NOW())
     ON CONFLICT (id) DO UPDATE
       SET global_entry_cap      = $1,
           allowed_states        = COALESCE($2, platform_settings.allowed_states),
           founding_member_cap   = COALESCE($3, platform_settings.founding_member_cap),
           founding_phase_active = COALESCE($4, platform_settings.founding_phase_active),
           updated_at            = NOW()`,
    [global_entry_cap, allowed_states ?? null, founding_member_cap ?? null, founding_phase_active ?? null],
  );
  invalidatePlatformSettings();
  invalidatePublicBusinessData();
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
  } catch (err: unknown) {
    if (err instanceof Error && (err as Error & { code?: string }).code === '23505') throw new Error('A promo code with that name already exists.');
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
    // Free/AMOE entry counts come from the ticket table (entry_source='free') via
    // entrySourceMix below. free_ticket_usage is now a one-row-per-user eligibility
    // tracker (no rejected rows), so it is no longer queried for analytics.
    pool.query(
      `SELECT
         SUM(CASE WHEN u.risk_score >= 20 THEN 1 ELSE 0 END) AS high_risk,
         SUM(CASE WHEN u.risk_score >= 10 AND u.risk_score < 20 THEN 1 ELSE 0 END) AS medium_risk,
         SUM(CASE WHEN u.risk_score < 10 THEN 1 ELSE 0 END) AS low_risk
       FROM "user" u
       WHERE u.role = 'User'
         AND ($1::int IS NULL OR EXISTS (
           SELECT 1 FROM ticket t WHERE t.activated_by_user_id = u.id AND t.business_id = $1
         ))
         AND ($2::int IS NULL OR EXISTS (
           SELECT 1 FROM ticket t WHERE t.activated_by_user_id = u.id AND t.draw_id = $2
         ))`,
      [biz, draw],
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
    pool.query(
      `SELECT
         SUM(CASE WHEN u.created_at >= DATE_TRUNC('week', NOW()) THEN 1 ELSE 0 END) AS new_this_week,
         SUM(CASE WHEN u.created_at >= DATE_TRUNC('month', NOW()) THEN 1 ELSE 0 END) AS new_this_month,
         COUNT(*) AS total
       FROM "user" u
       WHERE u.role != 'Admin'
         AND ($1::int IS NULL OR EXISTS (
           SELECT 1 FROM ticket t WHERE t.activated_by_user_id = u.id AND t.business_id = $1
         ))
         AND ($2::int IS NULL OR EXISTS (
           SELECT 1 FROM ticket t WHERE t.activated_by_user_id = u.id AND t.draw_id = $2
         ))`,
      [biz, draw],
    ),
  ]);

  const entrySrcMap: Record<string, number> = {};
  for (const row of entrySrcRes.rows) {
    entrySrcMap[row.entry_source] = parseInt(row.count);
  }
  const entryTotal = Object.values(entrySrcMap).reduce((a, b) => a + b, 0);

  return {
    entrySourceMix: {
      code: entrySrcMap['code'] ?? 0,
      receipt: entrySrcMap['receipt'] ?? 0,
      free: entrySrcMap['free'] ?? 0,
      promo: entrySrcMap['promo'] ?? 0,
      total: entryTotal,
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
     WHERE status = 'Activated'
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
      (SELECT COUNT(*)::int FROM ticket WHERE draw_id = d.id AND status = 'Activated') AS total_entries,
      (SELECT COUNT(*)::int FROM ticket WHERE draw_id = d.id AND is_quarantined = TRUE) AS quarantined,
      COALESCE(de.business_count, 0) AS business_count
    FROM draw d
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
  invalidatePublicBusinessData();
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
         s_loc.entries_per_location AS entries_per_location,
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
       LEFT JOIN subscription s_loc ON s_loc.business_id = b.id
       LEFT JOIN ticket t ON t.location_id = bl.id
       WHERE ($1::int IS NULL OR b.id = $1)
         AND ($2::text IS NULL OR b.name ILIKE '%' || $2 || '%' OR bl.name ILIKE '%' || $2 || '%')
       GROUP BY b.id, b.name, s_loc.entries_per_location, b.min_transaction_amount, bl.id, bl.name, bl.address
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
      entries_per_location: r.entries_per_location ? parseInt(r.entries_per_location) : null,
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

export const addBusinessToDrawService = async (drawId: number, businessId: number): Promise<void> => {
  const pool = getPool();
  const drawCheck = await pool.query(`SELECT id, status FROM draw WHERE id = $1`, [drawId]);
  if (!drawCheck.rows[0]) throw new Error('Draw not found');
  const drawStatus = drawCheck.rows[0].status as string;
  if (drawStatus !== 'Upcoming' && drawStatus !== 'Open') throw new Error('Can only add businesses to Upcoming or Open draws');

  const subCheck = await pool.query(
    `SELECT s.fee_at_entry FROM subscription s WHERE s.business_id = $1 AND s.status IN ('Active', 'Trialing') LIMIT 1`,
    [businessId],
  );
  const feeAtEntry = subCheck.rows[0]?.fee_at_entry ?? 0;

  await pool.query(
    `INSERT INTO draw_entry (draw_id, business_id, fee_at_entry)
     VALUES ($1, $2, $3)
     ON CONFLICT (draw_id, business_id) DO NOTHING`,
    [drawId, businessId, feeAtEntry],
  );
  invalidatePublicBusinessData();
};

export const removeBusinessFromDrawService = async (drawId: number, businessId: number): Promise<void> => {
  const pool = getPool();
  const drawCheck = await pool.query(`SELECT id, status FROM draw WHERE id = $1`, [drawId]);
  if (!drawCheck.rows[0]) throw new Error('Draw not found');
  const drawStatus = drawCheck.rows[0].status as string;
  if (drawStatus === 'Closed') throw new Error('Cannot remove businesses from a closed draw');
  await pool.query(
    `DELETE FROM draw_entry WHERE draw_id = $1 AND business_id = $2`,
    [drawId, businessId],
  );
  invalidatePublicBusinessData();
};

export const getBusinessDetailService = async (businessId: number) => {
  const pool = getPool();

  const [bizRes, locationsRes, campaignRes] = await Promise.all([
    pool.query(`
      SELECT
        b.id,
        b.name,
        b.sector,
        b.description,
        b.entry_mode,
        b.min_transaction_amount,
        b.website_url,
        b.phone,
        b.logo_url,
        b.created_at,
        u.id AS owner_id,
        u.full_name AS owner_name,
        u.email AS owner_email,
        u.risk_score AS owner_risk_score,
        u.risk_flags AS owner_risk_flags,
        u.is_active AS owner_is_active,
        s.status AS subscription_status,
        s.fee_at_entry,
        s.entries_per_location,
        s.current_period_end,
        EXISTS (
          SELECT 1 FROM draw_entry de
          JOIN draw d ON d.id = de.draw_id
          WHERE de.business_id = b.id AND d.status = 'Open'
        ) AS in_open_draw
      FROM business b
      LEFT JOIN "user" u ON u.id = b.user_id
      LEFT JOIN subscription s ON s.business_id = b.id
      WHERE b.id = $1
    `, [businessId]),

    pool.query(`
      SELECT
        bl.id,
        bl.name,
        bl.address,
        bl.latitude,
        bl.longitude,
        bl.is_active,
        COUNT(t.id) FILTER (WHERE UPPER(t.status::text) = 'ACTIVATED') AS activated_tickets,
        COUNT(t.id) FILTER (WHERE t.is_quarantined = true) AS quarantined_tickets
      FROM business_location bl
      LEFT JOIN ticket t ON t.location_id = bl.id
      WHERE bl.business_id = $1
      GROUP BY bl.id
      ORDER BY bl.is_active DESC, bl.name ASC
    `, [businessId]),

    pool.query(`
      SELECT
        d.id AS draw_id,
        COALESCE(d.name, 'Unknown') AS draw_name,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE t.is_quarantined)::int AS quarantined
      FROM ticket t
      LEFT JOIN draw d ON d.id = t.draw_id
      WHERE t.business_id = $1
      GROUP BY d.id, d.name
      ORDER BY d.id DESC NULLS LAST
    `, [businessId]),
  ]);

  if (!bizRes.rows[0]) return null;

  const campaignSummary = campaignRes.rows.map((r: any) => ({
    draw_id: r.draw_id,
    draw_name: r.draw_name,
    count: r.count,
    quarantined: r.quarantined,
  }));

  return {
    business: bizRes.rows[0],
    locations: locationsRes.rows,
    campaignSummary,
  };
};

export const getBusinessEntriesService = async (
  businessId: number,
  drawId: number | null,
  page: number,
  limit: number,
) => {
  const pool = getPool();
  const offset = (page - 1) * limit;
  const params: (number)[] = [businessId, limit, offset];
  const drawClause = drawId ? `AND t.draw_id = $${params.push(drawId)}` : '';

  const countParams: (number)[] = [businessId];
  const countDrawClause = drawId ? `AND draw_id = $${countParams.push(drawId)}` : '';

  const [rowsRes, countRes] = await Promise.all([
    pool.query(`
      SELECT
        t.id, t.code, t.status, t.entry_source, t.activated_at,
        t.is_quarantined, t.quarantine_reason, t.risk_flags,
        t.receipt_image_url, t.image_validation_status,
        t.risk_score_delta, t.transaction_amount,
        d.name AS draw_name, d.id AS draw_id,
        u.full_name AS user_name, u.email AS user_email, u.id AS user_id,
        bl.name AS location_name
      FROM ticket t
      LEFT JOIN draw d ON d.id = t.draw_id
      LEFT JOIN "user" u ON u.id = t.activated_by_user_id
      LEFT JOIN business_location bl ON bl.id = t.location_id
      WHERE t.business_id = $1 ${drawClause}
      ORDER BY t.activated_at DESC NULLS LAST
      LIMIT $2 OFFSET $3
    `, params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM ticket WHERE business_id = $1 ${countDrawClause}`,
      countParams,
    ),
  ]);

  return { rows: rowsRes.rows, total: countRes.rows[0].total };
};

export const adminImageDecisionService = async (
  ticketId: number,
  decision: 'approve' | 'reject',
): Promise<void> => {
  const pool = getPool();
  const { updateUserRiskScore, syncUserQuarantineState } = await import('../risk/risk.service.js');

  const ticketRes = await pool.query(
    `SELECT id, activated_by_user_id, draw_id, image_validation_status FROM ticket WHERE id = $1`,
    [ticketId],
  );
  if (!ticketRes.rows[0]) throw new Error('Ticket not found');

  const { activated_by_user_id: userId, draw_id: drawId, image_validation_status: prevStatus } = ticketRes.rows[0];
  if (!userId) throw new Error('Ticket has no associated user');

  const overrideable = ['passed', 'failed', 'ocr_error', 'pending'];
  if (!overrideable.includes(prevStatus)) throw new Error(`Cannot override image decision for status: ${prevStatus}`);

  // Idempotency: prevent double-approve or double-reject from farming risk score
  if (decision === 'approve' && prevStatus === 'passed') throw new Error('Image is already approved');
  if (decision === 'reject' && prevStatus === 'failed') throw new Error('Image is already rejected');

  if (decision === 'approve') {
    // Reverse the +2 penalty if previously failed, then apply -3 reward
    const ticketDeltaChange = prevStatus === 'failed' ? -5 : -3;
    const userDelta = prevStatus === 'failed' ? -5 : -3;

    await pool.query(
      `UPDATE ticket
       SET image_validation_status = 'passed',
           risk_score_delta        = risk_score_delta + $2,
           is_quarantined          = FALSE,
           quarantine_reason       = NULL,
           quarantined_at          = NULL
       WHERE id = $1`,
      [ticketId, ticketDeltaChange],
    );
    await pool.query(
      `UPDATE ticket
       SET is_quarantined = FALSE, quarantine_reason = NULL, quarantined_at = NULL
       WHERE anchor_ticket_id = $1
         AND quarantine_reason IN ('ocr_pending', 'ocr_validation_failed', 'ocr_error_pending_review')`,
      [ticketId],
    );
    await updateUserRiskScore(userId, userDelta);
    await syncUserQuarantineState(userId, drawId);
  } else {
    // Reverse the -3 reward if previously passed, then apply +2 penalty
    const ticketDeltaChange = prevStatus === 'passed' ? 5 : 2;
    const userDelta = prevStatus === 'passed' ? 5 : 2;

    await pool.query(
      `UPDATE ticket
       SET image_validation_status = 'failed',
           risk_score_delta        = risk_score_delta + $2,
           is_quarantined          = TRUE,
           quarantine_reason       = 'ocr_validation_failed',
           quarantined_at          = NOW()
       WHERE id = $1`,
      [ticketId, ticketDeltaChange],
    );
    await pool.query(
      `UPDATE ticket
       SET is_quarantined = TRUE, quarantine_reason = 'ocr_validation_failed', quarantined_at = NOW()
       WHERE anchor_ticket_id = $1 AND quarantine_reason = 'ocr_pending'`,
      [ticketId],
    );
    await updateUserRiskScore(userId, userDelta, undefined, []);
    await syncUserQuarantineState(userId, drawId);
  }
};

export const getDrawCandidateService = async (drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      d.winner_user_id, d.winner_ticket_id, d.winner_confirmed, d.prize_pool,
      t.code, t.receipt_identifier, t.transaction_amount, t.transaction_date,
      t.receipt_image_url, t.entry_source, t.image_validation_status,
      u.full_name, u.email, u.risk_score,
      b.name AS business_name, bl.name AS location_name
    FROM draw d
    LEFT JOIN ticket t ON t.id = d.winner_ticket_id
    LEFT JOIN "user" u ON u.id = d.winner_user_id
    LEFT JOIN business b ON b.id = t.business_id
    LEFT JOIN business_location bl ON bl.id = t.location_id
    WHERE d.id = $1
  `, [drawId]);

  const row = result.rows[0];
  if (!row || !row.winner_ticket_id) return null;

  return {
    winnerConfirmed: row.winner_confirmed === true,
    winnerId: row.winner_user_id,
    winnerName: row.full_name,
    winnerEmail: row.email,
    ticketCode: row.code,
    businessName: row.business_name ?? null,
    locationName: row.location_name ?? null,
    prizePool: parseFloat(row.prize_pool),
    receiptIdentifier: row.receipt_identifier ?? null,
    transactionAmount: row.transaction_amount ? parseFloat(row.transaction_amount) : null,
    transactionDate: row.transaction_date ?? null,
    receiptImageUrl: row.receipt_image_url ?? null,
    entrySource: row.entry_source ?? null,
    imageValidationStatus: row.image_validation_status ?? null,
    riskScore: row.risk_score ?? 0,
  };
};

export const getDrawRejectedWinnersService = async (drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      drw.id, drw.rejected_at, drw.risk_penalty, drw.reason,
      t.id AS ticket_id, t.code, t.receipt_identifier, t.transaction_amount,
      t.transaction_date, t.receipt_image_url, t.entry_source,
      u.id AS user_id, u.full_name, u.email, u.risk_score,
      b.name AS business_name, bl.name AS location_name
    FROM draw_rejected_winner drw
    JOIN ticket t ON t.id = drw.ticket_id
    JOIN "user" u ON u.id = drw.user_id
    LEFT JOIN business b ON b.id = t.business_id
    LEFT JOIN business_location bl ON bl.id = t.location_id
    WHERE drw.draw_id = $1
    ORDER BY drw.rejected_at DESC
  `, [drawId]);

  return result.rows.map(r => ({
    id: r.id,
    rejectedAt: r.rejected_at,
    riskPenalty: r.risk_penalty,
    reason: r.reason ?? null,
    ticketId: r.ticket_id,
    ticketCode: r.code,
    receiptIdentifier: r.receipt_identifier ?? null,
    transactionAmount: r.transaction_amount ? parseFloat(r.transaction_amount) : null,
    transactionDate: r.transaction_date ?? null,
    receiptImageUrl: r.receipt_image_url ?? null,
    entrySource: r.entry_source ?? null,
    userId: r.user_id,
    userName: r.full_name,
    userEmail: r.email,
    userRiskScore: r.risk_score ?? 0,
    businessName: r.business_name ?? null,
    locationName: r.location_name ?? null,
  }));
};

export const getDrawAuditLogService = async (drawId: number) => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, action, metadata, created_at FROM draw_audit_log WHERE draw_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [drawId],
  );
  return result.rows;
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
        (s3.status IN ('Active', 'Trialing')) AS business_active
      FROM "user" u
      LEFT JOIN LATERAL (SELECT id, name FROM business WHERE user_id = u.id ORDER BY id LIMIT 1) b ON true
      LEFT JOIN subscription s3 ON s3.business_id = b.id
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
