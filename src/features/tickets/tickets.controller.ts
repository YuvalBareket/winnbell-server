import { Response } from 'express';
import * as ticketService from './tickets.service.js';
import { getPool } from '../../shared/db/db.js';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import { validateLength } from '../../shared/validation.js';
import { getClientIp } from '../../shared/clientIp.js';
import { normalizeReceiptIdentifier } from '../ocr/receiptIdentity.js';

export const getMyTickets = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const drawId = Number(req.query.draw_id);
    if (!drawId || isNaN(drawId)) {
      res.status(400).json({ message: 'Valid draw_id is required' });
      return;
    }
    const role = req.user!.role;
    const locationId = req.user!.location_id;

    if (role === 'Business') {
      const filterLocationId = req.query.location_id ? Number(req.query.location_id) : undefined;
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      if (locationId) {
        // Location manager — scoped to their location only (paginated like the owner branch)
        const { tickets, totalCount, perLocationCap } = await ticketService.getLocationTicketsService(userId, drawId, page);
        res.status(200).json({ tickets, totalCount, cap: perLocationCap, perLocationCap, activeLocationCount: 1, effectiveCount: tickets.length });
      } else {
        // Business owner — optionally filtered by location
        const { tickets, totalCount, cap, perLocationCap, activeLocationCount } = await ticketService.getBusinessTicketsService(userId, drawId, filterLocationId, page);
        res.status(200).json({ tickets, totalCount, cap, perLocationCap, activeLocationCount, effectiveCount: tickets.length });
      }
    } else {
      const result = await ticketService.getUserTicketsService(userId, drawId);
      res.status(200).json(result);
    }
  } catch (error: unknown) {
    res.status(400).json({ message: 'Failed to get entries' });
  }
};

export const getStatus = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const status = await ticketService.checkFreeTicketEligibility(userId);
    res.json(status);
  } catch (error: unknown) {
    res.status(500).json({ message: 'Error checking status' });
  }
};

export const activate = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await ticketService.activateFreeTicket(userId, getClientIp(req));
    res.status(201).json(result);
  } catch (error: unknown) {
    // Surface the service's curated, user-facing reason (weekly limit, no open campaign,
    // 30-entry cap, email not verified) - same pattern as activatePromotional/submitReceiptEntry.
    // PHONE_NOT_VERIFIED never reaches here (requirePhoneVerified middleware runs first).
    const message = error instanceof Error && error.message ? error.message : 'Activation failed';
    res.status(400).json({ message });
  }
};

export const submitReceiptEntry = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { locationId, receiptIdentifier, transactionAmount, transactionDate, receiptImageUrl, typingDurationMs, receiptInputMethod } = req.body;

    if (!locationId || !receiptIdentifier || !transactionAmount || !transactionDate) {
      res.status(400).json({ message: 'locationId, receiptIdentifier, transactionAmount, and transactionDate are required.' });
      return;
    }
    if (typeof transactionAmount !== 'number' || transactionAmount <= 0) {
      res.status(400).json({ message: 'transactionAmount must be a positive number.' });
      return;
    }
    const sanitizedId = String(receiptIdentifier).trim();
    // Min 5 (matches the client). Shorter numeric strings collide with digit runs that appear
    // incidentally in unrelated receipt images (barcodes, phone numbers), which weakens the
    // contest OCR proof - so the floor is enforced server-side, not just in the form.
    if (sanitizedId.length < 5 || sanitizedId.length > 100) {
      res.status(400).json({ message: 'receiptIdentifier must be between 5 and 100 characters.' });
      return;
    }
    // Canonical form (uppercase alnum only) is what we STORE and dedup on, so "#1366-3859"
    // and "1366-3859" can't both be entered as if they were different receipts.
    const normalizedId = normalizeReceiptIdentifier(sanitizedId);
    if (normalizedId.length < 4) {
      res.status(400).json({ message: 'receiptIdentifier must contain at least 4 letters or numbers.' });
      return;
    }

    if (transactionDate !== undefined) {
      if (typeof transactionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) {
        res.status(400).json({ message: 'transactionDate must be in YYYY-MM-DD format' });
        return;
      }
      const parsed = new Date(transactionDate);
      if (isNaN(parsed.getTime())) {
        res.status(400).json({ message: 'transactionDate is not a valid date' });
        return;
      }
    }

    if (receiptImageUrl) {
      const r2Base = process.env.R2_PUBLIC_URL;
      if (!r2Base || !String(receiptImageUrl).startsWith(r2Base + '/receipt-images/')) {
        res.status(400).json({ message: 'Invalid receipt image URL.' });
        return;
      }
    }

    const result = await ticketService.submitReceiptEntryService(userId, {
      locationId: Number(locationId),
      receiptIdentifier: normalizedId,
      // Round to 2 dp (cents) so the stored amount and entry math never carry float noise.
      transactionAmount: Math.round(Number(transactionAmount) * 100) / 100,
      transactionDate: typeof transactionDate === 'string' ? transactionDate : undefined,
      receiptImageUrl: receiptImageUrl ?? undefined,
      typingDurationMs: typingDurationMs !== undefined ? Number(typingDurationMs) : undefined,
      receiptInputMethod: receiptInputMethod === 'pasted' ? 'pasted' : receiptInputMethod === 'typed' ? 'typed' : undefined,
      submitterIp: getClientIp(req),
    });

    const firstTicket = result.tickets[0];
    res.status(201).json({
      success: true,
      ticketId: firstTicket.ticketId,
      code: firstTicket.code,
      tickets: result.tickets,
      entryCount: result.entryCount,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'PHONE_NOT_VERIFIED') {
      res.status(403).json({ message: 'PHONE_NOT_VERIFIED' });
      return;
    }
    // Anti-squatting: another user typed this receipt with no image. Ask this user (who may
    // be the real owner) to attach a photo so OCR can verify it and override the squatter.
    // A distinct code lets the client show the specific message + reveal the image upload.
    if (error instanceof Error && error.message === 'RECEIPT_CONTEST_IMAGE_REQUIRED') {
      res.status(409).json({
        code: 'RECEIPT_CONTEST_IMAGE_REQUIRED',
        message: 'It looks like this receipt was already entered. Attach a photo of it and try again to confirm it is yours.',
      });
      return;
    }
    // Surface the service's curated, user-facing message (threshold, dates, duplicates, etc.).
    const message = error instanceof Error && error.message ? error.message : 'Entry submission failed.';
    res.status(400).json({ message });
  }
};

