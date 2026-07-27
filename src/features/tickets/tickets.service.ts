import { getPool, PoolClient } from '../../shared/db/db.js';
import { OPEN_DRAW_ID_SUBQUERY, getOpenDrawId } from '../../shared/db/queries.js';
import crypto from 'crypto';
import { invalidatePublicLocation } from '../../shared/cache/cache.js';
import {
  ActivationResult,
  FreeTicketStatus,
  ReceiptEntryInput,
} from './tickets.types.js';

const MAX_ENTRIES_PER_RECEIPT = 3;
// Hard per-user cap on total entries in a single draw, across ALL entry types
// (free weekly, receipt, promo, referral). Change here only (client mirrors it
// in its own constant). This is a legal/fairness limit and must never be exceeded.
export const MAX_ENTRIES_PER_DRAW = 30;
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
import { isDemoResetEnabled } from '../../shared/demo.js'; // TEMPORARY: staging demo reset only

export const getUserTicketsService = async (userId: number, drawId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT
      t.id,
      t.code,
      t.status,
      t.activated_at,
      CASE WHEN t.entry_source = 'promo' THEN 'Promotional Entry'
           WHEN t.entry_source = 'referral' THEN 'Invitation Entry'
           WHEN t.entry_source = 'free' THEN 'Weekly Entry'
           ELSE b.name END AS business_name,
      b.sector AS business_sector,
      b.logo_url,
      t.location_id,
      bl.name AS location_name,
      d.name  AS draw_name
    FROM ticket t
    LEFT JOIN business b ON t.business_id = b.id
    LEFT JOIN business_location bl ON t.location_id = bl.id
    JOIN draw d ON t.draw_id = d.id
    WHERE t.activated_by_user_id = $1
      AND t.draw_id = $2
    ORDER BY t.activated_at DESC
  `, [userId, drawId]);

  // Effective count: the query has no LIMIT (a user is capped at 30 entries per draw),
  // so it always returns the full set — the count is just the rows we already fetched.
  // No second COUNT round-trip needed.
  const totalCount: number = result.rows.length;

  return { tickets: result.rows, totalCount };
};

export const getBusinessTicketsService = async (userId: number, drawId: number, locationId?: number, page = 1, limit = 50) => {
  const pool = getPool();
  const offset = (page - 1) * limit;

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
  ticketParams.push(limit, offset);
  const limitClause = `LIMIT $${ticketParams.length - 1} OFFSET $${ticketParams.length}`;
  const result = await pool.query(
    `SELECT t.id, t.code, t.status, t.activated_at, t.is_quarantined,
            bl.name AS location_name
     FROM ticket t
     INNER JOIN business b ON t.business_id = b.id
     LEFT JOIN business_location bl ON t.location_id = bl.id
     WHERE b.user_id = $1 AND t.draw_id = $2 AND t.is_quarantined = FALSE ${locationClause}
     ORDER BY t.created_at DESC ${limitClause}`,
    ticketParams,
  );

  return { tickets: result.rows, totalCount, cap, perLocationCap, activeLocationCount };
};

export const getLocationTicketsService = async (userId: number, drawId: number, page = 1, limit = 50) => {
  const pool = getPool();
  const offset = (page - 1) * limit;

  const capRes = await pool.query(
    `SELECT COALESCE(s.entries_per_location, ps.global_entry_cap) AS per_location_cap
     FROM business_location bl
     JOIN business b ON b.id = bl.business_id
     LEFT JOIN subscription s ON s.business_id = b.id
     LEFT JOIN platform_settings ps ON ps.id = 1
     WHERE bl.manager_user_id = $1
     LIMIT 1`,
    [userId],
  );
  const perLocationCap: number | null = capRes.rows[0]?.per_location_cap != null
    ? Number(capRes.rows[0].per_location_cap)
    : null;

  // Total count (full result set) drives the client's "load more" stop condition.
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total_count
     FROM ticket t
     INNER JOIN business_location bl ON t.location_id = bl.id
     WHERE bl.manager_user_id = $1 AND t.draw_id = $2 AND t.is_quarantined = FALSE`,
    [userId, drawId],
  );
  const totalCount: number = Number(countRes.rows[0]?.total_count ?? 0);

  const result = await pool.query(`
    SELECT
      t.id,
      t.code,
      t.status,
      t.activated_at,
      t.is_quarantined,
      bl.name as location_name
    FROM ticket t
    INNER JOIN business_location bl ON t.location_id = bl.id
    WHERE bl.manager_user_id = $1
    AND t.draw_id = $2
    AND t.is_quarantined = FALSE
    ORDER BY t.created_at DESC
    LIMIT $3 OFFSET $4
  `, [userId, drawId, limit, offset]);

  return { tickets: result.rows, totalCount, perLocationCap };
};

