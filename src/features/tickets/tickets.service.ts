import { getPool, PoolClient } from '../../shared/db/db.js';
import crypto from 'crypto';
import {
  ActivationResult,
  FreeTicketStatus,
  ITicket,
  ReceiptEntryInput,
} from './tickets.types.js';

const MAX_ENTRIES_PER_RECEIPT = 10;
import {
  evaluateUserRisk,
  updateUserRiskScore,
  checkDuplicateReceiptIdentifier,
  countsAgainstCap,
  syncUserQuarantineState,
  type PreFetchedUserRisk,
} from '../risk/risk.service.js';
import { RISK_THRESHOLDS } from '../risk/risk.types.js';
import { validateReceiptAsync } from '../ocr/ocr.service.js';

export const activateTicket = async (code: string, userId: number) => {
  const pool = getPool();

  const checkResult = await pool.query(`
    SELECT t.id, t.status, t.business_id, t.location_id, t.draw_id, d.status as draw_status
    FROM ticket t
    LEFT JOIN draw d ON t.draw_id = d.id
    WHERE t.code = $1
  `, [code]);

  const ticket = checkResult.rows[0];
  if (!ticket) throw new Error('Invalid ticket code.');
  if (ticket.draw_status?.toUpperCase() !== 'OPEN') throw new Error('The draw for this ticket is already closed.');

  const ownerCheck = await pool.query(`
    SELECT 1 FROM business WHERE id = $1 AND user_id = $2
    UNION ALL
    SELECT 1 FROM business_location WHERE id = $3 AND manager_user_id = $2
    LIMIT 1
  `, [ticket.business_id, userId, ticket.location_id]);
  if (ownerCheck.rows.length > 0) {
    throw new Error('Business owners and managers cannot activate tickets for their own business.');
  }

  // Per-draw per-user ticket cap — use ticket.draw_id (already resolved above)
  const drawCapResult = await pool.query(
    `SELECT COUNT(*) AS count FROM ticket
     WHERE activated_by_user_id = $1 AND draw_id = $2 AND is_quarantined = FALSE`,
    [userId, ticket.draw_id],
  );
  if (parseInt(drawCapResult.rows[0].count, 10) >= 30) {
    throw new Error('You have reached the maximum of 30 entries for this draw.');
  }

  const updateResult = await pool.query(`
    UPDATE ticket
    SET status = 'Activated',
        activated_by_user_id = $1,
        activated_at = NOW()
    WHERE code = $2
      AND status = 'Issued'
      AND draw_id IN (SELECT id FROM draw WHERE status = 'Open')
  `, [userId, code]);

  if (updateResult.rowCount === 0) throw new Error('This ticket has already been used or the draw is no longer open.');

  return { message: 'Ticket activated successfully!' };
};

