import { getPool, PoolClient } from '../../shared/db/db.js';
import crypto from 'crypto';
import {
  ActivationResult,
  FreeTicketStatus,
  ITicket,
  ReceiptEntryInput,
} from './tickets.types.js';
import {
  evaluateUserRisk,
  updateUserRiskScore,
  checkDuplicateReceiptIdentifier,
  countsAgainstCap,
  syncUserQuarantineState,
} from '../risk/risk.service.js';
import { RISK_THRESHOLDS } from '../risk/risk.types.js';
import { validateReceiptAsync } from '../ocr/ocr.service.js';

export const activateTicket = async (code: string, userId: number) => {
  const pool = getPool();

  const checkResult = await pool.query(`
    SELECT t.id, t.status, t.business_id, t.location_id, d.status as draw_status
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
  return result.rows;
};

export const getBusinessTicketsService = async (userId: number, drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      t.id,
      t.code,
      t.status,
      t.activated_at,
      bl.name as location_name,
      u.full_name as activated_by_user,
      u.email as activated_by_email
    FROM ticket t
    INNER JOIN business b ON t.business_id = b.id
    LEFT JOIN business_location bl ON t.location_id = bl.id
    LEFT JOIN "user" u ON t.activated_by_user_id = u.id
    WHERE b.user_id = $1
    AND t.draw_id = $2
    ORDER BY t.created_at DESC
  `, [userId, drawId]);
  return result.rows;
};

