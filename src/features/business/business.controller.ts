// src/features/business/business.controller.ts
import { Request, Response } from 'express';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import { INearbyQuery } from './business.types.js';
import {
  addBusinessLocation,
  createFullBusinessProfile,
  createManagerInviteToken,
  logBusinessProfileViewService,
  deleteBusinessLocation,
  getAddress,
  getAddressCoords,
  getEntryModeService,
  getMyBusinessData,
  getNearbyBusinessesService,
  getParticipatingBusinessesService,
  getLocationProfileByIdService,
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
import { validateLengths } from '../../shared/validation.js';

// Returns an error string when lat/lon are not valid coordinates, null when OK
const validateCoords = (lat: unknown, lon: unknown): string | null => {
  if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) {
    return 'lat and lon must be numbers.';
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return 'lat/lon out of range.';
  }
  return null;
};

// Reject a non-http(s) website URL so a javascript:/data: value can never be stored and later
// rendered as a link in a customer's browser. Empty is allowed (the field is optional).
const validateWebsiteUrl = (url: unknown): string | null => {
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s) return null;
  // An explicit scheme that isn't http(s) is rejected outright (javascript:, data:, vbscript:, ...).
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s);
  if (hasScheme && !/^https?:\/\//i.test(s)) return 'Website URL must start with http:// or https://';
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Website URL must be http or https';
    return null;
  } catch {
    return 'Website URL is not a valid URL';
  }
};

export const getEntryMode = async (_req: Request, res: Response) => {
  try {
    const result = await getEntryModeService();
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: 'Server error' });
  }
};

export const getParticipating = async (_req: Request, res: Response) => {
  try {
    const result = await getParticipatingBusinessesService();
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: 'Server error' });
  }
};

export const searchParticipatingLocations = async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) { res.json([]); return; }
    if (q.length > 200) { res.status(400).json({ message: 'Search query is too long.' }); return; }
    const locations = await searchParticipatingLocationsService(q);
    res.json(locations);
  } catch (err: unknown) {
    res.status(500).json({ error: 'Server error' });
  }
};

export const getLocationProfileById = async (req: AuthRequest, res: Response) => {
  const locationId = Number(req.params.locationId);
  if (isNaN(locationId)) return res.status(400).json({ message: 'Invalid location ID' });
  try {
    const location = await getLocationProfileByIdService(locationId);
    if (!location) return res.status(404).json({ message: 'Location not found' });
    // Count a profile view here (when the profile is actually fetched) and ONLY for a genuine
    // customer: role 'User' AND no managed location. This excludes Business owners (role 'Business'),
    // Managers (a location_id in the token, even with role 'User') and Admins, so they can never
    // inflate a business's view count. optionalAuth populates req.user when logged in; anonymous
    // callers are simply not counted. Fire-and-forget so analytics never delays or breaks the response.
    if (req.user?.role === 'User' && req.user.location_id == null && location.business_id) {
      logBusinessProfileViewService(req.user.id, location.business_id, location.location_id ?? null)
        .catch((err) => console.error('[profile-view]', err instanceof Error ? err.message : err));
    }
    res.json(location);
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
};

// Gated variant for the submit / scan flow: returns the location only when it is currently
// participating (active + subscribed + enrolled in the open draw), else 404. Not a profile view,
// so it does not record analytics.
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
    const { minLat, maxLat, minLng, maxLng, sector, limit, name } = req.query;

    if (!minLat || !maxLat || !minLng || !maxLng) {
      return res.status(400).json({ message: 'Bounding box params required' });
    }
    if (name && String(name).length > 200) {
      return res.status(400).json({ message: 'Name filter is too long.' });
    }

    const businesses = await getNearbyBusinessesService(
      parseFloat(minLat),
      parseFloat(maxLat),
      parseFloat(minLng),
      parseFloat(maxLng),
      sector,
      limit ? parseInt(limit, 10) : undefined,
      name || undefined,
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
    if (text.length < 2) { res.json([]); return; }
    if (text.length > 200) { res.status(400).json({ message: 'Search query is too long.' }); return; }
    const data = await getAddress(text);
    res.json(data);
  } catch (err: unknown) {
    res.status(400).json({ message: 'Bad request' });
  }
};
export const getAddressCoordsController = async (req: Request, res: Response) => {
  try {
    const placeId = String(req.query.placeId || '').trim();
    if (!placeId) { res.status(400).json({ message: 'placeId required' }); return; }
    if (placeId.length > 500) { res.status(400).json({ message: 'placeId is too long.' }); return; }
    const data = await getAddressCoords(placeId);
    res.json(data);
  } catch (err: unknown) {
    res.status(400).json({ message: 'Bad request' });
  }
};