export const getUserTicketsService = async (userId: number, drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      t.id,
      t.code,
      t.status,
      t.activated_at,
      b.name  AS business_name,
      b.sector AS business_sector,
      b.logo_url,
      bl.name AS location_name,
      d.name  AS draw_name
    FROM ticket t
    LEFT JOIN business b ON t.business_id = b.id
    LEFT JOIN business_location bl ON t.location_id = bl.id
    JOIN draw d ON t.draw_id = d.id
    WHERE t.activated_by_user_id = $1
      AND t.draw_id = $2

    UNION ALL

    SELECT
      pe.id,
      pe.code,
      'Activated'           AS status,
      pe.created_at         AS activated_at,
      'Promotional Entry'   AS business_name,
      NULL                  AS business_sector,
      NULL                  AS logo_url,
      NULL                  AS location_name,
      d.name                AS draw_name
    FROM promotional_entry pe
    JOIN draw d ON d.id = pe.draw_id
    WHERE pe.user_id = $1
      AND pe.draw_id = $2

    ORDER BY activated_at DESC
  `, [userId, drawId]);

  // Effective count: non-quarantined receipt/free/code tickets + all promo entries
  const countResult = await pool.query(
    `SELECT (
       (SELECT COUNT(*)::int FROM ticket WHERE activated_by_user_id = $1 AND draw_id = $2 AND is_quarantined = FALSE)
       + (SELECT COUNT(*)::int FROM promotional_entry WHERE user_id = $1 AND draw_id = $2)
     ) AS effective_count`,
    [userId, drawId],
  );
  const effectiveCount: number = Number(countResult.rows[0]?.effective_count ?? 0);

  return { tickets: result.rows, effectiveCount };
};

export const getBusinessTicketsService = async (userId: number, drawId: number, locationId?: number) => {
  const pool = getPool();

  // Get businessId, per-location cap, and active location count in one query
  const bizRes = await pool.query(
    `SELECT
       b.id AS business_id,
       COALESCE(s.entries_per_location, ps.global_entry_cap) AS per_location_cap,
       (SELECT COUNT(*)::int FROM business_location WHERE business_id = b.id AND is_active = TRUE) AS active_location_count
     FROM business b
     LEFT JOIN subscription s ON s.business_id = b.id
     LEFT JOIN platform_settings ps ON ps.id = 1
     WHERE b.user_id = $1`,
    [userId],
  );
  const biz = bizRes.rows[0];
  if (!biz) throw new Error('Business not found');
  const businessId: number = biz.business_id;
  const perLocationCap: number | null = biz.per_location_cap != null ? Number(biz.per_location_cap) : null;
  const activeLocationCount: number = Number(biz.active_location_count ?? 1);
  // When viewing all locations the cap is per-location cap × number of active locations.
  // When filtered to a single location the cap is the per-location cap.
  const cap: number | null = perLocationCap !== null
    ? (locationId ? perLocationCap : perLocationCap * activeLocationCount)
    : null;

  const countParams: unknown[] = [businessId, drawId];
  const countLocClause = locationId ? (countParams.push(locationId), `AND t.location_id = $${countParams.length}`) : '';
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total_count FROM ticket t
     WHERE t.business_id = $1 AND t.draw_id = $2 AND t.is_quarantined = FALSE ${countLocClause}`,
    countParams,
  );
  const totalCount: number = Number(countRes.rows[0]?.total_count ?? 0);

  const ticketParams: unknown[] = [userId, drawId];
  const locationClause = locationId ? (ticketParams.push(locationId), `AND t.location_id = $${ticketParams.length}`) : '';
  const result = await pool.query(
    `SELECT t.id, t.code, t.status, t.activated_at, t.is_quarantined,
            bl.name AS location_name, u.full_name AS activated_by_user, u.email AS activated_by_email
     FROM ticket t
     INNER JOIN business b ON t.business_id = b.id
     LEFT JOIN business_location bl ON t.location_id = bl.id
     LEFT JOIN "user" u ON t.activated_by_user_id = u.id
     WHERE b.user_id = $1 AND t.draw_id = $2 ${locationClause}
     ORDER BY t.created_at DESC`,
    ticketParams,
  );

  return { tickets: result.rows, totalCount, cap, perLocationCap, activeLocationCount };
};

