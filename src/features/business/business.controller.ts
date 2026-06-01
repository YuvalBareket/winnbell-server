// src/features/business/business.controller.ts
import { Request, Response } from 'express';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import { INearbyQuery } from './business.types.js';
import {
  addBusinessLocation,
  createFullBusinessProfile,
  createManagerInviteLink,
  deleteBusinessLocation,
  getAddress,
  getEntryModeService,
  getMyBusinessData,
  getNearbyBusinessesService,
  getParticipatingBusinessesService,
  getParticipatingLocationByIdService,
  removeLocationManagerService,
  searchParticipatingLocationsService,
  updateBusinessLocation,
  updateBusinessLogo,
  updateBusinessProfile,
  updateCampaignSettings,
} from './business.service.js';
import { getPresignedUploadUrl } from '../../shared/s3.js';
import { getPool } from '../../shared/db/db.js';
import { syncSubscriptionQuantity } from '../stripe/stripe.service.js';

export const getEntryMode = async (_req: Request, res: Response) => {
  try {
    const result = await getEntryModeService();
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' });
  }
};

export const getParticipating = async (_req: Request, res: Response) => {
  try {
    const result = await getParticipatingBusinessesService();
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' });
  }
};

export const searchParticipatingLocations = async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) { res.json([]); return; }
    const locations = await searchParticipatingLocationsService(q);
    res.json(locations);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' });
  }
};

export const getParticipatingLocationById = async (req: Request, res: Response) => {
  const locationId = Number(req.params.locationId);
  if (isNaN(locationId)) return res.status(400).json({ message: 'Invalid location ID' });
  try {
    const location = await getParticipatingLocationByIdService(locationId);
    if (!location) return res.status(404).json({ message: 'Location not found' });
    res.json(location);
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
};

export const getNearby = async (
  req: Request<{}, {}, {}, INearbyQuery>,
  res: Response,
) => {
  try {
    const { minLat, maxLat, minLng, maxLng, sector, limit } = req.query;

    if (!minLat || !maxLat || !minLng || !maxLng) {
      return res.status(400).json({ message: 'Bounding box params required' });
    }

    const businesses = await getNearbyBusinessesService(
      parseFloat(minLat),
      parseFloat(maxLat),
      parseFloat(minLng),
      parseFloat(maxLng),
      sector,
      limit ? parseInt(limit, 10) : undefined,
    );

    res.json(businesses);
  } catch (error) {
    console.error('Nearby Controller Error:', error);
    res.status(500).json({ message: 'Failed to fetch nearby businesses' });
  }
};
export const getAddressController = async (req: Request, res: Response) => {
  try {
    const text = String(req.query.q || '').trim();
    const data = await getAddress(text);
    res.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Bad request';
    res.status(400).json({ message });
  }
};
export const setupBusiness = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const result = await createFullBusinessProfile(userId, req.body);

    res.status(201).json({
      success: true,
      message: 'Business profile and locations created successfully',
      businessId: result.businessId,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    res.status(500).json({ message });
  }
};

export const getMyBusiness = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const business = await getMyBusinessData(userId);

    if (!business) {
      res.status(404).json({ message: 'Business profile not found' });
      return;
    }

    res.json(business);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    res.status(500).json({ message });
  }
};

export const updateBusiness = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { businessSector, description, terms_text } = req.body as {
      businessSector: string;
      description: string;
      terms_text: string;
    };

    await updateBusinessProfile(req.user!.id, { businessSector, description, terms_text });
    res.status(204).send();
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'BUSINESS_NOT_FOUND') {
      res.status(404).json({ message: 'Business not found' });
      return;
    }
    res.status(500).json({ message: 'Failed to update business' });
  }
};

export const updateCampaignSettingsController = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { min_transaction_amount, receipt_example_image_url } = req.body as {
      min_transaction_amount: number | null;
      receipt_example_image_url?: string | null;
    };

    const data: { min_transaction_amount: number | null; receipt_example_image_url?: string | null } = {
      min_transaction_amount,
    };
    if ('receipt_example_image_url' in req.body) {
      data.receipt_example_image_url = receipt_example_image_url ?? null;
    }

    const result = await updateCampaignSettings(req.user!.id, data);
    res.json({ success: true, isPending: result.isPending });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'BUSINESS_NOT_FOUND') {
      res.status(404).json({ message: 'Business not found' });
      return;
    }
    res.status(500).json({ message: 'Failed to update campaign settings' });
  }
};

export const updateLocation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { locationId } = req.params;
    const { name, address, lat, lon } = req.body as {
      name: string;
      address: string;
      lat: number;
      lon: number;
    };

    await updateBusinessLocation(Number(locationId), req.user!.id, {
      name,
      address,
      lat,
      lon,
    });

    res.status(204).send();
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED_OR_INVALID_LOCATION') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }
    res.status(500).json({ message: 'Failed to update location' });
  }
};

