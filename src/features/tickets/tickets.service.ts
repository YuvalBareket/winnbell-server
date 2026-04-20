import { getPool, PoolClient } from '../../shared/db/db.js';
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
    JOIN draw d ON t.draw_id = d.id
    WHERE t.code = $1
  `, [code]);

  const ticket = checkResult.rows[0];
  if (!ticket) throw new Error('Invalid ticket code.');
  if (ticket.draw_status?.toUpperCase() !== 'OPEN') throw new Error('The draw for this ticket is already closed.');

  const ownerCheck = await pool.query(
    `SELECT 1 FROM business b
     LEFT JOIN business_location bl ON bl.business_id = b.id
     WHERE (b.id = $1 OR bl.id = $2) AND (b.user_id = $3 OR bl.manager_user_id = $3)
     LIMIT 1`,
    [ticket.business_id, ticket.location_id, userId],
  );
  if (ownerCheck.rows.length > 0) {
    throw new Error('Business owners and managers cannot activate tickets for their own business.');
  }

  const updateResult = await pool.query(`
    UPDATE ticket
    SET status = 'Activated',
        activated_by_user_id = $1,
        activated_at = NOW()
    WHERE code = $2 AND status = 'Issued'
  `, [userId, code]);

  if (updateResult.rowCount === 0) throw new Error('This ticket has already been used.');

  return { message: 'Ticket activated successfully!' };
};

export const getUserTicketsService = async (userId: number, drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      t.id, t.code, t.status, t.activated_at,
      b.name as business_name, b.sector as business_sector, b.logo_url,
      bl.name as location_name,
      d.name as draw_name
    FROM ticket t
    LEFT JOIN business b ON t.business_id = b.id
    LEFT JOIN business_location bl ON t.location_id = bl.id
    JOIN draw d ON t.draw_id = d.id
    WHERE t.activated_by_user_id = $1
    AND t.draw_id = $2
    ORDER BY t.activated_at DESC
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

export const generateGlobalUniqueCode = async (client?: PoolClient): Promise<string> => {
  const MAX_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = Math.random().toString(36).substring(2, 10).toUpperCase();
    if (code.length !== 8) continue;

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

    // Check eligibility with FOR UPDATE to prevent concurrent activations
    const eligibilityResult = await client.query(`
      SELECT activated_at
      FROM free_ticket_usage
      WHERE user_id = $1
      ORDER BY activated_at DESC
      LIMIT 1
      FOR UPDATE
    `, [userId]);

    const lastUsage = eligibilityResult.rows[0];
    if (lastUsage) {
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      weekStart.setHours(0, 0, 0, 0);
      const usedThisWeek = new Date(lastUsage.activated_at) >= weekStart;
      if (usedThisWeek) throw new Error('Weekly limit reached. Please wait until your next available date.');
    }

    const drawResult = await client.query(`
      SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1
    `);

    const activeDrawId = drawResult.rows[0]?.id;
    if (!activeDrawId) throw new Error('No active draw found. Please try again later.');

    await client.query(`INSERT INTO free_ticket_usage (user_id) VALUES ($1)`, [userId]);

    const ticketCode = await generateGlobalUniqueCode(client);

    const ticketResult = await client.query(`
      INSERT INTO ticket (code, status, business_id, activated_by_user_id, draw_id, activated_at)
      VALUES ($1, 'Activated', NULL, $2, $3, NOW())
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
      `SELECT b.id AS business_id, b.entry_cap, b.min_transaction_amount
       FROM business_location bl
       JOIN business b ON bl.business_id = b.id
       WHERE bl.id = $1 AND bl.is_active = true
         AND b.is_subscribed = true AND b.is_participating = true`,
      [input.locationId],
    );
    if (bizResult.rows.length === 0) {
      throw new Error('Location is not currently participating in a draw.');
    }
    const { business_id, entry_cap, min_transaction_amount: minTransactionAmount } = bizResult.rows[0];

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
      `SELECT id, created_at as draw_opened_at FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1 FOR UPDATE`,
    );
    if (drawResult.rows.length === 0) throw new Error('No active draw found.');
    const drawId = drawResult.rows[0].id;

    if (minTransactionAmount !== null && input.transactionAmount < minTransactionAmount) {
      throw new Error(`Transaction amount does not meet the minimum required amount.`);
    }

    // Transaction date validation against draw period
    if (input.transactionDate) {
      const txDate = new Date(input.transactionDate);
      const drawOpenedAt = new Date(drawResult.rows[0].draw_opened_at);
      const now = new Date();
      if (txDate < drawOpenedAt || txDate > now) {
        throw new Error('Transaction date must fall within the current campaign period.');
      }
    }

    // Check cross-user duplicate (used as both a risk signal and a block)
    const dupCheck = await checkDuplicateReceiptIdentifier(
      business_id,
      input.receiptIdentifier,
      userId,
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
         WHERE activated_by_user_id = $1 AND entry_source = 'receipt' AND activated_at >= NOW() - INTERVAL '1 hour'`,
        [userId],
      );
      if (parseInt(throttleCheck.rows[0].count, 10) >= 1) {
        throw new Error("You've reached your hourly entry limit. Please try again in an hour.");
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

    // Block cross-user duplicate
    if (dupCheck.isDuplicate) {
      // If 3+ distinct users have attempted this identifier, flag the original ticket for manual review
      const dupCountResult = await client.query(
        `SELECT COUNT(DISTINCT activated_by_user_id) AS dup_count FROM ticket
         WHERE business_id = $1 AND receipt_identifier = $2`,
        [business_id, input.receiptIdentifier],
      );
      const dupCount = parseInt(dupCountResult.rows[0].dup_count, 10);
      if (dupCount >= 3) {
        await client.query(
          `UPDATE ticket SET is_quarantined = TRUE, quarantine_reason = 'shared_receipt_suspected', quarantined_at = NOW()
           WHERE business_id = $1 AND receipt_identifier = $2 AND is_quarantined = FALSE`,
          [business_id, input.receiptIdentifier],
        );
      }
      throw new Error('This receipt has already been used for an entry.');
    }

    // Block same-user re-submit — penalty for trying
    const existingEntry = await client.query(
      `SELECT id FROM ticket WHERE business_id = $1 AND receipt_identifier = $2`,
      [business_id, input.receiptIdentifier],
    );
    if (existingEntry.rows.length > 0) {
      await updateUserRiskScore(userId, 4, client);
      await syncUserQuarantineState(userId, drawId, client);
      throw new Error('This receipt identifier has already been used.');
    }

    // Entry cap enforcement — quarantined tickets do not consume the cap
    if (entry_cap !== null && countsAgainstCap(riskEval, dupCheck.isDuplicate)) {
      const capCheck = await client.query(
        `SELECT COUNT(*) AS count FROM ticket
         WHERE business_id = $1 AND draw_id = $2 AND is_quarantined = FALSE`,
        [business_id, drawId],
      );
      if (parseInt(capCheck.rows[0].count, 10) >= entry_cap) {
        throw new Error('This business has reached its entry cap for the current draw.');
      }
    }

    // Generate internal reference code
    const code = await generateGlobalUniqueCode(client);

    const isHighRisk = riskEval.totalScore > RISK_THRESHOLDS.MEDIUM_MAX;

    const ticketResult = await client.query(
      `INSERT INTO ticket
        (code, status, entry_source, business_id, location_id, draw_id,
         activated_by_user_id, activated_at,
         receipt_identifier, transaction_amount, transaction_date, receipt_image_url, risk_score,
         is_quarantined, quarantine_reason, quarantined_at, image_validation_status)
       VALUES ($1, 'Activated', 'receipt', $2, $3, $4, $5, NOW(), $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        code,
        business_id,
        input.locationId,
        drawId,
        userId,
        input.receiptIdentifier,
        input.transactionAmount,
        input.transactionDate ?? null,
        input.receiptImageUrl ?? null,
        riskEval.totalScore,
        isHighRisk,
        isHighRisk ? 'high_risk_user' : null,
        isHighRisk ? new Date() : null,
        input.receiptImageUrl ? 'pending' : 'not_required',
      ],
    );

    // Sync quarantine in case score decayed below 15 after the clean-entry update above
    await syncUserQuarantineState(userId, drawId, client);

    await client.query('COMMIT');

    // Trigger async OCR validation — runs after commit, never blocks the response
    if (input.receiptImageUrl) {
      validateReceiptAsync(
        ticketResult.rows[0].id,
        userId,
        drawId,
        input.receiptImageUrl,
        {
          identifier: input.receiptIdentifier,
          amount: input.transactionAmount,
          date: input.transactionDate,
        },
      );
    }

    return { ticketId: ticketResult.rows[0].id, code };
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