export const getLocationTicketsService = async (userId: number, drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      t.id,
      t.code,
      t.status,
      t.activated_at,
      t.is_quarantined,
      bl.name as location_name,
      u_act.full_name as activated_by_user,
      u_act.email as activated_by_email
    FROM ticket t
    INNER JOIN business_location bl ON t.location_id = bl.id
    LEFT JOIN "user" u_act ON t.activated_by_user_id = u_act.id
    WHERE bl.manager_user_id = $1
    AND t.draw_id = $2
    ORDER BY t.created_at DESC
  `, [userId, drawId]);
  return result.rows;
};

export const checkFreeTicketEligibility = async (userId: number): Promise<FreeTicketStatus> => {
  const pool = getPool();

  // Check for an open draw first — no point showing READY if there's no campaign
  const drawResult = await pool.query(`SELECT id FROM draw WHERE status = 'Open' LIMIT 1`);
  if (!drawResult.rows[0]) {
    return { canActivate: false, reason: 'no_campaign' };
  }

  const result = await pool.query(`
    SELECT activated_at
    FROM free_ticket_usage
    WHERE user_id = $1 AND status = 'approved'
    ORDER BY activated_at DESC
    LIMIT 1
  `, [userId]);

  const lastUsage = result.rows[0];

  if (!lastUsage) return { canActivate: true };

  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const lastDate = new Date(lastUsage.activated_at);
  const usedThisWeek = lastDate >= weekStart;

  if (!usedThisWeek) return { canActivate: true };

  const nextSunday = new Date(weekStart);
  nextSunday.setDate(weekStart.getDate() + 7);

  return { canActivate: false, nextAvailableDate: nextSunday };
};

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no ambiguous O/0/I/1/L

export const generateGlobalUniqueCode = async (client?: PoolClient): Promise<string> => {
  const MAX_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)];
    }

    const result = client
      ? await client.query(`SELECT COUNT(*) as count FROM ticket WHERE code = $1`, [code])
      : await getPool().query(`SELECT COUNT(*) as count FROM ticket WHERE code = $1`, [code]);

    if (parseInt(result.rows[0].count) === 0) return code;
  }
  throw new Error('Failed to generate a unique ticket code. Please try again.');
};

export const activateFreeTicket = async (userId: number, claimIp?: string): Promise<ActivationResult> => {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Advisory lock scoped to this user's free ticket claim — prevents double-claim on empty table.
    // Lock is acquired atomically within the same query as the eligibility check to avoid an
    // extra round-trip. LEFT JOIN ensures one row is always returned (activated_at = NULL when
    // no prior usage exists), which is equivalent to the original behaviour.
    // Also loads account age and email-verification status in the same round-trip.
    const eligibilityResult = await client.query(`
      SELECT u.activated_at, usr.is_email_verified, usr.created_at AS account_created_at
      FROM (SELECT pg_advisory_xact_lock($1)) AS _lock
      CROSS JOIN (SELECT is_email_verified, created_at FROM "user" WHERE id = $1) AS usr
      LEFT JOIN LATERAL (
        SELECT activated_at FROM free_ticket_usage WHERE user_id = $1 AND status = 'approved'
        ORDER BY activated_at DESC LIMIT 1
      ) AS u ON true
    `, [userId]);

    const lastUsage = eligibilityResult.rows[0];

    // Guard 1: email must be verified (blocks throwaway email accounts)
    if (lastUsage && !lastUsage.is_email_verified) {
      await client.query(
        `INSERT INTO free_ticket_usage (user_id, status, rejection_reason, entries_created) VALUES ($1, 'rejected', 'email_not_verified', 0)`,
        [userId]
      );
      await client.query('COMMIT');
      throw new Error('Please verify your email address before claiming a free entry.');
    }

    // Guard 2: weekly usage check (1 free entry per user per week)
    if (lastUsage?.activated_at) {
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      weekStart.setHours(0, 0, 0, 0);
      const usedThisWeek = new Date(lastUsage.activated_at) >= weekStart;
      if (usedThisWeek) {
        await client.query(
          `INSERT INTO free_ticket_usage (user_id, status, rejection_reason, entries_created) VALUES ($1, 'rejected', 'weekly_limit_reached', 0)`,
          [userId]
        );
        await client.query('COMMIT');
        throw new Error('Weekly limit reached. Please wait until your next available date.');
      }
    }

    // Guard 4: IP-based cap — max 3 distinct users per IP per week (allows households, blocks bot farms)
    if (claimIp) {
      const ipCapResult = await client.query(
        `SELECT COUNT(DISTINCT user_id) AS cnt FROM free_ticket_usage
         WHERE claim_ip = $1 AND status = 'approved'
           AND activated_at >= date_trunc('week', NOW())`,
        [claimIp],
      );
      if (parseInt(ipCapResult.rows[0].cnt, 10) >= 3) {
        await client.query(
          `INSERT INTO free_ticket_usage (user_id, claim_ip, status, rejection_reason, entries_created) VALUES ($1, $2, 'rejected', 'ip_free_entry_limit', 0)`,
          [userId, claimIp]
        );
        await client.query('COMMIT');
        throw new Error('Free entry limit reached for your network this week.');
      }
    }

    const drawResult = await client.query(`
      SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1
    `);

    const activeDrawId = drawResult.rows[0]?.id;
    if (!activeDrawId) {
      await client.query(
        `INSERT INTO free_ticket_usage (user_id, status, rejection_reason, entries_created) VALUES ($1, 'rejected', 'campaign_ended', 0)`,
        [userId]
      );
      await client.query('COMMIT');
      throw new Error('No active campaign found. Please try again later.');
    }

    // Per-draw per-user cap — counts non-quarantined tickets + all promo entries
    const drawCapResult = await client.query(
      `SELECT (
         (SELECT COUNT(*)::int FROM ticket WHERE activated_by_user_id = $1 AND draw_id = $2 AND is_quarantined = FALSE)
         + (SELECT COUNT(*)::int FROM promotional_entry WHERE user_id = $1 AND draw_id = $2)
       ) AS total_count`,
      [userId, activeDrawId],
    );
    if (parseInt(drawCapResult.rows[0].total_count, 10) >= 30) {
      await client.query(
        `INSERT INTO free_ticket_usage (user_id, draw_id, status, rejection_reason, entries_created) VALUES ($1, $2, 'rejected', 'draw_cap_reached', 0)`,
        [userId, activeDrawId],
      );
      await client.query('COMMIT');
      throw new Error('You have reached the maximum of 30 entries for this draw.');
    }

    await client.query(
      `INSERT INTO free_ticket_usage (user_id, draw_id, claim_ip, status, entries_created) VALUES ($1, $2, $3, 'approved', 1)`,
      [userId, activeDrawId, claimIp ?? null]
    );

    const ticketCode = await generateGlobalUniqueCode(client);

    const ticketResult = await client.query(`
      INSERT INTO ticket (code, status, entry_source, business_id, activated_by_user_id, draw_id, activated_at)
      VALUES ($1, 'Activated', 'free', NULL, $2, $3, NOW())
      RETURNING id
    `, [ticketCode, userId, activeDrawId]);

    await client.query('COMMIT');

    return {
      success: true,
      ticketId: ticketResult.rows[0].id,
      code: ticketCode,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const submitReceiptEntryService = async (
  userId: number,
  input: ReceiptEntryInput,
): Promise<{ tickets: Array<{ ticketId: number; code: string }>; entryCount: number }> => {
  const pool = getPool();
  const client = await pool.connect();
  let drawId: number = 0;
  let duplicatePenalty = false;

  try {
    await client.query('BEGIN');

    // Serialize concurrent receipt submissions from the same user so the
    // daily_count read in the preflight is never stale across parallel requests.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('usr_receipt_' || $1::text))`,
      [userId],
    );

    // Single pre-flight query: replaces 7 sequential round trips with 1
    const preflightRes = await client.query(
      `WITH
        biz AS (
          SELECT b.id AS business_id, b.name AS business_name, b.min_transaction_amount
          FROM business_location bl
          JOIN business b ON bl.business_id = b.id
          WHERE bl.id = $2 AND bl.is_active = true
            AND EXISTS (
              SELECT 1 FROM draw_entry de
              JOIN draw d ON d.id = de.draw_id
              WHERE de.business_id = b.id AND d.status = 'Open'
            )
          LIMIT 1
        ),
        od AS (
          SELECT id AS draw_id, COALESCE(opened_at, created_at) AS draw_opened_at
          FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1
        )
      SELECT
        (SELECT is_email_verified                FROM "user" WHERE id = $1)  AS is_email_verified,
        (SELECT risk_score                       FROM "user" WHERE id = $1)  AS risk_score,
        (SELECT risk_last_flagged_at             FROM "user" WHERE id = $1)  AS risk_last_flagged_at,
        (SELECT business_id                      FROM biz)                   AS business_id,
        (SELECT business_name                    FROM biz)                   AS business_name,
        (SELECT min_transaction_amount           FROM biz)                   AS min_transaction_amount,
        (SELECT draw_id                          FROM od)                    AS draw_id,
        (SELECT draw_opened_at                   FROM od)                    AS draw_opened_at,
        (SELECT EXISTS(SELECT 1 FROM platform_settings WHERE id = 1))        AS settings_exists,
        (SELECT global_entry_cap FROM platform_settings WHERE id = 1)        AS global_entry_cap,
        EXISTS (
          SELECT 1 FROM business bx
          LEFT JOIN business_location blx ON blx.business_id = bx.id AND blx.id = $2
          WHERE bx.id = (SELECT business_id FROM biz)
            AND (bx.user_id = $1 OR blx.manager_user_id = $1)
        )                                                                     AS has_conflict,
        (
          SELECT COUNT(DISTINCT receipt_identifier)::int FROM ticket
          WHERE activated_by_user_id = $1 AND entry_source = 'receipt'
            AND receipt_identifier IS NOT NULL
            AND activated_at >= NOW() - INTERVAL '24 hours'
        )                                                                     AS daily_count,
        COALESCE((
          SELECT (
            (SELECT COUNT(*)::int FROM ticket WHERE activated_by_user_id = $1 AND draw_id = (SELECT draw_id FROM od) AND is_quarantined = FALSE)
            + (SELECT COUNT(*)::int FROM promotional_entry WHERE user_id = $1 AND draw_id = (SELECT draw_id FROM od))
          )
        ), 0)                                                                 AS draw_count`,
      [userId, input.locationId],
    );

    const pf = preflightRes.rows[0];

    if (!pf.is_email_verified) {
      throw new Error('Please verify your email address before submitting entries.');
    }
    if (!pf.business_id) {
      throw new Error('This business is not participating in the current campaign. Try a different location or check back next month.');
    }
    if (pf.has_conflict) {
      throw new Error('Business owners and managers cannot submit entries for their own business.');
    }
    if (!pf.draw_id) {
      throw new Error('No active campaign found.');
    }
    if (pf.daily_count >= 5) {
      throw new Error('You have reached the daily receipt submission limit. Please try again tomorrow.');
    }

    const business_id: number = pf.business_id;
    const business_name: string = pf.business_name;
    const minTransactionAmount: number | null = pf.min_transaction_amount
      ? parseFloat(pf.min_transaction_amount)
      : null;
    drawId = pf.draw_id;
    const draw_opened_at: Date = pf.draw_opened_at;
    // If settings row missing, fall back to 500; if row exists with NULL, treat as unlimited
    const entry_cap: number | null = pf.settings_exists ? pf.global_entry_cap : 500;

    const entryCount = minTransactionAmount && minTransactionAmount > 0
      ? Math.min(Math.floor(input.transactionAmount / minTransactionAmount), MAX_ENTRIES_PER_RECEIPT)
      : 1;

    const currentDrawCount = Number(pf.draw_count);
    const remainingDrawEntries = 30 - currentDrawCount;
    if (remainingDrawEntries <= 0) {
      throw new Error('You have reached the maximum of 30 entries for this draw.');
    }

    // Minimum transaction amount check
    if (minTransactionAmount && input.transactionAmount < minTransactionAmount) {
      // Always penalise below-threshold submissions — prevents free threshold probing.
      // Use pool directly so this persists even though the enclosing transaction rolls back on throw.
      await updateUserRiskScore(userId, 1);

      // Heavier penalty if the same identifier was previously submitted successfully with a different amount
      const probeCheck = await pool.query(
        `SELECT COUNT(*) AS count FROM ticket
         WHERE business_id = $1 AND receipt_identifier = $2
           AND transaction_amount != $3`,
        [business_id, input.receiptIdentifier, input.transactionAmount],
      );
      if (parseInt(probeCheck.rows[0].count, 10) > 0) {
        await updateUserRiskScore(userId, 3); // +3 more = +4 total for confirmed probe
        const probeDrawResult = await pool.query(
          `SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1`,
        );
        const probDrawId = probeDrawResult.rows[0]?.id;
        if (probDrawId) {
          await syncUserQuarantineState(userId, probDrawId);
        }
      }
      throw new Error('Transaction amount is not sufficient to earn an entry.');
    }

    // Transaction date validation
    if (input.transactionDate) {
      const txDate = new Date(input.transactionDate);
      const drawOpenedAt = new Date(draw_opened_at);
      const now = new Date();
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      if (txDate > now) {
        throw new Error('Purchase date cannot be in the future.');
      }
      if (txDate < sevenDaysAgo) {
        throw new Error('Receipt is older than 7 days and cannot be accepted.');
      }
      if (txDate < drawOpenedAt) {
        throw new Error('Transaction date must fall within the current campaign period.');
      }
    }

    // Acquire an advisory lock keyed on (business_id, receiptIdentifier) to prevent
    // two concurrent submissions of the same receipt slipping through the duplicate check
    // simultaneously (TOCTOU race condition). The lock is automatically released at COMMIT/ROLLBACK.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1::text || '|' || $2::text))`,
      [String(business_id), input.receiptIdentifier],
    );

    // Check cross-user duplicate inside the transaction (using client, not pool) so the
    // advisory lock above actually serializes this read against concurrent submissions.
    const dupCheck = await checkDuplicateReceiptIdentifier(
      business_id,
      input.receiptIdentifier,
      userId,
      client,
    );

    // Evaluate risk — pass pre-fetched user score to skip the extra SELECT
    const preFetchedRisk: PreFetchedUserRisk = {
      storedScore: Number(pf.risk_score ?? 0),
      lastFlaggedAt: pf.risk_last_flagged_at ? new Date(pf.risk_last_flagged_at) : null,
    };
    const riskEval = await evaluateUserRisk(userId, {
      businessId: business_id,
      receiptIdentifier: input.receiptIdentifier,
      transactionAmount: input.transactionAmount,
      isDuplicateCrossUser: dupCheck.isDuplicate,
      typingDurationMs: input.typingDurationMs,
      receiptInputMethod: input.receiptInputMethod,
    }, preFetchedRisk);

    // Progressive controls use the stored score (before this submission's delta).
    // Score is NOT updated yet — "image required" and throttle are gates, not penalties.
    // Updating the score before these checks would punish the user for retrying.
    const storedScore = riskEval.totalScore - riskEval.delta;

    // High risk (stored >=15): throttle to 1 submission per 24 hours (distinct receipts)
    if (storedScore >= RISK_THRESHOLDS.MEDIUM_MAX + 1) {
      const throttleCheck = await client.query(
        `SELECT COUNT(DISTINCT receipt_identifier) AS count FROM ticket
         WHERE activated_by_user_id = $1 AND entry_source = 'receipt'
           AND receipt_identifier IS NOT NULL
           AND activated_at >= NOW() - INTERVAL '24 hours'`,
        [userId],
      );
      if (parseInt(throttleCheck.rows[0].count, 10) >= 1) {
        throw new Error("You've reached your daily entry limit. Please try again tomorrow.");
      }
    }

    // Medium or high risk (stored >=10): receipt image is required
    // Throw before updating score — the retry with an image should not be penalised
    if (storedScore > RISK_THRESHOLDS.LOW_MAX && !input.receiptImageUrl) {
      throw new Error('A receipt image is required to submit an entry.');
    }

    // Past the gates — persist the risk delta, then sync quarantine.
    // Sync here ensures existing tickets are quarantined immediately if this
    // submission's delta pushes the user into HIGH risk, even if we throw below.
    await updateUserRiskScore(userId, riskEval.delta, client, riskEval.flags);
    await syncUserQuarantineState(userId, drawId, client);

    // Hard block on sequential identifier guessing — elevated from advisory signal to immediate block.
    // Risk delta is already persisted above so the score increase survives this throw.
    if (riskEval.flags.includes('sequential_guessing')) {
      throw new Error('Suspicious sequential receipt pattern detected. Please contact support if this is in error.');
    }

    // Block cross-user duplicate only when the existing entry is active (not quarantined).
    // A quarantined entry is effectively disqualified — the receipt is unclaimed again and
    // the next person with the real receipt can use it. This prevents scammers from
    // poisoning a receipt by submitting it into a quarantined state via high risk score.
    if (dupCheck.isDuplicate) {
      throw new Error('This receipt has already been used for an entry.');
    }

    // Block same-user re-submit — penalty for trying.
    // IMPORTANT: do NOT call updateUserRiskScore/syncUserQuarantineState here via pool while
    // client holds the user row lock (from the updateUserRiskScore call above using client).
    // Doing so deadlocks: client waits for pool, pool waits for client's row lock.
    // Instead, signal the penalty via a variable and apply it in the catch block after ROLLBACK.
    const existingEntry = await client.query(
      `SELECT id FROM ticket WHERE business_id = $1 AND receipt_identifier = $2`,
      [business_id, input.receiptIdentifier],
    );
    if (existingEntry.rows.length > 0) {
      duplicatePenalty = true;
      throw new Error('This receipt identifier has already been used.');
    }

    // Start batch size from what the amount earns, then narrow by each cap
    let batchSize = entryCount;

    // Narrow by user draw cap
    batchSize = Math.min(batchSize, remainingDrawEntries);

    // Entry cap enforcement — quarantined tickets do not consume the cap
    if (entry_cap !== null && countsAgainstCap(riskEval, dupCheck.isDuplicate)) {
      const bizCapCheck = await client.query(
        `SELECT COUNT(*) AS count FROM ticket
         WHERE business_id = $1 AND draw_id = $2 AND is_quarantined = FALSE`,
        [business_id, drawId],
      );
      const bizCurrentCount = parseInt(bizCapCheck.rows[0].count, 10);
      const remainingBizEntries = entry_cap - bizCurrentCount;
      if (remainingBizEntries <= 0) {
        throw new Error('This business has reached its entry cap for the current draw.');
      }
      batchSize = Math.min(batchSize, remainingBizEntries);
    }

    // Always insert at least 1 if we passed all checks
    batchSize = Math.max(batchSize, 1);

    const isHighRisk = riskEval.totalScore > RISK_THRESHOLDS.MEDIUM_MAX;
    // Medium-risk users' ticket is held quarantined until OCR passes.
    const isMediumRisk = riskEval.totalScore > RISK_THRESHOLDS.LOW_MAX && !isHighRisk;
    const hasImage = !!input.receiptImageUrl;
    const isOcrPending = isMediumRisk && hasImage;
    const isQuarantined = isHighRisk || isOcrPending;
    const quarantineReason = isHighRisk ? 'high_risk_user' : isOcrPending ? 'ocr_pending' : null;
    const quarantinedAt = isQuarantined ? new Date() : null;

    // Generate all codes at once and check uniqueness in one query (saves batchSize-1 round trips)
    const candidateCodes: string[] = [];
    for (let i = 0; i < batchSize; i++) {
      let c = '';
      for (let j = 0; j < 8; j++) c += CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)];
      candidateCodes.push(c);
    }
    const conflictRes = await client.query(
      `SELECT code FROM ticket WHERE code = ANY($1::text[])`,
      [candidateCodes],
    );
    const conflicting = new Set<string>(conflictRes.rows.map((r: any) => r.code as string));
    const uniqueCodes: string[] = [];
    for (const c of candidateCodes) {
      uniqueCodes.push(conflicting.has(c) ? await generateGlobalUniqueCode(client) : c);
    }

    const insertedTickets: Array<{ ticketId: number; code: string }> = [];
    for (let i = 0; i < batchSize; i++) {
      const ticketCode = uniqueCodes[i];
      let ticketInsert;
      try {
        ticketInsert = await client.query(
          `INSERT INTO ticket
            (code, status, entry_source, business_id, location_id, draw_id,
             activated_by_user_id, activated_at,
             receipt_identifier, transaction_amount, transaction_date, receipt_image_url, risk_score, risk_score_delta,
             is_quarantined, quarantine_reason, quarantined_at, image_validation_status, submitter_ip, risk_flags,
             anchor_ticket_id)
           VALUES ($1, 'Activated', 'receipt', $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           RETURNING id`,
          [
            ticketCode,
            business_id,
            input.locationId,
            drawId,
            userId,
            i === 0 ? input.receiptIdentifier : null,
            input.transactionAmount,
            input.transactionDate ?? null,
            i === 0 ? (input.receiptImageUrl ?? null) : null,
            riskEval.totalScore,
            i === 0 ? riskEval.delta : 0,
            isQuarantined,
            quarantineReason,
            quarantinedAt,
            i === 0 && hasImage ? 'pending' : 'not_required',
            input.submitterIp ?? null,
            i === 0 ? riskEval.flags : [],
            i === 0 ? null : insertedTickets[0].ticketId, // siblings link back to anchor
          ],
        );
      } catch (insertErr: any) {
        // PostgreSQL unique constraint violation — receipt was already submitted
        if (insertErr?.code === '23505') {
          throw new Error('This receipt has already been submitted.');
        }
        throw insertErr;
      }
      insertedTickets.push({ ticketId: ticketInsert.rows[0].id, code: ticketCode });
    }

    await client.query('COMMIT');

    // Trigger async OCR validation — runs after commit, never blocks the response
    if (input.receiptImageUrl) {
      validateReceiptAsync(
        insertedTickets[0].ticketId,
        userId,
        drawId,
        input.receiptImageUrl,
        {
          identifier: input.receiptIdentifier,
          amount: input.transactionAmount,
          date: input.transactionDate,
          businessName: business_name,
        },
      );
    }

    return { tickets: insertedTickets, entryCount: batchSize };
  } catch (err) {
    await client.query('ROLLBACK');
    // Apply same-user duplicate penalty now that the client lock is released.
    if (duplicatePenalty) {
      try {
        await updateUserRiskScore(userId, 4);
        await syncUserQuarantineState(userId, drawId);
      } catch (penaltyErr) {
        console.error('[submitReceiptEntryService] Failed to apply duplicate penalty:', penaltyErr);
      }
    }
    throw err;
  } finally {
    client.release();
  }
};

