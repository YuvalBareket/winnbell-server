import { Response } from 'express';
import * as ticketService from './tickets.service.js';
import { getBusinessLocationsByUserId } from '../business/business.service.js';
import { getPool } from '../../shared/db/db.js';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import { validateLength } from '../../shared/validation.js';
import { getClientIp } from '../../shared/clientIp.js';

export const redeemCode = async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    if (!code || typeof code !== 'string' || !/^[A-Z0-9]{6,8}$/.test(code)) {
      res.status(400).json({ message: 'Invalid ticket code format' });
      return;
    }
    const userId = req.user!.id;

    const result = await ticketService.activateTicket(code, userId);
    res.status(200).json(result);
  } catch (error: unknown) {
    res.status(400).json({ message: 'Redeem failed' });
  }
};

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
      if (locationId) {
        // Location manager — scoped to their location only
        const { tickets, perLocationCap } = await ticketService.getLocationTicketsService(userId, drawId);
        const totalCount = tickets.filter((t: { is_quarantined: boolean }) => !t.is_quarantined).length;
        res.status(200).json({ tickets, totalCount, cap: perLocationCap, perLocationCap, activeLocationCount: 1, effectiveCount: totalCount });
      } else {
        // Business owner — optionally filtered by location
        const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
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
    res.status(400).json({ message: 'Activation failed' });
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
    if (sanitizedId.length < 4 || sanitizedId.length > 100) {
      res.status(400).json({ message: 'receiptIdentifier must be between 4 and 100 characters.' });
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
      receiptIdentifier: String(receiptIdentifier).trim(),
      transactionAmount: Number(transactionAmount),
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
    res.status(400).json({ message: 'Entry submission failed.' });
  }
};

export const generateTicket = async (req: AuthRequest, res: Response) => {
  try {
    const user_id = req.user!.id;

    // If the user is a manager (has a location_id in their JWT), they can ONLY generate tickets
    // for their own assigned location — reject any attempt to target a different location.
    const jwtLocationId = req.user!.location_id ?? null;
    if (jwtLocationId && req.body?.location_id && Number(req.body.location_id) !== jwtLocationId) {
      res.status(403).json({ message: 'Forbidden: cannot generate tickets for another location.' });
      return;
    }

    let location_id: number | undefined = (jwtLocationId ?? req.body?.location_id) || undefined;

    if (!location_id) {
      const businessLocations = await getBusinessLocationsByUserId(user_id);

      if (!businessLocations || businessLocations.length === 0) {
        res.status(400).json({
          message: 'No locations found for this business. A location is required to issue a ticket.',
        });
        return;
      }

      location_id = businessLocations[0].id;
    }

    const result = await ticketService.generateTicketService(user_id, Number(location_id));

    res.status(201).json({ success: true, code: result.code });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : '';
    const status = msg.includes('Unauthorized') || msg.includes('cannot') ? 403 : 400;
    res.status(status).json({ message: 'Failed to generate ticket' });
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
    res.status(400).json({ message: 'Promotional entry failed.' });
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
         (SELECT COUNT(*)::int FROM ticket t3 JOIN draw d ON t3.draw_id = d.id
          WHERE t3.activated_by_user_id = $1 AND d.status = 'Open' AND t3.is_quarantined = FALSE
         ) AS draw_entry_count
       FROM "user" u WHERE u.id = $1`,
      [userId],
    );

    const row = result.rows[0];
    const score: number = row?.risk_score ?? 0;
    const isPhoneVerified: boolean = row?.is_phone_verified ?? false;
    const dailyCount: number = row?.daily_count ?? 0;
    const drawEntryCount: number = row?.draw_entry_count ?? 0;

    // High risk + already submitted today = throttled
    const isThrottled = score >= 20 && dailyCount >= 1;

    res.json({
      requiresImage: score > 9,
      isThrottled,
      drawEntryCount,
      dailyCount,
      dailyLimit: 5,
      isPhoneVerified,
    });
  } catch {
    res.status(500).json({ message: 'Failed to fetch risk level.' });
  }
};