export const setupBusiness = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { businessName, businessSector, description, terms_text, phone, website_url } = req.body;
    const lenErr = validateLengths([
      ['Business name', businessName, 150],
      ['Sector', businessSector, 50],
      ['Description', description, 2000],
      ['Terms', terms_text, 5000],
      ['Phone', phone, 20],
      ['Website URL', website_url, 500],
    ]);
    if (lenErr) { res.status(400).json({ message: lenErr }); return; }
    const urlErr = validateWebsiteUrl(website_url);
    if (urlErr) { res.status(400).json({ message: urlErr }); return; }

    // Validate location names/addresses/coordinates inside the locations array
    const locations: Array<{ name?: string; address?: string; lat?: unknown; lon?: unknown }> = req.body.locations ?? [];
    for (const loc of locations) {
      const locErr = validateLengths([
        ['Location name', loc.name, 200],
        ['Location address', loc.address, 500],
      ]);
      if (locErr) { res.status(400).json({ message: locErr }); return; }
      const coordErr = validateCoords(loc.lat, loc.lon);
      if (coordErr) { res.status(400).json({ message: coordErr }); return; }
    }

    const result = await createFullBusinessProfile(userId, req.body);

    res.status(201).json({
      success: true,
      message: 'Business profile and locations created successfully',
      businessId: result.businessId,
    });
  } catch (error: unknown) {
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

export const getMyBusiness = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const locationId = req.user!.location_id ?? null; // managers have this set
    const business = await getMyBusinessData(userId, locationId);

    if (!business) {
      res.status(404).json({ message: 'Business profile not found' });
      return;
    }

    res.json(business);
  } catch (error: unknown) {
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

export const updateBusiness = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { businessSector, description, terms_text, phone, website_url } = req.body as {
      businessSector: string;
      description: string;
      terms_text: string;
      phone?: string;
      website_url?: string;
    };

    const lenErr = validateLengths([
      ['Sector', businessSector, 50],
      ['Description', description, 2000],
      ['Terms', terms_text, 5000],
      ['Phone', phone, 20],
      ['Website URL', website_url, 500],
    ]);
    if (lenErr) { res.status(400).json({ message: lenErr }); return; }
    const urlErr = validateWebsiteUrl(website_url);
    if (urlErr) { res.status(400).json({ message: urlErr }); return; }

    await updateBusinessProfile(req.user!.id, { businessSector, description, terms_text, phone, website_url });
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

    // A specific minimum is mandatory — null/"no minimum" is no longer allowed.
    if (
      typeof min_transaction_amount !== 'number' || Number.isNaN(min_transaction_amount) ||
      min_transaction_amount <= 0 || min_transaction_amount > 100000
    ) {
      res.status(400).json({ message: 'A minimum transaction amount is required (a positive number up to 100,000).' });
      return;
    }

    const data: { min_transaction_amount: number; receipt_example_image_url?: string | null } = {
      min_transaction_amount,
    };
    if ('receipt_example_image_url' in req.body) {
      if (receipt_example_image_url) {
        const r2Base = process.env.R2_PUBLIC_URL;
        if (!r2Base || !String(receipt_example_image_url).startsWith(r2Base + '/')) {
          res.status(400).json({ message: 'Invalid receipt example image URL.' });
          return;
        }
      }
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

    const lenErr = validateLengths([['Location name', name, 200], ['Address', address, 500]]);
    if (lenErr) { res.status(400).json({ message: lenErr }); return; }
    const coordErr = validateCoords(lat, lon);
    if (coordErr) { res.status(400).json({ message: coordErr }); return; }

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

  const lenErr = validateLengths([['Location name', name, 200], ['Address', address, 500]]);
  if (lenErr) { res.status(400).json({ message: lenErr }); return; }
  const coordErr = validateCoords(lat, lon);
  if (coordErr) { res.status(400).json({ message: coordErr }); return; }

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
    await syncSubscriptionQuantity(userId, newCount, 'location_added');

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
      res.status(402).json({ message: 'Plan update failed. Location not added.' });
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
    await syncSubscriptionQuantity(userId, newCount, 'location_removed');

    // Stripe succeeded — now remove from DB
    await deleteBusinessLocation(locId, userId);
    res.status(200).json({ success: true });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED_OR_INVALID_LOCATION') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }
    if (error instanceof Error && (error.message.includes('Stripe') || error.message.includes('subscription') || error.message.includes('tier'))) {
      res.status(402).json({ message: 'Plan update failed. Location not removed.' });
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
    const size = Number(req.query.size);
    const result = await getPresignedUploadUrl(contentType, 'business-logos', size);
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
    if (error instanceof Error && error.message === 'INVALID_CONTENT_LENGTH') {
      res.status(400).json({ message: 'Invalid file size. Images must be under 10 MB.' });
      return;
    }
    res.status(500).json({ message: 'Failed to generate upload URL.' });
  }
};

export const updateLogo = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { key } = req.body as { key: string };
    if (!key || typeof key !== 'string' || !/^[a-f0-9-]{36}\.(jpeg|jpg|png|webp)$/.test(key)) {
      res.status(400).json({ message: 'Invalid file key.' });
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

    const token = await createManagerInviteToken(
      Number(locationId),
      req.user!.id,
    );

    res.json({ token });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED_OR_INVALID_LOCATION') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }
    res.status(500).json({ message: 'Failed to generate invite link' });
  }
};