export const activatePromotionalEntry = async (
  userId: number,
  code: string,
): Promise<{ entryId: number; drawName: string }> => {
  const pool = getPool();
  const client = await pool.connect();
  const normalizedCode = code.toUpperCase().trim();

  try {
    await client.query('BEGIN');

    // User-level lock prevents two simultaneous promo-code requests from the
    // same user (with different codes) both reading count=0 and both succeeding.
    // Acquired before the code-level lock to enforce a consistent lock ordering.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('usr_promo_' || $1::text))`,
      [userId],
    );

    // Advisory lock keyed on the promo code prevents the max_uses race condition:
    // two concurrent 100th-user requests would otherwise both read use_count=99,
    // both pass the cap check, and both insert.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1::text))`,
      [`promo_code_${normalizedCode}`],
    );

    // Validate the code exists in the admin-created registry and is active.
    // This prevents users from fabricating codes by changing the URL parameter.
    const codeCheck = await client.query(
      `SELECT pc.id, pc.max_uses, COUNT(pe.id)::int AS use_count
       FROM promotional_code pc
       LEFT JOIN promotional_entry pe ON pe.code = pc.code
       WHERE pc.code = $1 AND pc.is_active = true
       GROUP BY pc.id`,
      [normalizedCode],
    );
    if (codeCheck.rows.length === 0) {
      throw new Error('This promotional code is not valid or has expired.');
    }
    const { max_uses, use_count } = codeCheck.rows[0];
    if (max_uses !== null && use_count >= max_uses) {
      throw new Error('This promotional code has reached its maximum number of uses.');
    }

    // Find the current open draw
    const drawResult = await client.query(
      `SELECT id, name FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1`,
    );
    if (drawResult.rows.length === 0) {
      throw new Error('There is no active campaign at the moment. Please try again later.');
    }
    const draw = drawResult.rows[0];

    // One promo code per user per draw
    const promoCountResult = await client.query(
      `SELECT COUNT(*)::int AS count FROM promotional_entry WHERE user_id = $1 AND draw_id = $2`,
      [userId, draw.id],
    );
    if (parseInt(promoCountResult.rows[0].count, 10) >= 1) {
      throw new Error('You can only use one promotional code per campaign.');
    }

    // Per-draw per-user cap — counts non-quarantined tickets + all promo entries
    const capResult = await client.query(
      `SELECT (
         (SELECT COUNT(*)::int FROM ticket WHERE activated_by_user_id = $1 AND draw_id = $2 AND is_quarantined = FALSE)
         + (SELECT COUNT(*)::int FROM promotional_entry WHERE user_id = $1 AND draw_id = $2)
       ) AS total_count`,
      [userId, draw.id],
    );
    if (parseInt(capResult.rows[0].total_count, 10) >= 30) {
      throw new Error('You have reached the maximum of 30 entries for this campaign.');
    }

    // Insert — the UNIQUE(code, user_id) constraint rejects duplicate use per account
    let result;
    try {
      result = await client.query(
        `INSERT INTO promotional_entry (code, user_id, draw_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [normalizedCode, userId, draw.id],
      );
    } catch (err: any) {
      if (err.code === '23505') {
        throw new Error('You have already used this promotional code.');
      }
      throw err;
    }

    await client.query('COMMIT');
    return { entryId: result.rows[0].id, drawName: draw.name };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const generateTicketService = async (user_id: number, location_id: number) => {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const authInfo = await client.query(`
      SELECT bl.business_id, bl.id as location_id, s.entries_per_location
      FROM business_location bl
      JOIN business b ON bl.business_id = b.id
      JOIN subscription s ON s.business_id = b.id AND s.status IN ('Active', 'Trialing')
      WHERE bl.id = $1
        AND (b.user_id = $2 OR bl.manager_user_id = $2)
        AND bl.is_active = true
        AND EXISTS (
          SELECT 1 FROM draw_entry de
          JOIN draw d ON d.id = de.draw_id
          WHERE de.business_id = b.id AND d.status IN ('Open', 'Upcoming')
        )
    `, [location_id, user_id]);

    if (authInfo.rows.length === 0) {
      throw new Error('Unauthorized or inactive location. Ticket cannot be issued.');
    }

    const { business_id, entries_per_location } = authInfo.rows[0];
    const entry_cap: number | null = entries_per_location != null ? Number(entries_per_location) : null;

    const drawInfo = await client.query(`
      SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1
    `);

    if (drawInfo.rows.length === 0) throw new Error('No active campaign found. Please contact admin.');
    const drawId = drawInfo.rows[0].id;

    // Entry cap enforcement — NULL cap means unlimited (MVP default)
    // Quarantined tickets do not consume the cap
    if (entry_cap !== null) {
      const capCheck = await client.query(
        `SELECT COUNT(*) AS count FROM ticket
         WHERE business_id = $1 AND draw_id = $2 AND is_quarantined = FALSE`,
        [business_id, drawId],
      );
      if (parseInt(capCheck.rows[0].count) >= entry_cap) {
        throw new Error('Entry cap reached for this business in the current draw.');
      }
    }

    const code = await generateGlobalUniqueCode(client);

    await client.query(`
      INSERT INTO ticket (code, status, entry_source, business_id, location_id, draw_id, created_at)
      VALUES ($1, 'Issued', 'code', $2, $3, $4, NOW())
    `, [code, business_id, location_id, drawId]);

    await client.query('COMMIT');
    return { code };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