export const addLocation = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { name, address, lat, lon } = req.body as {
    name: string;
    address: string;
    lat: number;
    lon: number;
  };

  let locationId: number | null = null;
  try {
    const pool = getPool();

    // Founding partners are limited to 3 locations
    const foundingCheck = await pool.query(`
      SELECT fm.id FROM founding_member fm
      JOIN business b ON b.id = fm.business_id
      WHERE b.user_id = $1
    `, [userId]);

    if (foundingCheck.rows.length > 0) {
      const locCount = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM business_location bl
         JOIN business b ON b.id = bl.business_id
         WHERE b.user_id = $1 AND bl.is_active = TRUE`,
        [userId],
      );
      if (Number(locCount.rows[0]?.cnt ?? 0) >= 3) {
        res.status(403).json({ message: 'Founding partner accounts are limited to 3 locations. Please contact support to upgrade your plan.' });
        return;
      }
    }

    const result = await addBusinessLocation(userId, { name, address, lat, lon });
    locationId = result.locationId;

    // Get new active location count and sync Stripe quantity
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM business_location bl
       JOIN business b ON b.id = bl.business_id
       WHERE b.user_id = $1 AND bl.is_active = TRUE`,
      [userId],
    );
    const newCount = Number(countResult.rows[0]?.cnt ?? 1);
    await syncSubscriptionQuantity(userId, newCount);

    res.status(201).json({ locationId });
  } catch (error: unknown) {
    // Rollback: delete the newly created location if Stripe sync failed
    if (locationId !== null) {
      try {
        const pool = getPool();
        await pool.query(`DELETE FROM business_location WHERE id = $1`, [locationId]);
      } catch {
        // Rollback failure — log but don't overwrite the original error
      }
    }
    if (error instanceof Error && error.message === 'BUSINESS_NOT_FOUND') {
      res.status(404).json({ message: 'Business not found' });
      return;
    }
    if (error instanceof Error && (error.message.includes('Stripe') || error.message.includes('subscription') || error.message.includes('tier'))) {
      res.status(402).json({ message: 'Plan update failed. Location not added.', detail: error.message });
      return;
    }
    res.status(500).json({ message: 'Failed to add location' });
  }
};

export const deleteLocation = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const locId = Number(req.params.locationId);

  try {
    // Verify ownership + get current active location count before decrement
    const pool = getPool();
    const ownerCheck = await pool.query(
      `SELECT bl.id FROM business_location bl
       JOIN business b ON bl.business_id = b.id
       WHERE bl.id = $1 AND b.user_id = $2 AND bl.is_active = TRUE`,
      [locId, userId],
    );
    if (ownerCheck.rows.length === 0) {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM business_location bl
       JOIN business b ON b.id = bl.business_id
       WHERE b.user_id = $1 AND bl.is_active = TRUE`,
      [userId],
    );
    const currentCount = Number(countResult.rows[0]?.cnt ?? 1);
    if (currentCount <= 1) {
      res.status(400).json({ message: 'You must keep at least one active location.' });
      return;
    }
    const newCount = currentCount - 1;

    // Sync Stripe first — if it fails, abort without touching the DB
    await syncSubscriptionQuantity(userId, newCount);

    // Stripe succeeded — now remove from DB
    await deleteBusinessLocation(locId, userId);
    res.status(200).json({ success: true });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED_OR_INVALID_LOCATION') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }
    if (error instanceof Error && (error.message.includes('Stripe') || error.message.includes('subscription') || error.message.includes('tier'))) {
      res.status(402).json({ message: 'Plan update failed. Location not removed.', detail: error.message });
      return;
    }
    res.status(500).json({ message: 'Failed to delete location' });
  }
};

export const removeManager = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { locationId } = req.params;
    await removeLocationManagerService(Number(locationId), req.user!.id);
    res.status(200).json({ success: true });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED_OR_INVALID_LOCATION') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }
    if (error instanceof Error && error.message === 'NO_MANAGER_ASSIGNED') {
      res.status(400).json({ message: 'No manager assigned to this location' });
      return;
    }
    res.status(500).json({ message: 'Failed to remove manager' });
  }
};

export const getUploadUrl = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const contentType = String(req.query.contentType || '').trim();
    const result = await getPresignedUploadUrl(contentType);
    const r2BaseUrl = process.env.R2_PUBLIC_URL;
    const publicUrl = r2BaseUrl ? `${r2BaseUrl}/business-logos/${result.key}` : null;
    res.json({ ...result, publicUrl });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'R2_NOT_CONFIGURED') {
      res.status(503).json({ message: 'Image upload is not configured yet.' });
      return;
    }
    if (error instanceof Error && error.message === 'INVALID_CONTENT_TYPE') {
      res.status(400).json({ message: 'Only JPEG, PNG, and WebP images are allowed.' });
      return;
    }
    res.status(500).json({ message: 'Failed to generate upload URL.' });
  }
};

export const updateLogo = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { key } = req.body as { key: string };
    if (!key || typeof key !== 'string' || key.includes('..') || key.includes('/')) {
      res.status(400).json({ message: 'key is required' });
      return;
    }
    if (!process.env.R2_PUBLIC_URL) {
      res.status(500).json({ message: 'Storage not configured' });
      return;
    }
    await updateBusinessLogo(req.user!.id, key);
    res.status(204).send();
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'BUSINESS_NOT_FOUND') {
      res.status(404).json({ message: 'Business not found' });
      return;
    }
    res.status(500).json({ message: 'Failed to update logo' });
  }
};

export const createInviteLink = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { locationId } = req.params;

    const inviteLink = await createManagerInviteLink(
      Number(locationId),
      req.user!.id,
    );

    res.json({ inviteLink });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED_OR_INVALID_LOCATION') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }
    res.status(500).json({ message: 'Failed to generate invite link' });
  }
};