export const checkFreeTicketEligibility = async (userId: number): Promise<FreeTicketStatus> => {
  const pool = getPool();

  // Check for an open draw first — no point showing READY if there's no campaign
  const drawResult = await pool.query(`SELECT id FROM draw WHERE status = 'Open' LIMIT 1`);
  if (!drawResult.rows[0]) {
    return { canActivate: false, reason: 'no_campaign' };
  }

  // Week boundary is the ET Sunday-start week (must match the activation guard in
  // activateFreeTicket exactly, or the UI would show READY and then the claim would be rejected).
  const result = await pool.query(`
    SELECT
      u.activated_at,
      (u.activated_at >= ws.week_start)            AS used_this_week,
      (ws.week_start + interval '7 days')          AS next_available
    FROM (
      SELECT (date_trunc('week', ((now() AT TIME ZONE 'America/New_York') + interval '1 day'))
              - interval '1 day') AT TIME ZONE 'America/New_York' AS week_start
    ) ws
    LEFT JOIN LATERAL (
      SELECT activated_at FROM free_ticket_usage
      WHERE user_id = $1 AND status = 'approved'
      ORDER BY activated_at DESC LIMIT 1
    ) u ON true
  `, [userId]);

  const row = result.rows[0];
  if (!row?.activated_at) return { canActivate: true };
  if (!row.used_this_week) return { canActivate: true };

  return { canActivate: false, nextAvailableDate: row.next_available };
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

    // Advisory lock scoped to this user's free ticket claim — prevents double-claim race condition.
    // Must be a standalone query so PostgreSQL serializes concurrent requests before the eligibility check.
    await client.query('SELECT pg_advisory_xact_lock(2, $1)', [userId]);

    // "Used this week" is computed in SQL against a fixed business timezone (America/New_York),
    // NOT the server's local/UTC clock. Using the server clock let a US-evening user double-claim
    // around the Sunday-00:00-UTC boundary (Sat 8pm ET). The +1day/-1day keeps a Sunday-start week.
    const eligibilityResult = await client.query(`
      SELECT u.activated_at, usr.is_email_verified, usr.is_phone_verified, usr.created_at AS account_created_at,
        (u.activated_at >= (date_trunc('week', ((now() AT TIME ZONE 'America/New_York') + interval '1 day'))
                            - interval '1 day') AT TIME ZONE 'America/New_York') AS used_this_week
      FROM (SELECT is_email_verified, is_phone_verified, created_at FROM "user" WHERE id = $1) AS usr
      LEFT JOIN LATERAL (
        SELECT activated_at FROM free_ticket_usage WHERE user_id = $1 AND status = 'approved'
        ORDER BY activated_at DESC LIMIT 1
      ) AS u ON true
    `, [userId]);

    const lastUsage = eligibilityResult.rows[0];
    // The query is anchored on the user row, so a missing row means the user no longer exists
    // (e.g. deleted mid-session). Fail closed rather than skip the verification guards below.
    if (!lastUsage) throw new Error('User not found.');

    // Rejected attempts are NOT recorded — the user just gets the error and can retry once
    // the reason is resolved. Only an approved claim is stored (one row per user, below).

    // Guard 1: email must be verified (blocks throwaway email accounts)
    if (lastUsage && !lastUsage.is_email_verified) {
      throw new Error('Please verify your email address before claiming your weekly entry.');
    }

    // Guard 1b: phone must be verified (ties free entry to a real person)
    if (lastUsage && !lastUsage.is_phone_verified && process.env.PHONE_VERIFY_ENABLED === 'true') {
      throw new Error('PHONE_NOT_VERIFIED');
    }

    // Guard 2: weekly usage check (1 free entry per user per week, ET week boundary computed above)
    if (lastUsage?.used_this_week) {
      throw new Error('Weekly limit reached. Please wait until your next available date.');
    }


    const activeDrawId = await getOpenDrawId(client);
    if (!activeDrawId) {
      throw new Error('No active campaign found. Please try again later.');
    }

    // Shared per-user cap lock (same key as code/receipt/promo) so the 4 entry types can't
    // each slip past the per-draw cap in parallel.
    await client.query(`SELECT pg_advisory_xact_lock(10, hashtext('udcap:' || $1::text))`, [userId]);

    // Per-draw per-user cap — counts ALL the user's tickets (incl. under-review), matching
    // their visible total, so the count can never exceed the cap regardless of quarantine.
    const drawCapResult = await client.query(
      `SELECT COUNT(*)::int AS total_count FROM ticket
       WHERE activated_by_user_id = $1 AND draw_id = $2`,
      [userId, activeDrawId],
    );
    if (parseInt(drawCapResult.rows[0].total_count, 10) >= MAX_ENTRIES_PER_DRAW) {
      throw new Error(`You have reached the maximum of ${MAX_ENTRIES_PER_DRAW} entries for this draw.`);
    }

    // One row per user: insert on first-ever claim, otherwise update the approved date.
    // The weekly check only needs the latest approved timestamp, so this single row is
    // all that matters — and the table stays bounded to one row per user forever.
    await client.query(
      `INSERT INTO free_ticket_usage (user_id, draw_id, claim_ip, status, entries_created)
       VALUES ($1, $2, $3, 'approved', 1)
       ON CONFLICT (user_id) DO UPDATE
         SET draw_id          = EXCLUDED.draw_id,
             claim_ip         = EXCLUDED.claim_ip,
             status           = 'approved',
             entries_created  = 1,
             rejection_reason = NULL,
             activated_at     = NOW()`,
      [userId, activeDrawId, claimIp ?? null]
    );

    const ticketCode = await generateGlobalUniqueCode(client);

    const ticketResult = await client.query(`
      INSERT INTO ticket (code, status, entry_source, business_id, activated_by_user_id, draw_id, activated_at)
      VALUES ($1, 'Activated', 'free', NULL, $2, $3, NOW())
      RETURNING id
    `, [ticketCode, userId, activeDrawId]);

    await client.query('COMMIT');
    // Free entries have no business/location — they affect no public cache, so nothing to invalidate.

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

  try {
    await client.query('BEGIN');

    // Serialize concurrent receipt submissions from the same user so the
    // daily_count read in the preflight is never stale across parallel requests.
    await client.query(
      `SELECT pg_advisory_xact_lock(3, hashtext('usr_' || $1::text))`,
      [userId],
    );

    // Shared per-user cap lock (same key as code/free/promo). Must be held before the
    // preflight reads draw_count, so the four entry types serialize on the per-draw cap.
    await client.query(`SELECT pg_advisory_xact_lock(10, hashtext('udcap:' || $1::text))`, [userId]);

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
            -- Voluntary opt-out (founding cancel): no NEW entries at a paused business,
            -- even though its draw_entry (and already-earned customer entries) remain.
            AND NOT EXISTS (
              SELECT 1 FROM subscription sp
              WHERE sp.business_id = b.id AND sp.participation_paused = TRUE
            )
          LIMIT 1
        ),
        od AS (
          SELECT id AS draw_id, start_date AS draw_start_date
          FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1
        )
      SELECT
        (SELECT is_email_verified                FROM "user" WHERE id = $1)  AS is_email_verified,
        (SELECT is_phone_verified                FROM "user" WHERE id = $1)  AS is_phone_verified,
        (SELECT risk_score                       FROM "user" WHERE id = $1)  AS risk_score,
        (SELECT risk_last_flagged_at             FROM "user" WHERE id = $1)  AS risk_last_flagged_at,
        (SELECT risk_last_decayed_at             FROM "user" WHERE id = $1)  AS risk_last_decayed_at,
        (SELECT business_id                      FROM biz)                   AS business_id,
        (SELECT business_name                    FROM biz)                   AS business_name,
        (SELECT min_transaction_amount           FROM biz)                   AS min_transaction_amount,
        (SELECT draw_id                          FROM od)                    AS draw_id,
        (SELECT draw_start_date                  FROM od)                    AS draw_start_date,
        (SELECT EXISTS(SELECT 1 FROM platform_settings WHERE id = 1))        AS settings_exists,
        (SELECT global_entry_cap FROM platform_settings WHERE id = 1)        AS global_entry_cap,
        (SELECT s.entries_per_location FROM subscription s WHERE s.business_id = (SELECT business_id FROM biz)) AS entries_per_location,
        EXISTS (
          -- Conflict if the submitter owns the business OR manages ANY of its locations
          -- (employees cannot enter their own employer's draw, not just at their own branch).
          SELECT 1 FROM business bx
          WHERE bx.id = (SELECT business_id FROM biz)
            AND (
              bx.user_id = $1
              OR EXISTS (SELECT 1 FROM business_location blx WHERE blx.business_id = bx.id AND blx.manager_user_id = $1)
            )
        )                                                                     AS has_conflict,
        (
          SELECT COUNT(DISTINCT receipt_identifier)::int FROM ticket
          WHERE activated_by_user_id = $1 AND entry_source = 'receipt'
            AND receipt_identifier IS NOT NULL
            AND activated_at >= NOW() - INTERVAL '24 hours'
        )                                                                     AS daily_count,
        COALESCE((
          SELECT COUNT(*)::int FROM ticket
          WHERE activated_by_user_id = $1 AND draw_id = (SELECT draw_id FROM od)
        ), 0)                                                                 AS draw_count`,
      [userId, input.locationId],
    );

    const pf = preflightRes.rows[0];

    if (!pf.is_email_verified) {
      throw new Error('Please verify your email address before submitting entries.');
    }
    if (!pf.is_phone_verified && process.env.PHONE_VERIFY_ENABLED === 'true') {
      throw new Error('PHONE_NOT_VERIFIED');
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
    const draw_start_date: Date = pf.draw_start_date;
    // Use subscription's per-location cap; fall back to global cap; fall back to 500 if no settings row
    const entry_cap: number | null = pf.entries_per_location != null
      ? Number(pf.entries_per_location)
      : pf.settings_exists ? pf.global_entry_cap : 500;

    const entryCount = minTransactionAmount && minTransactionAmount > 0
      ? Math.min(Math.floor(input.transactionAmount / minTransactionAmount), MAX_ENTRIES_PER_RECEIPT)
      : 1;

    const currentDrawCount = Number(pf.draw_count);
    const remainingDrawEntries = MAX_ENTRIES_PER_DRAW - currentDrawCount;
    if (remainingDrawEntries <= 0) {
      throw new Error(`You have reached the maximum of ${MAX_ENTRIES_PER_DRAW} entries for this draw.`);
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
           AND transaction_amount != $3 AND draw_id = $4`,
        [business_id, input.receiptIdentifier, input.transactionAmount, drawId],
      );
      if (parseInt(probeCheck.rows[0].count, 10) > 0) {
        await updateUserRiskScore(userId, 3); // +3 more = +4 total for confirmed probe
        const probDrawId = await getOpenDrawId(pool);
        if (probDrawId) {
          await syncUserQuarantineState(userId, probDrawId);
        }
      } else {
        // Base +1 penalty only — sync quarantine if the user's score just crossed into HIGH
        const updatedScoreRes = await pool.query(
          `SELECT risk_score FROM "user" WHERE id = $1`,
          [userId],
        );
        const updatedScore: number = Number(updatedScoreRes.rows[0]?.risk_score ?? 0);
        if (updatedScore > RISK_THRESHOLDS.MEDIUM_MAX) {
          await syncUserQuarantineState(userId, drawId);
        }
      }
      // Record this below-threshold attempt (via pool, so it survives the rollback) so a
      // later qualifying resubmission of the same receipt at a changed amount is caught.
      // The same statement opportunistically purges rows older than the 7-day detection
      // window, so the table self-maintains with no cron job (this path is rare).
      await pool.query(
        `WITH ins AS (
           INSERT INTO receipt_threshold_attempt (user_id, business_id, receipt_identifier, attempted_amount)
           VALUES ($1, $2, $3, $4)
         )
         DELETE FROM receipt_threshold_attempt WHERE created_at < NOW() - INTERVAL '7 days'`,
        [userId, business_id, input.receiptIdentifier, input.transactionAmount],
      );
      throw new Error(`So close! Entries at ${business_name} need a purchase of $${minTransactionAmount} or more. Come back next time with a qualifying receipt and you are in.`);
    }

    // Note: amount manipulation (this same receipt previously rejected below threshold, now
    // resubmitted at a different qualifying amount) is detected inside evaluateUserRisk below
    // via the 'threshold_probing' signal, which reads the recorded below-threshold attempts.

    // Transaction date validation
    if (input.transactionDate) {
      const txDate = new Date(input.transactionDate);
      // The campaign PERIOD is defined by the draw's start_date (admin-selectable, defaults to
      // the 1st of the draw month) - NOT opened_at, which is just when the admin clicked "open".
      // Anchoring on opened_at wrongly rejects in-period receipts whenever a draw is opened late.
      const campaignStart = new Date(draw_start_date);
      const now = new Date();
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      if (txDate > now) {
        throw new Error('Purchase date cannot be in the future.');
      }
      if (txDate < sevenDaysAgo) {
        throw new Error('Receipt is older than 7 days and cannot be accepted.');
      }
      if (txDate < campaignStart) {
        throw new Error('Transaction date must fall within the current campaign period.');
      }
    }

    // Acquire an advisory lock keyed on (business_id, receiptIdentifier) to prevent
    // two concurrent submissions of the same receipt slipping through the duplicate check
    // simultaneously (TOCTOU race condition). The lock is automatically released at COMMIT/ROLLBACK.
    await client.query(
      `SELECT pg_advisory_xact_lock(4, hashtext($1::text || '|' || $2::text))`,
      [String(business_id), input.receiptIdentifier],
    );

    // Check cross-user duplicate inside the transaction (using client, not pool) so the
    // advisory lock above actually serializes this read against concurrent submissions.
    const dupCheck = await checkDuplicateReceiptIdentifier(
      business_id,
      input.receiptIdentifier,
      userId,
      drawId,
      client,
    );

    // ── Contest routing (anti-squatting) ────────────────────────────────────────
    // Distinguish the two kinds of standing cross-user claim on this receipt:
    //  - IMAGE-BACKED: another user proved it (OCR passed) or is proving it (OCR in
    //    flight / errored). Final - cannot be contested.
    //  - TYPED-ONLY: another user just typed the number with no image (a squatter, who
    //    can block the real customer with a guessed number). Overridable by proof: the
    //    real owner may attach a photo, and if OCR verifies it we supersede the squatter.
    const hasImage = !!input.receiptImageUrl;
    const claimRes = await client.query(
      `SELECT
         BOOL_OR(
           (is_quarantined = FALSE AND image_validation_status IN ('passed', 'pending'))
           OR quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review')
         ) AS image_backed_by_other,
         BOOL_OR(is_quarantined = FALSE AND image_validation_status = 'not_required') AS typed_only_by_other
       FROM ticket
       WHERE business_id = $1 AND receipt_identifier = $2 AND activated_by_user_id <> $3 AND draw_id = $4`,
      [business_id, input.receiptIdentifier, userId, drawId],
    );
    const imageBackedByOther = claimRes.rows[0]?.image_backed_by_other === true;
    const typedOnlyByOther = claimRes.rows[0]?.typed_only_by_other === true;
    // A contestable squatter is NOT a fraud signal against the legitimate owner: the
    // cross-user duplicate penalty and cap-exemption must not punish someone proving
    // their own receipt. Treat the collision as "no duplicate" for risk + cap purposes.
    const contestable = typedOnlyByOther && !imageBackedByOther;
    const effectiveIsDuplicate = contestable ? false : dupCheck.isDuplicate;
    const effectiveIsDuplicateQuar = contestable ? false : dupCheck.isDuplicateQuarantined;

    // Evaluate risk — pass pre-fetched user score to skip the extra SELECT
    const preFetchedRisk: PreFetchedUserRisk = {
      storedScore: Number(pf.risk_score ?? 0),
      lastFlaggedAt: pf.risk_last_flagged_at ? new Date(pf.risk_last_flagged_at) : null,
      lastDecayedAt: pf.risk_last_decayed_at ? new Date(pf.risk_last_decayed_at) : null,
    };
    const riskEval = await evaluateUserRisk(userId, {
      businessId: business_id,
      drawId,
      receiptIdentifier: input.receiptIdentifier,
      transactionAmount: input.transactionAmount,
      isDuplicateCrossUser: effectiveIsDuplicate,
      isDuplicateQuarantinedCrossUser: effectiveIsDuplicateQuar,
      typingDurationMs: input.typingDurationMs,
      receiptInputMethod: input.receiptInputMethod,
    }, preFetchedRisk);

    // Progressive controls use the stored score (before this submission's delta).
    // Score is NOT updated yet — "image required" and throttle are gates, not penalties.
    // Updating the score before these checks would punish the user for retrying.
    const storedScore = riskEval.totalScore - riskEval.delta;

    // High risk (stored > MEDIUM_MAX, i.e. >=20): throttle to 1 submission per 24 hours (distinct receipts)
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

    // Hard block on sequential identifier guessing — checked BEFORE the transactional risk write
    // below. This path REJECTS the submission (throws → the whole transaction rolls back), so the
    // penalty must be persisted OUT OF BAND (pool, not the txn client) to survive the rollback and
    // actually escalate the guesser toward the image-required / throttle gates; otherwise a
    // rejected probe costs nothing and an attacker can enumerate receipt numbers indefinitely.
    // It MUST run before the client-scoped write below: doing the transactional UPDATE "user"
    // first takes a row lock held until rollback, and this pool UPDATE on the SAME row (a different
    // connection) would then self-block against it — invisible to Postgres's deadlock detector
    // (the txn session sits idle) — hanging until the 10s statement_timeout, at which point the
    // penalty persists ZERO times and the user gets a raw PG error. Ordering it first avoids the lock.
    if (riskEval.flags.includes('sequential_guessing')) {
      await updateUserRiskScore(userId, riskEval.delta, undefined, riskEval.flags);
      await syncUserQuarantineState(userId, drawId);
      throw new Error('Suspicious sequential receipt pattern detected. Please contact support if this is in error.');
    }

    // Past the gates — persist the risk delta, then sync quarantine (transactional; commits with
    // the submission). Sync here ensures existing tickets are quarantined immediately if this
    // submission's delta pushes the user into HIGH risk.
    await updateUserRiskScore(userId, riskEval.delta, client, riskEval.flags);
    await syncUserQuarantineState(userId, drawId, client);

    // High-risk shadowban is decided by stored score, exactly as at insert prep below.
    const isHighRisk = riskEval.totalScore > RISK_THRESHOLDS.MEDIUM_MAX;

    // ── Standing-claim resolution (anti-squatting) ──────────────────────────────
    // Same user already holds a ticket for this receipt (any state) → no resubmit churn.
    const ownExisting = await client.query(
      `SELECT 1 FROM ticket
       WHERE business_id = $1 AND receipt_identifier = $2 AND activated_by_user_id = $3 AND draw_id = $4
       LIMIT 1`,
      [business_id, input.receiptIdentifier, userId, drawId],
    );
    if (ownExisting.rows.length > 0) {
      throw new Error('This receipt has already been entered. If you think this is a mistake, please contact us and we will help sort it out.');
    }

    let isContest = false;
    if (imageBackedByOther) {
      // Another user proved (or is proving) this receipt with an image — final. Plain block.
      throw new Error('This receipt has already been entered. If you think this is a mistake, please contact us and we will help sort it out.');
    } else if (contestable && !isHighRisk && hasImage) {
      // One contest at a time per receipt: if another user's contest is already awaiting its OCR
      // verdict, don't open a second (which would waste OCR calls and leave a race-loser). We
      // hold the receipt advisory lock here, so this read is consistent.
      const inFlight = await client.query(
        `SELECT 1 FROM ticket
         WHERE business_id = $1 AND receipt_identifier = $2 AND activated_by_user_id <> $3 AND draw_id = $4
           AND quarantine_reason = 'contest_pending'
         LIMIT 1`,
        [business_id, input.receiptIdentifier, userId, drawId],
      );
      if (inFlight.rows.length > 0) {
        throw new Error('This receipt is already being reviewed. Please try again in a few minutes.');
      }
      // Squatter override: this user brought a photo to prove the receipt is theirs. Insert
      // as a CONTEST held OUT of the standing slot (quarantine_reason 'contest_pending', which
      // the partial unique index excludes, so it never collides with the squatter's row). OCR
      // resolves it: on proof we supersede the squatter and promote this entry; otherwise it is
      // released with no penalty and the squatter is left untouched.
      isContest = true;
    } else if (contestable && !isHighRisk) {
      // Squatter present, but this user typed with no image — invite a photo (special code the
      // client turns into "someone already entered this receipt, attach a photo and try again").
      throw new Error('RECEIPT_CONTEST_IMAGE_REQUIRED');
    } else if (dupCheck.isDuplicate) {
      // Any other active claim (a high-risk user meeting a squatter, or the rare failed-active
      // edge) → today's plain block. Quarantined-but-released claims fall through and this user
      // (with the real paper receipt) may enter.
      throw new Error('This receipt has already been entered. If you think this is a mistake, please contact us and we will help sort it out.');
    }

    // Start batch size from what the amount earns, then narrow by each cap
    let batchSize = entryCount;

    // Narrow by user draw cap
    batchSize = Math.min(batchSize, remainingDrawEntries);

    // Entry cap enforcement — quarantined tickets do not consume the cap. A contest is a
    // legitimate entrant (effectiveIsDuplicate=false), so it DOES respect the cap.
    if (entry_cap !== null && countsAgainstCap(riskEval, effectiveIsDuplicate)) {
      // Serialize the count->insert for THIS (location, draw) so two DIFFERENT users submitting
      // at once can't both read the same under-cap count and both insert past the paid cap. The
      // per-user locks (3/10/4) above don't help across different users. Lock family 7 is unused
      // elsewhere; acquired after 3/10/4 (consistent order everywhere => no deadlock), held to COMMIT.
      await client.query(
        `SELECT pg_advisory_xact_lock(7, hashtext('loccap:' || $1::text || ':' || $2::text))`,
        [input.locationId, drawId],
      );
      const bizCapCheck = await client.query(
        `SELECT COUNT(*) AS count FROM ticket
         WHERE location_id = $1 AND draw_id = $2 AND is_quarantined = FALSE`,
        [input.locationId, drawId],
      );
      const bizCurrentCount = parseInt(bizCapCheck.rows[0].count, 10);
      const remainingBizEntries = entry_cap - bizCurrentCount;
      if (remainingBizEntries <= 0) {
        throw new Error('We\'re sorry, this location has run out of entries for the current campaign. This is not your fault - try visiting another participating location!');
      }
      batchSize = Math.min(batchSize, remainingBizEntries);
    }

    // Always insert at least 1 if we passed all checks
    batchSize = Math.max(batchSize, 1);

    // ── Document-reuse check for TYPED-ONLY entries (no image = no async OCR check) ──
    // A prior IMAGED entry fingerprinted every number on its receipt. If this typed number is in
    // one of those fingerprints, it's the same physical document reused under a second number -
    // catch it now (one indexed GIN lookup), since without an image the OCR-time check never runs.
    // (Two typed-only entries with NO image anywhere are undetectable - no fingerprint exists.)
    // IS DISTINCT FROM excludes same-number claims (dedup handles those). Two confidence levels:
    //  - the matched entry's OCR PASSED (image-verified): high confidence this is a reuse of a
    //    proven receipt → HARD bounce at submit, exactly like reusing the same number. Clear
    //    feedback for an honest re-submitter, and the exact-token-of-a-verified-receipt match is
    //    confident enough that a false block is very unlikely.
    //  - the matched entry's OCR is still PENDING (not yet proven): fuzzier → keep the silent
    //    shadowban (+3 risk, admin-reversible) so a coincidence never hard-blocks anyone.
    // We only hard-bounce on the NO-IMAGE path: an image submission is about to have its OWN photo
    // OCR'd, so the async document check works from the real image rather than the typed string
    // alone, which avoids false-blocking a genuinely different receipt that merely shares a token.
    let isDuplicateDocument = false;
    if (!hasImage && !isContest) {
      const fp = await client.query(
        `SELECT COALESCE(BOOL_OR(image_validation_status = 'passed'), FALSE) AS has_verified,
                COUNT(*)::int AS n
         FROM ticket
         WHERE business_id = $1 AND draw_id = $3 AND receipt_tokens @> ARRAY[$2::text]
           AND receipt_identifier IS DISTINCT FROM $2
           AND (is_quarantined = FALSE OR quarantine_reason IN ('ocr_pending', 'ocr_error_pending_review'))`,
        [business_id, input.receiptIdentifier, drawId],
      );
      if (Number(fp.rows[0]?.n ?? 0) > 0) {
        if (fp.rows[0].has_verified) {
          throw new Error('This receipt has already been entered. If you think this is a mistake, please contact us and we will help sort it out.');
        }
        isDuplicateDocument = true;
      }
    }

    // isHighRisk + hasImage were computed above (contest routing). Medium-risk users'
    // ticket is held quarantined until OCR passes.
    const isMediumRisk = riskEval.totalScore > RISK_THRESHOLDS.LOW_MAX && !isHighRisk;
    const isOcrPending = isMediumRisk && hasImage;
    // A contest is held out of the standing slot as 'contest_pending' (excluded from the
    // partial unique index) until OCR resolves it; otherwise the normal quarantine rules.
    // A detected duplicate document is silently shadow-banned at insert (never active).
    const isQuarantined = isContest || isHighRisk || isOcrPending || isDuplicateDocument;
    const quarantineReason = isContest
      ? 'contest_pending'
      : isDuplicateDocument ? 'duplicate_document'
      : isHighRisk ? 'high_risk_user' : isOcrPending ? 'ocr_pending' : null;
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
    const conflicting = new Set<string>(conflictRes.rows.map((r: { code: string }) => r.code));
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
            i === 0 ? input.transactionAmount : null, // amount lives only on the anchor, or revenue SUMs count it once per sibling
            i === 0 ? (input.transactionDate ?? null) : null,
            i === 0 ? (input.receiptImageUrl ?? null) : null,
            riskEval.totalScore,
            // Anchor records the +3 duplicate-document penalty on the entry itself (admin chip).
            i === 0 ? riskEval.delta + (isDuplicateDocument ? 3 : 0) : 0,
            isQuarantined,
            quarantineReason,
            quarantinedAt,
            i === 0 && hasImage ? 'pending' : 'not_required',
            input.submitterIp ?? null,
            // Tag the anchor so admins see WHY it was quarantined (the Risk Signal).
            i === 0 ? (isDuplicateDocument ? [...riskEval.flags, 'duplicate_document'] : riskEval.flags) : [],
            i === 0 ? null : insertedTickets[0].ticketId, // siblings link back to anchor
          ],
        );
      } catch (insertErr: unknown) {
        // PostgreSQL unique constraint violation — receipt was already submitted
        if ((insertErr as { code?: string })?.code === '23505') {
          throw new Error('This receipt has already been entered. If you think this is a mistake, please contact us and we will help sort it out.');
        }
        throw insertErr;
      }
      insertedTickets.push({ ticketId: ticketInsert.rows[0].id, code: ticketCode });
    }

    await client.query('COMMIT');
    invalidatePublicLocation(input.locationId);

    // Duplicate document caught synchronously (typed-only reuse): apply the +3 to the user's
    // running score (the entry's own delta was baked into the insert above) and sync quarantine.
    if (isDuplicateDocument) {
      await updateUserRiskScore(userId, 3);
      await syncUserQuarantineState(userId, drawId);
    }

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
    throw err;
  } finally {
    client.release();
  }
};

