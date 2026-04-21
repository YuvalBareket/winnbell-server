import { Response } from 'express';
import * as ticketService from './tickets.service.js';
import { getBusinessLocationsByUserId } from '../business/business.service.js';
import { getPool } from '../../shared/db/db.js';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';

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
    res.status(400).json({ message: error instanceof Error ? error.message : 'Redeem failed' });
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

    let result;
    if (role === 'Business') {
      if (locationId) {
        result = await ticketService.getLocationTicketsService(userId, drawId);
      } else {
        result = await ticketService.getBusinessTicketsService(userId, drawId);
      }
    } else {
      result = await ticketService.getUserTicketsService(userId, drawId);
    }
    res.status(200).json(result);
  } catch (error: unknown) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Failed to get tickets' });
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
    const result = await ticketService.activateFreeTicket(userId);
    res.status(201).json(result);
  } catch (error: unknown) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Activation failed' });
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

    const result = await ticketService.submitReceiptEntryService(userId, {
      locationId: Number(locationId),
      receiptIdentifier: String(receiptIdentifier).trim(),
      transactionAmount: Number(transactionAmount),
      transactionDate: typeof transactionDate === 'string' ? transactionDate : undefined,
      receiptImageUrl: receiptImageUrl ?? undefined,
      typingDurationMs: typingDurationMs !== undefined ? Number(typingDurationMs) : undefined,
      receiptInputMethod: receiptInputMethod === 'pasted' ? 'pasted' : receiptInputMethod === 'typed' ? 'typed' : undefined,
    });

    res.status(201).json({ success: true, ...result });
  } catch (error: unknown) {
    res.status(400).json({ message: error instanceof Error ? error.message : 'Entry submission failed.' });
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
    res.status(500).json({ message: error instanceof Error ? error.message : 'Failed to generate ticket' });
  }
};

export const getReceiptUploadUrl = async (req: AuthRequest, res: Response) => {
  try {
    const { getPresignedUploadUrl } = await import('../../shared/s3.js');
    const { uploadUrl, key } = await getPresignedUploadUrl('image/webp', 'receipt-images');
    const publicUrl = `${process.env.R2_PUBLIC_URL}/receipt-images/${key}`;
    res.json({ uploadUrl, publicUrl });
  } catch (err: unknown) {
    res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to generate upload URL.' });
  }
};

export const getMyRiskLevel = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const pool = getPool();

    const userResult = await pool.query(
      `SELECT risk_score FROM "user" WHERE id = $1`,
      [userId],
    );
    const score: number = userResult.rows[0]?.risk_score ?? 0;

    // Mirror the exact throttle condition from submitReceiptEntryService:
    // high risk score AND already has a ticket in the last 24 hours
    let isThrottled = false;
    if (score >= 15) {
      const recentResult = await pool.query(
        `SELECT COUNT(*) AS count FROM ticket
         WHERE activated_by_user_id = $1 AND entry_source = 'receipt' AND activated_at >= NOW() - INTERVAL '24 hours'`,
        [userId],
      );
      isThrottled = parseInt(recentResult.rows[0].count, 10) >= 1;
    }

    res.json({
      requiresImage: score > 9,
      isThrottled,
    });
  } catch {
    res.status(500).json({ message: 'Failed to fetch risk level.' });
  }
};