export const getLocationTicketsService = async (userId: number, drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      t.id,
      t.code,
      t.status,
      t.activated_at,
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

  const result = await pool.query(`
    SELECT activated_at
    FROM free_ticket_usage
    WHERE user_id = $1
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

export const activateFreeTicket = async (userId: number): Promise<ActivationResult> => {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Advisory lock scoped to this user's free ticket claim — prevents double-claim on empty table.
    // Lock is acquired atomically within the same query as the eligibility check to avoid an
    // extra round-trip. LEFT JOIN ensures one row is always returned (activated_at = NULL when
    // no prior usage exists), which is equivalent to the original behaviour.
    const eligibilityResult = await client.query(`
      SELECT u.activated_at
      FROM (SELECT pg_advisory_xact_lock($1)) AS _lock
      LEFT JOIN LATERAL (
        SELECT activated_at FROM free_ticket_usage WHERE user_id = $1
        ORDER BY activated_at DESC LIMIT 1
      ) AS u ON true
    `, [userId]);

    const lastUsage = eligibilityResult.rows[0];
    if (lastUsage) {
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
      throw new Error('No active draw found. Please try again later.');
    }

    await client.query(
      `INSERT INTO free_ticket_usage (user_id, draw_id, status, entries_created) VALUES ($1, $2, 'approved', 1)`,
      [userId, activeDrawId]
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
): Promise<{ ticketId: number; code: string }> => {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Email verification gate — unverified accounts cannot submit entries
    const verifiedResult = await client.query(
      `SELECT is_email_verified FROM "user" WHERE id = $1`,
      [userId],
    );
    if (!verifiedResult.rows[0]?.is_email_verified) {
      throw new Error('Please verify your email address before submitting entries.');
    }

    // Resolve business from location and verify it is active + participating
    const bizResult = await client.query(
      `SELECT b.id AS business_id, b.name AS business_name, b.entry_cap, b.min_transaction_amount
       FROM business_location bl
       JOIN business b ON bl.business_id = b.id
       WHERE bl.id = $1 AND bl.is_active = true
         AND b.is_subscribed = true AND b.is_participating = true`,
      [input.locationId],
    );
    if (bizResult.rows.length === 0) {
      throw new Error('Location is not currently participating in a draw.');
    }
    const { business_id, business_name, min_transaction_amount: minTransactionAmount } = bizResult.rows[0];

    // Hard daily submission cap — prevents velocity spam regardless of risk score.
    // High-risk users are also throttled per-hour by the gate below; this is an absolute ceiling.
    const dailyCountResult = await client.query(
      `SELECT COUNT(*) AS count FROM ticket
       WHERE activated_by_user_id = $1 AND entry_source = 'receipt' AND activated_at >= NOW() - INTERVAL '24 hours'`,
      [userId],
    );
    if (parseInt(dailyCountResult.rows[0].count, 10) >= 5) {
      throw new Error('You have reached the daily receipt submission limit. Please try again tomorrow.');
    }

    // Cap is set globally by admin only
    // If the settings row is missing entirely, fall back to a safe default of 500 rather
    // than null (which would mean unlimited and could be exploited if the row is deleted).
    const settingsResult = await client.query(
      `SELECT global_entry_cap FROM platform_settings WHERE id = 1`,
    );
    const entry_cap: number | null =
      settingsResult.rows.length > 0 ? settingsResult.rows[0].global_entry_cap : 500;

    // Conflict-of-interest guard: business owners and managers cannot submit entries for their own business
    const conflictResult = await client.query(
      `SELECT 1 FROM business b
       LEFT JOIN business_location bl ON bl.business_id = b.id AND bl.id = $2
       WHERE b.id = $1 AND (b.user_id = $3 OR bl.manager_user_id = $3)
       LIMIT 1`,
      [business_id, input.locationId, userId],
    );
    if (conflictResult.rows.length > 0) {
      throw new Error('Business owners and managers cannot submit entries for their own business.');
    }

    // Find open draw early so drawId is available for quarantine syncs below
    const drawResult = await client.query(
      `SELECT id, created_at as draw_opened_at FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1`,
    );
    if (drawResult.rows.length === 0) throw new Error('No active draw found.');
    const drawId = drawResult.rows[0].id;

    // Multi-entry calculation: floor(amount / threshold), capped at 10 per receipt
    const entriesEarned = minTransactionAmount
      ? Math.min(Math.floor(input.transactionAmount / minTransactionAmount), 10)
      : 1;

    if (entriesEarned < 1) {
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
      const drawOpenedAt = new Date(drawResult.rows[0].draw_opened_at);
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

    // Evaluate risk for this submission
    const riskEval = await evaluateUserRisk(userId, {
      businessId: business_id,
      receiptIdentifier: input.receiptIdentifier,
      transactionAmount: input.transactionAmount,
      isDuplicateCrossUser: dupCheck.isDuplicate,
      typingDurationMs: input.typingDurationMs,
      receiptInputMethod: input.receiptInputMethod,
    });

    // Progressive controls use the stored score (before this submission's delta).
    // Score is NOT updated yet — "image required" and throttle are gates, not penalties.
    // Updating the score before these checks would punish the user for retrying.
    const storedScore = riskEval.totalScore - riskEval.delta;

    // High risk (stored >=15): throttle to 1 submission per 24 hours
    if (storedScore >= RISK_THRESHOLDS.MEDIUM_MAX + 1) {
      const throttleCheck = await client.query(
        `SELECT COUNT(*) AS count FROM ticket
         WHERE activated_by_user_id = $1 AND entry_source = 'receipt' AND activated_at >= NOW() - INTERVAL '24 hours'`,
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
    await updateUserRiskScore(userId, riskEval.delta, client);
    await syncUserQuarantineState(userId, drawId, client);

    // Hard block on sequential identifier guessing — elevated from advisory signal to immediate block.
    // Risk delta is already persisted above so the score increase survives this throw.
    if (riskEval.flags.includes('sequential_guessing')) {
      throw new Error('Suspicious sequential receipt pattern detected. Please contact support if this is in error.');
    }

    // Block cross-user duplicate and immediately quarantine the original submitter's ticket.
    // Any second-user attempt on the same receipt is a sharing signal regardless of intent.
    // The original ticket is held for manual review — if legitimate, an admin can release it.
    if (dupCheck.isDuplicate) {
      await client.query(
        `UPDATE ticket
         SET is_quarantined = TRUE, quarantine_reason = 'shared_receipt_suspected', quarantined_at = NOW()
         WHERE business_id = $1 AND receipt_identifier = $2 AND is_quarantined = FALSE`,
        [business_id, input.receiptIdentifier],
      );
      throw new Error('This receipt has already been used for an entry.');
    }

    // Block same-user re-submit — penalty for trying.
    // Uses pool directly so the +4 penalty persists even though this throw causes a ROLLBACK.
    const existingEntry = await client.query(
      `SELECT id FROM ticket WHERE business_id = $1 AND receipt_identifier = $2`,
      [business_id, input.receiptIdentifier],
    );
    if (existingEntry.rows.length > 0) {
      await updateUserRiskScore(userId, 4);
      await syncUserQuarantineState(userId, drawId);
      throw new Error('This receipt identifier has already been used.');
    }

    // Entry cap enforcement — quarantined tickets do not consume the cap
    // Account for all N entries atomically
    if (entry_cap !== null && countsAgainstCap(riskEval, dupCheck.isDuplicate)) {
      const capCheck = await client.query(
        `SELECT COUNT(*) AS count FROM ticket
         WHERE business_id = $1 AND draw_id = $2 AND is_quarantined = FALSE`,
        [business_id, drawId],
      );
      const currentCount = parseInt(capCheck.rows[0].count, 10);
      if (currentCount + entriesEarned > entry_cap) {
        throw new Error('This business has reached its entry cap for the current draw.');
      }
    }

    const isHighRisk = riskEval.totalScore > RISK_THRESHOLDS.MEDIUM_MAX;
    // Medium-risk users' primary receipt ticket is held quarantined until OCR passes.
    // This prevents medium-risk users from benefiting from a receipt before it is verified.
    const isMediumRisk = riskEval.totalScore > RISK_THRESHOLDS.LOW_MAX && !isHighRisk;

    // Insert one ticket row per entry earned (multi-entry support)
    // Only the first ticket carries the receipt fields; subsequent entries share the receipt identifier
    let firstTicketId: number = 0;
    let firstCode = '';
    for (let i = 0; i < entriesEarned; i++) {
      const isPrimary = i === 0;
      const hasImage = isPrimary && !!input.receiptImageUrl;

      // Determine quarantine state for this row
      // - High risk: always quarantined
      // - Medium risk + primary entry with image: quarantined as ocr_pending until OCR passes
      // - All others: not quarantined
      const isOcrPending = isMediumRisk && hasImage;
      const isQuarantined = isHighRisk || isOcrPending;
      const quarantineReason = isHighRisk ? 'high_risk_user' : isOcrPending ? 'ocr_pending' : null;
      const quarantinedAt = isQuarantined ? new Date() : null;

      const code = await generateGlobalUniqueCode(client);
      let ticketResult;
      try {
        ticketResult = await client.query(
          `INSERT INTO ticket
            (code, status, entry_source, business_id, location_id, draw_id,
             activated_by_user_id, activated_at,
             receipt_identifier, transaction_amount, transaction_date, receipt_image_url, risk_score,
             is_quarantined, quarantine_reason, quarantined_at, image_validation_status, submitter_ip)
           VALUES ($1, 'Activated', 'receipt', $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING id`,
          [
            code,
            business_id,
            input.locationId,
            drawId,
            userId,
            isPrimary ? input.receiptIdentifier : null,
            isPrimary ? input.transactionAmount : null,
            isPrimary ? (input.transactionDate ?? null) : null,
            isPrimary ? (input.receiptImageUrl ?? null) : null,
            riskEval.totalScore,
            isQuarantined,
            quarantineReason,
            quarantinedAt,
            hasImage ? 'pending' : 'not_required',
            input.submitterIp ?? null,
          ],
        );
      } catch (insertErr: any) {
        // PostgreSQL unique constraint violation — receipt was already submitted
        if (insertErr?.code === '23505') {
          throw new Error('This receipt has already been submitted.');
        }
        throw insertErr;
      }
      if (isPrimary) {
        firstTicketId = ticketResult.rows[0].id;
        firstCode = code;
      }
    }

    // Sync quarantine in case score decayed below 15 after the clean-entry update above
    await syncUserQuarantineState(userId, drawId, client);

    await client.query('COMMIT');

    // Trigger async OCR validation on the first ticket — runs after commit, never blocks the response
    if (input.receiptImageUrl) {
      validateReceiptAsync(
        firstTicketId,
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

    return { ticketId: firstTicketId, code: firstCode };
  } catch (err) {
    await client.query('ROLLBACK');
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
      throw new Error('There is no active draw at the moment. Please try again later.');
    }
    const draw = drawResult.rows[0];

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
      SELECT bl.business_id, bl.id as location_id, b.entry_cap
      FROM business_location bl
      JOIN business b ON bl.business_id = b.id
      WHERE bl.id = $1
        AND (b.user_id = $2 OR bl.manager_user_id = $2)
        AND bl.is_active = true
        AND b.is_subscribed = true
        AND b.is_participating = true
    `, [location_id, user_id]);

    if (authInfo.rows.length === 0) {
      throw new Error('Unauthorized or inactive location. Ticket cannot be issued.');
    }

    const { business_id, entry_cap } = authInfo.rows[0];

    const drawInfo = await client.query(`
      SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1
    `);

    if (drawInfo.rows.length === 0) throw new Error('No active draw found. Please contact admin.');
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