export const getReceiptUploadUrl = async (req: AuthRequest, res: Response) => {
  try {
    const size = Number(req.query.size);
    const { getPresignedUploadUrl } = await import('../../shared/s3.js');
    const { uploadUrl, key } = await getPresignedUploadUrl('image/webp', 'receipt-images', size);
    const publicUrl = `${process.env.R2_PUBLIC_URL}/receipt-images/${key}`;
    res.json({ uploadUrl, publicUrl });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'INVALID_CONTENT_LENGTH') {
      res.status(400).json({ message: 'Invalid file size. Images must be under 10 MB.' });
      return;
    }
    res.status(500).json({ message: 'Failed to generate upload URL.' });
  }
};

export const activatePromotional = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { code } = req.body as { code: string };

    if (!code || typeof code !== 'string') {
      res.status(400).json({ message: 'code is required.' });
      return;
    }
    const codeErr = validateLength('Promo code', code, 100);
    if (codeErr) { res.status(400).json({ message: codeErr }); return; }

    const result = await ticketService.activatePromotionalEntry(userId, code);
    res.status(201).json({ success: true, ...result });
  } catch (error: unknown) {
    // Surface the service's curated, user-facing message (invalid code, max uses, one-per-campaign, cap).
    const message = error instanceof Error && error.message ? error.message : 'Promotional entry failed.';
    res.status(400).json({ message });
  }
};

// STAGING DEMO ONLY (temporary). Lets any staging account wipe its own activity between
// demos. The service gates on DEMO_USER_ENABLED, so this is a no-op 403 whenever that flag
// is unset (production, dev). Remove with the demo scaffolding.
export const resetDemo = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await ticketService.resetDemoUserService(userId);
    res.json({ success: true, ...result });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'DEMO_RESET_NOT_PERMITTED') {
      res.status(403).json({ message: 'Not permitted.' });
      return;
    }
    res.status(500).json({ message: 'Failed to reset demo account.' });
  }
};

export const getMyRiskLevel = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const pool = getPool();

    // Single query: user info + daily receipt count + draw entry count
    const result = await pool.query(
      `SELECT
         u.risk_score,
         u.is_phone_verified,
         (SELECT COUNT(DISTINCT t2.receipt_identifier)::int FROM ticket t2
          WHERE t2.activated_by_user_id = $1 AND t2.entry_source = 'receipt'
            AND t2.receipt_identifier IS NOT NULL
            AND t2.activated_at >= NOW() - INTERVAL '24 hours') AS daily_count,
         -- Count ALL of the user's tickets in the open draw (incl. under-review), matching
         -- the per-user cap and the total they see, so isDrawCapped fires exactly at the cap.
         (SELECT COUNT(*)::int FROM ticket t3 JOIN draw d ON t3.draw_id = d.id
          WHERE t3.activated_by_user_id = $1 AND d.status = 'Open'
         ) AS draw_entry_count,
         -- Unclaimed welcome bonus (person referral OR location flyer signup). Mirrors the
         -- eligibility in grantPendingReferralBonus: the bonus is granted at phone-verify time,
         -- so the client uses this to prompt an unverified invitee to verify and claim it.
         EXISTS (
           SELECT 1 FROM user_acquisition ua
           WHERE ua.user_id = $1 AND ua.referral_rewarded_at IS NULL
             AND (ua.referred_by_user_id IS NOT NULL
                  OR (ua.source = 'location_flyer' AND ua.location_id IS NOT NULL))
         ) AS welcome_bonus_pending
       FROM "user" u WHERE u.id = $1`,
      [userId],
    );

    const row = result.rows[0];
    const score: number = row?.risk_score ?? 0;
    const isPhoneVerified: boolean = row?.is_phone_verified ?? false;
    const dailyCount: number = row?.daily_count ?? 0;
    const drawEntryCount: number = row?.draw_entry_count ?? 0;
    const welcomeBonusPending: boolean = row?.welcome_bonus_pending ?? false;

    // High risk + already submitted today = throttled
    const isThrottled = score >= 20 && dailyCount >= 1;

    res.json({
      requiresImage: score > 9,
      isThrottled,
      drawEntryCount,
      dailyCount,
      dailyLimit: 5,
      isPhoneVerified,
      welcomeBonusPending,
    });
  } catch {
    res.status(500).json({ message: 'Failed to fetch risk level.' });
  }
};