export const activatePromotionalEntry = async (
  userId: number,
  code: string,
): Promise<{ entryId: number; drawName: string; ticketId: number; code: string }> => {
  const pool = getPool();
  const client = await pool.connect();
  const normalizedCode = code.toUpperCase().trim();

  try {
    await client.query('BEGIN');

    // User-level lock prevents two simultaneous promo-code requests from the
    // same user (with different codes) both reading count=0 and both succeeding.
    // Acquired before the code-level lock to enforce a consistent lock ordering.
    await client.query(
      `SELECT pg_advisory_xact_lock(3, hashtext('usr_promo_' || $1::text))`,
      [userId],
    );

    // Advisory lock keyed on the promo code prevents the max_uses race condition:
    // two concurrent 100th-user requests would otherwise both read use_count=99,
    // both pass the cap check, and both insert.
    await client.query(
      `SELECT pg_advisory_xact_lock(5, hashtext($1::text))`,
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

    // Shared per-user cap lock (same key as code/free/receipt) so the 4 entry types can't
    // each slip past the per-draw cap in parallel.
    await client.query(`SELECT pg_advisory_xact_lock(10, hashtext('udcap:' || $1::text))`, [userId]);

    // Per-draw per-user cap — counts ALL the user's tickets (incl. under-review) to match
    // their visible total; promo tickets live in the ticket table like every other entry.
    const capResult = await client.query(
      `SELECT COUNT(*)::int AS total_count FROM ticket
       WHERE activated_by_user_id = $1 AND draw_id = $2`,
      [userId, draw.id],
    );
    if (parseInt(capResult.rows[0].total_count, 10) >= MAX_ENTRIES_PER_DRAW) {
      throw new Error(`You have reached the maximum of ${MAX_ENTRIES_PER_DRAW} entries for this campaign.`);
    }

    // Redemption log — the UNIQUE(code, user_id) constraint rejects duplicate use per account.
    // The actual draw entry is the ticket row inserted below; this table only tracks code usage.
    let result;
    try {
      result = await client.query(
        `INSERT INTO promotional_entry (code, user_id, draw_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [normalizedCode, userId, draw.id],
      );
    } catch (err: unknown) {
      if (err instanceof Error && (err as Error & { code?: string }).code === '23505') {
        throw new Error('You have already used this promotional code.');
      }
      throw err;
    }

    // The real entry: a ticket row, so the winner picker / caps / analytics all see it
    const ticketCode = await generateGlobalUniqueCode(client);
    const ticketResult = await client.query(
      `INSERT INTO ticket (code, status, entry_source, business_id, activated_by_user_id, draw_id, activated_at)
       VALUES ($1, 'Activated', 'promo', NULL, $2, $3, NOW())
       RETURNING id`,
      [ticketCode, userId, draw.id],
    );

    await client.query('COMMIT');
    // Promo entries have no business/location — they affect no public cache.
    return { entryId: result.rows[0].id, drawName: draw.name, ticketId: ticketResult.rows[0].id, code: ticketCode };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ─── Staging demo reset (TEMPORARY) ───────────────────────────────────────────
// How many fresh sample entries to seed on each reset so the demo starts with visible activity.
const DEMO_SEED_ENTRIES = 3;

// Seed a few REAL receipt entries for the demo account at random participating locations of the
// open campaign, so a freshly-reset account already shows entries. Same clean row shape the normal
// receipt flow produces (Activated, unquarantined, no OCR pending), just inserted directly without
// the anti-fraud gates. Runs inside the reset transaction. Returns how many were created.
const seedDemoEntries = async (client: PoolClient, userId: number): Promise<number> => {
  const drawRes = await client.query(
    `SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1`,
  );
  const drawId: number | undefined = drawRes.rows[0]?.id;
  if (!drawId) return 0; // no open campaign — nothing to enter

  // Up to N distinct participating businesses (one random active location each), so the seeded
  // entries look like they came from different places. Mirrors the participation rules the real
  // receipt preflight uses (active location, business is in the open draw, not participation-paused).
  const locRes = await client.query(
    `SELECT location_id, business_id FROM (
       SELECT DISTINCT ON (b.id) bl.id AS location_id, b.id AS business_id
       FROM business_location bl
       JOIN business b ON bl.business_id = b.id
       WHERE bl.is_active = true
         AND EXISTS (SELECT 1 FROM draw_entry de WHERE de.business_id = b.id AND de.draw_id = $1)
         AND NOT EXISTS (SELECT 1 FROM subscription sp WHERE sp.business_id = b.id AND sp.participation_paused = TRUE)
       ORDER BY b.id, random()
     ) one_per_business
     ORDER BY random()
     LIMIT $2`,
    [drawId, DEMO_SEED_ENTRIES],
  );

  let seeded = 0;
  for (const loc of locRes.rows) {
    const code = await generateGlobalUniqueCode(client);
    // Random distinct receipt id (canonical uppercase alnum) so the per-draw dedup index never trips.
    const identifier = `DEMO${crypto.randomInt(100000, 1000000)}`;
    const amount = crypto.randomInt(1500, 9900) / 100; // $15.00 - $99.00
    await client.query(
      `INSERT INTO ticket
         (code, status, entry_source, business_id, location_id, draw_id,
          activated_by_user_id, activated_at, receipt_identifier, transaction_amount,
          transaction_date, risk_score, risk_score_delta, is_quarantined, image_validation_status)
       VALUES ($1, 'Activated', 'receipt', $2, $3, $4, $5, NOW(), $6, $7,
               CURRENT_DATE - (floor(random() * 6))::int, 0, 0, FALSE, 'not_required')`,
      [code, loc.business_id, loc.location_id, drawId, userId, identifier, amount],
    );
    seeded++;
  }
  return seeded;
};

// Wipes the demo account's activity so it can present a fresh flow to the next business:
// deletes its entries, its weekly free-entry record and any threshold-probe rows, and zeroes
// its fraud-risk state, then seeds a few fresh sample entries. Identity, email/phone verification
// and profile are all preserved, so the account never has to re-verify. Gated by isDemoResetEnabled
// (DEMO_USER_ENABLED env, staging-only) so ANY staging account may reset its OWN activity, while it
// stays completely inert in production. Remove together with the rest of the demo scaffolding (demo.ts).
export const resetDemoUserService = async (
  userId: number,
): Promise<{ ticketsDeleted: number; entriesSeeded: number }> => {
  const pool = getPool();
  if (!isDemoResetEnabled()) {
    throw new Error('DEMO_RESET_NOT_PERMITTED');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Entries (anchor + siblings all carry activated_by_user_id); FKs to ticket.id are SET NULL /
    // CASCADE, so this also clears any winner pointer or audit rows referencing them.
    const del = await client.query('DELETE FROM ticket WHERE activated_by_user_id = $1', [userId]);
    await client.query('DELETE FROM free_ticket_usage WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM receipt_threshold_attempt WHERE user_id = $1', [userId]);
    await client.query(
      `UPDATE "user"
         SET risk_score = 0,
             risk_clean_entries = 0,
             risk_last_flagged_at = NULL,
             risk_last_decayed_at = NULL,
             risk_flags = NULL
       WHERE id = $1`,
      [userId],
    );
    const entriesSeeded = await seedDemoEntries(client, userId);
    await client.query('COMMIT');
    return { ticketsDeleted: del.rowCount ?? 0, entriesSeeded };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

