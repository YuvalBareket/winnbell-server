import { getPool } from '../../shared/db/db.js';
import { publicCache, invalidatePublicBusinessData, getPlatformSettings, invalidateUserAuth } from '../../shared/cache/cache.js';
import type { PoolClient } from 'pg';
import crypto from 'crypto';
import {
  AddLocationInput,
  AddressSuggestion,
  BusinessSetupInput,
  GooglePlaceResult,
  GooglePlacesResponse,
  MyBusinessData,
  NearbyBusiness,
  ParticipatingLocation,
  UpdateBusinessInput,
  UpdateCampaignSettingsInput,
  UpdateLocationInput,
} from './business.types.js';
import jwt from 'jsonwebtoken';

export const getNearbyBusinessesService = async (
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number,
  sector?: string,
  limit = 30,
  name?: string,
): Promise<NearbyBusiness[]> => {
  const CACHE_KEY = `business:nearby:${Math.round(minLat * 100)}:${Math.round(maxLat * 100)}:${Math.round(minLng * 100)}:${Math.round(maxLng * 100)}:${sector || 'all'}:${name || ''}`;
  const cached = publicCache.get<NearbyBusiness[]>(CACHE_KEY);
  if (cached !== undefined) return cached;

  const pool = getPool();

  const cappedLimit = Math.min(limit, 100);
  const params: (number | string)[] = [minLat, maxLat, minLng, maxLng];
  const sectorClause = sector ? `AND b.sector = $${params.push(sector)}` : '';
  const nameClause = name ? `AND b.name ILIKE $${params.push(`%${name}%`)}` : '';
  const limitPlaceholder = `$${params.push(name ? 100 : cappedLimit)}`;

  const query = `
    SELECT
      loc.id AS location_id,
      loc.address,
      loc.latitude,
      loc.longitude,
      b.id,
      b.name,
      b.sector,
      b.logo_url
    FROM business_location loc
    INNER JOIN business b ON loc.business_id = b.id
    JOIN subscription s ON s.business_id = b.id AND s.status IN ('Active', 'Trialing')
    WHERE loc.is_active = true
      AND EXISTS (
        SELECT 1 FROM draw_entry de
        JOIN draw d ON d.id = de.draw_id
        WHERE de.business_id = b.id AND d.status = 'Open'
      )
      AND loc.latitude  BETWEEN $1 AND $2
      AND loc.longitude BETWEEN $3 AND $4
      ${sectorClause}
      ${nameClause}
    ORDER BY
      (loc.latitude  - ($1 + $2) / 2.0) * (loc.latitude  - ($1 + $2) / 2.0) +
      (loc.longitude - ($3 + $4) / 2.0) * (loc.longitude - ($3 + $4) / 2.0)
    LIMIT ${limitPlaceholder}
  `;

  const result = await pool.query(query, params);
  // 2-minute TTL: map data only changes when a draw opens/closes or a business
  // subscribes, none of which need second-level freshness. Draw open/close also
  // explicitly invalidates these keys, so the TTL is just a backstop for the rest.
  publicCache.set(CACHE_KEY, result.rows, 120);
  return result.rows;
};

// Returns label + placeId only — coordinates are fetched separately on selection
export const getAddress = async (text: string): Promise<{ label: string; placeId: string }[]> => {
  const q = (text || '').trim();
  if (q.length < 3) return [];

  const apiKey = process.env.GOOGLE_PLACES_API;
  if (!apiKey) throw new Error('Missing GOOGLE_PLACES_API');

  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
    body: JSON.stringify({
      input: q,
      includedPrimaryTypes: ['street_address', 'route', 'establishment', 'premise', 'point_of_interest'],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Google Autocomplete error: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
    throw new Error('Address search unavailable');
  }

  const data = await res.json() as { suggestions?: Array<{ placePrediction?: { placeId?: string; text?: { text?: string } } }> };

  return (data.suggestions ?? [])
    .map(s => s.placePrediction)
    .filter((p): p is { placeId: string; text: { text: string } } => !!p?.placeId && !!p?.text?.text)
    .slice(0, 6)
    .map(p => ({ label: p.text.text, placeId: p.placeId }));
};

// Fetches coordinates for a selected placeId — called once when user picks a suggestion
export const getAddressCoords = async (placeId: string): Promise<{ lat: number; lon: number; label: string }> => {
  const apiKey = process.env.GOOGLE_PLACES_API;
  if (!apiKey) throw new Error('Missing GOOGLE_PLACES_API');

  const res = await fetch(
    // encode the client-supplied placeId so it can't inject path/query into the external URL
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?fields=formattedAddress,location`,
    { headers: { 'X-Goog-Api-Key': apiKey } },
  );

  if (!res.ok) {
    console.error(`Google Place Details error: ${res.status}`);
    throw new Error('Could not resolve address coordinates');
  }

  const data = await res.json() as { formattedAddress?: string; location?: { latitude: number; longitude: number } };
  const label = data.formattedAddress?.trim();
  const loc = data.location;
  if (!label || typeof loc?.latitude !== 'number') throw new Error('Invalid place details response');

  return { label, lat: loc.latitude, lon: loc.longitude };
};

export const createFullBusinessProfile = async (userId: number, data: BusinessSetupInput) => {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const businessResult = await client.query(
      `INSERT INTO business (user_id, name, sector, description, min_transaction_amount)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      // A specific minimum is mandatory; default to $50 when the setup form omits one.
      [userId, data.businessName, data.businessSector, data.description, data.min_transaction_amount ?? 50],
    );
    const businessId = businessResult.rows[0].id;

    for (const loc of data.locations) {
      await client.query(
        `INSERT INTO business_location (business_id, name, address, latitude, longitude, is_active)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [businessId, loc.name || 'Main Branch', loc.address, loc.lat, loc.lon],
      );
    }

    await client.query('COMMIT');
    invalidatePublicBusinessData();
    return { businessId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const getMyBusinessData = async (userId: number, managedLocationId?: number | null): Promise<MyBusinessData | undefined> => {
  const pool = getPool();

  const [bizResult, platformSettings] = await Promise.all([
    pool.query(`
      SELECT
        b.id,
        b.name,
        b.sector,
        b.description,
        b.terms_text,
        b.logo_url,
        b.receipt_example_image_url,
        b.entry_mode,
        b.min_transaction_amount,
        b.pending_min_transaction_amount,
        b.website_url,
        b.phone,
        (s.status IN ('Active', 'Trialing')) AS is_subscribed,
        s.status AS subscription_status,
        s.current_period_end,
        s.cancel_at_period_end,
        s.entries_per_location,
        (
          SELECT COALESCE(json_agg(json_build_object(
            'id', bl.id,
            'name', bl.name,
            'address', bl.address,
            'latitude', bl.latitude,
            'longitude', bl.longitude,
            'manager_id', bl.manager_user_id,
            'manager_name', u.full_name,
            'is_active', bl.is_active
          )), '[]'::json)
          FROM business_location bl
          LEFT JOIN "user" u ON bl.manager_user_id = u.id
          WHERE bl.business_id = b.id
        ) AS locations
      FROM business b
      LEFT JOIN subscription s ON b.id = s.business_id
      WHERE b.user_id = $1
         OR b.id IN (SELECT business_id FROM business_location WHERE manager_user_id = $1)
    `, [userId]),
    getPlatformSettings(),
  ]);

  if (!bizResult.rows[0]) return undefined;

  const row = bizResult.rows[0];
  const full: MyBusinessData = {
    ...row,
    global_entry_cap: platformSettings.global_entry_cap ?? null,
  };

  if (managedLocationId != null && Array.isArray(full.locations)) {
    return {
      ...full,
      locations: full.locations.filter((l: { id: number }) => l.id === managedLocationId),
    };
  }

  return full;
};

export const createManagerInviteLink = async (locationId: number, ownerUserId: number) => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT b.id AS business_id
    FROM business b
    JOIN business_location bl ON b.id = bl.business_id
    WHERE b.user_id = $1 AND bl.id = $2
  `, [ownerUserId, locationId]);

  const businessRecord = result.rows[0];
  if (!businessRecord) throw new Error('UNAUTHORIZED_OR_INVALID_LOCATION');

  const businessId = businessRecord.business_id;

  const token = jwt.sign(
    { locationId, businessId, type: 'MANAGER_INVITE' },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' },
  );

  // Store a hash of the token so we can invalidate it after first use (single-use enforcement)
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `UPDATE business_location SET invite_token_hash = $1, invite_used_at = NULL WHERE id = $2`,
    [tokenHash, locationId],
  );

  const baseUrl = (process.env.CLIENT_URL || 'http://localhost:8081').split(',')[0].trim();
  return `${baseUrl}/register/Location?token=${token}`;
};

// Demote a detached manager to a regular 'User' (unless they own a business or
// still manage another location) and revoke all their sessions, so they are
// thrown out and re-sync from the DB as a regular user on next sign-in. Assumes
// the manager has already been detached from the relevant location in this tx.
async function demoteFormerManager(client: PoolClient, managerId: number): Promise<void> {
  await client.query(
    `UPDATE "user" SET role = 'User'
     WHERE id = $1
       AND role != 'Admin'
       AND NOT EXISTS (SELECT 1 FROM business WHERE user_id = $1)
       AND NOT EXISTS (SELECT 1 FROM business_location WHERE manager_user_id = $1 AND is_active = TRUE)`,
    [managerId],
  );
  // Revoke every refresh token so they cannot keep refreshing into a manager
  // session; their next sign-in re-syncs their (now demoted) role from the DB.
  await client.query(`DELETE FROM refresh_token WHERE user_id = $1`, [managerId]);
}

export const removeLocationManagerService = async (locationId: number, ownerUserId: number): Promise<void> => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT bl.manager_user_id
    FROM business_location bl
    JOIN business b ON bl.business_id = b.id
    WHERE bl.id = $1 AND b.user_id = $2
  `, [locationId, ownerUserId]);

  if (result.rows.length === 0) throw new Error('UNAUTHORIZED_OR_INVALID_LOCATION');

  const managerId = result.rows[0].manager_user_id;
  if (!managerId) throw new Error('NO_MANAGER_ASSIGNED');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE business_location SET manager_user_id = NULL WHERE id = $1`, [locationId]);
    await demoteFormerManager(client, managerId);
    await client.query('COMMIT');
    invalidatePublicBusinessData();
    invalidateUserAuth(managerId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const updateBusinessProfile = async (ownerUserId: number, data: UpdateBusinessInput): Promise<void> => {
  const pool = getPool();

  const result = await pool.query(`
    UPDATE business
    SET sector = $1, description = $2, terms_text = $3, website_url = $4, phone = $5
    WHERE user_id = $6
  `, [data.businessSector, data.description, data.terms_text, data.website_url ?? null, data.phone ?? null, ownerUserId]);

  if (result.rowCount === 0) throw new Error('BUSINESS_NOT_FOUND');

  invalidatePublicBusinessData();
};

export const updateBusinessLocation = async (
  locationId: number,
  ownerUserId: number,
  data: UpdateLocationInput,
): Promise<void> => {
  const pool = getPool();

  const result = await pool.query(`
    UPDATE business_location
    SET name = $1, address = $2, latitude = $3, longitude = $4
    FROM business
    WHERE business_location.business_id = business.id
      AND business_location.id = $5
      AND business.user_id = $6
  `, [data.name, data.address, data.lat, data.lon, locationId, ownerUserId]);

  if (result.rowCount === 0) throw new Error('UNAUTHORIZED_OR_INVALID_LOCATION');

  invalidatePublicBusinessData();
  publicCache.del('business:location:' + locationId);
};

export const addBusinessLocation = async (ownerUserId: number, data: AddLocationInput): Promise<{ locationId: number }> => {
  const pool = getPool();

  const ownerCheck = await pool.query(`SELECT id FROM business WHERE user_id = $1`, [ownerUserId]);
  if (ownerCheck.rows.length === 0) throw new Error('BUSINESS_NOT_FOUND');

  const businessId = ownerCheck.rows[0].id;

  const result = await pool.query(`
    INSERT INTO business_location (business_id, name, address, latitude, longitude, is_active)
    VALUES ($1, $2, $3, $4, $5, true)
    RETURNING id
  `, [businessId, data.name, data.address, data.lat, data.lon]);

  invalidatePublicBusinessData();
  return { locationId: result.rows[0].id };
};

export const deleteBusinessLocation = async (locationId: number, ownerUserId: number): Promise<void> => {
  const pool = getPool();

  const ownerCheck = await pool.query(`
    SELECT bl.id, bl.manager_user_id
    FROM business_location bl
    JOIN business b ON bl.business_id = b.id
    WHERE bl.id = $1 AND b.user_id = $2
  `, [locationId, ownerUserId]);

  if (ownerCheck.rows.length === 0) throw new Error('UNAUTHORIZED_OR_INVALID_LOCATION');

  const managerId: number | null = ownerCheck.rows[0].manager_user_id ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Soft-delete the location and detach its manager so the demotion check below
    // does not still see this location as one they manage.
    await client.query(`UPDATE business_location SET is_active = false, manager_user_id = NULL WHERE id = $1`, [locationId]);
    if (managerId) await demoteFormerManager(client, managerId);
    await client.query('COMMIT');
    invalidatePublicBusinessData();
    publicCache.del('business:location:' + locationId);
    if (managerId) invalidateUserAuth(managerId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const updateBusinessLogo = async (ownerUserId: number, logoUrl: string): Promise<void> => {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE business SET logo_url = $1 WHERE user_id = $2`,
    [logoUrl, ownerUserId],
  );
  if (result.rowCount === 0) throw new Error('BUSINESS_NOT_FOUND');

  invalidatePublicBusinessData();
};

export const getEntryModeService = async (): Promise<{ entry_mode: string }> => {
  const CACHE_KEY = 'business:entry_mode';
  const cached = publicCache.get<{ entry_mode: string }>(CACHE_KEY);
  if (cached !== undefined) return cached;

  const pool = getPool();
  const result = await pool.query(
    `SELECT b.entry_mode FROM business b
     JOIN subscription s ON s.business_id = b.id AND s.status IN ('Active', 'Trialing')
     WHERE EXISTS (
       SELECT 1 FROM draw_entry de
       JOIN draw d ON d.id = de.draw_id
       WHERE de.business_id = b.id AND d.status = 'Open'
     )
     LIMIT 1`,
  );
  const value = { entry_mode: result.rows[0]?.entry_mode ?? 'receipt' };
  publicCache.set(CACHE_KEY, value, 300);
  return value;
};

export const getParticipatingBusinessesService = async () => {
  const CACHE_KEY = 'business:participating';
  const cached = publicCache.get(CACHE_KEY);
  if (cached !== undefined) return cached;

  const pool = getPool();

  const result = await pool.query(`
    SELECT b.id, b.name, b.sector, b.logo_url, b.entry_mode
    FROM business b
    JOIN subscription s ON s.business_id = b.id AND s.status IN ('Active', 'Trialing')
    WHERE EXISTS (
      SELECT 1 FROM draw_entry de
      JOIN draw d ON d.id = de.draw_id
      WHERE de.business_id = b.id AND d.status = 'Open'
    )
    ORDER BY b.name ASC
  `);

  const businesses = result.rows;
  // All participating businesses share the same entry_mode; default to 'receipt' if none found
  const entry_mode = businesses[0]?.entry_mode ?? 'receipt';

  const value = { entry_mode, businesses };
  publicCache.set(CACHE_KEY, value, 60);
  return value;
};

export const searchParticipatingLocationsService = async (query: string): Promise<ParticipatingLocation[]> => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT
      bl.id AS location_id,
      bl.name AS location_name,
      bl.address,
      b.id AS business_id,
      b.name AS business_name,
      b.sector,
      b.logo_url,
      b.min_transaction_amount,
      b.pending_min_transaction_amount,
      b.receipt_example_image_url,
      (
        SELECT COUNT(*)::int FROM ticket t
        WHERE t.business_id = b.id
          AND t.location_id = bl.id
          AND t.draw_id = (SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1)
          AND t.is_quarantined = FALSE
      ) >= COALESCE(s.entries_per_location, (SELECT global_entry_cap FROM platform_settings WHERE id = 1)) AS cap_reached
    FROM business_location bl
    JOIN business b ON bl.business_id = b.id
    JOIN subscription s ON s.business_id = b.id AND s.status IN ('Active', 'Trialing')
    WHERE bl.is_active = true
      AND EXISTS (
        SELECT 1 FROM draw_entry de
        JOIN draw d ON d.id = de.draw_id
        WHERE de.business_id = b.id AND d.status = 'Open'
      )
      AND (
        b.name ILIKE $1 OR
        bl.name ILIKE $1 OR
        bl.address ILIKE $1
      )
    ORDER BY b.name ASC, bl.name ASC
    LIMIT 20`,
    [`%${query}%`],
  );
  return result.rows;
};

export const getParticipatingLocationByIdService = async (locationId: number): Promise<ParticipatingLocation | null> => {
  const CACHE_KEY = `business:location:${locationId}`;
  const cached = publicCache.get<ParticipatingLocation | null>(CACHE_KEY);
  if (cached !== undefined) return cached;

  const pool = getPool();
  const result = await pool.query(
    `WITH open_draw AS (
      SELECT id, prize_pool, draw_date FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1
    )
    SELECT
      bl.id AS location_id,
      bl.name AS location_name,
      bl.address,
      bl.latitude,
      bl.longitude,
      b.id AS business_id,
      b.name AS business_name,
      b.sector,
      b.logo_url,
      b.min_transaction_amount,
      b.pending_min_transaction_amount,
      b.receipt_example_image_url,
      b.description,
      b.terms_text,
      b.phone,
      b.website_url,
      (
        SELECT COALESCE(json_agg(json_build_object('id', bl2.id, 'name', bl2.name, 'address', bl2.address) ORDER BY bl2.id), '[]'::json)
        FROM business_location bl2
        WHERE bl2.business_id = b.id AND bl2.is_active = true AND bl2.id != bl.id
      ) AS other_locations,
      (
        SELECT COUNT(*)::int FROM ticket t
        WHERE t.business_id = b.id
          AND t.location_id = bl.id
          AND t.draw_id = (SELECT id FROM open_draw)
          AND t.is_quarantined = FALSE
      ) >= COALESCE(s.entries_per_location, (SELECT global_entry_cap FROM platform_settings WHERE id = 1)) AS cap_reached,
      (SELECT prize_pool FROM open_draw) AS draw_prize_amount,
      (SELECT draw_date FROM open_draw) AS draw_date
    FROM business_location bl
    JOIN business b ON bl.business_id = b.id
    JOIN subscription s ON s.business_id = b.id AND s.status IN ('Active', 'Trialing')
    WHERE bl.id = $1 AND bl.is_active = true
      AND EXISTS (
        SELECT 1 FROM draw_entry de
        JOIN draw d ON d.id = de.draw_id
        WHERE de.business_id = b.id AND d.status = 'Open'
      )`,
    [locationId],
  );
  const value = result.rows[0] ?? null;
  publicCache.set(CACHE_KEY, value, 15);
  return value;
};

export const updateCampaignSettings = async (
  ownerUserId: number,
  data: UpdateCampaignSettingsInput,
): Promise<{ isPending: boolean }> => {
  const pool = getPool();

  // Only defer to pending if the business is actually enrolled in the open draw
  const drawCheck = await pool.query(
    `SELECT de.id FROM draw_entry de
     JOIN draw d ON d.id = de.draw_id
     JOIN business b ON b.id = de.business_id
     WHERE d.status = 'Open' AND b.user_id = $1
     LIMIT 1`,
    [ownerUserId],
  );
  const hasOpenDraw = drawCheck.rows.length > 0;

  const updateExampleImage = 'receipt_example_image_url' in data;

  let result;
  if (hasOpenDraw) {
    // Business is in an active campaign — store as pending, takes effect when draw closes
    result = await pool.query(
      `UPDATE business
       SET pending_min_transaction_amount = $1,
           receipt_example_image_url = CASE WHEN $2 THEN $3 ELSE receipt_example_image_url END
       WHERE user_id = $4`,
      [
        data.min_transaction_amount,
        updateExampleImage,
        data.receipt_example_image_url ?? null,
        ownerUserId,
      ],
    );
  } else {
    // No active campaign — apply immediately
    result = await pool.query(
      `UPDATE business
       SET min_transaction_amount   = $1,
           pending_min_transaction_amount = NULL,
           receipt_example_image_url = CASE WHEN $2 THEN $3 ELSE receipt_example_image_url END
       WHERE user_id = $4`,
      [
        data.min_transaction_amount,
        updateExampleImage,
        data.receipt_example_image_url ?? null,
        ownerUserId,
      ],
    );
  }

  if (result.rowCount === 0) throw new Error('BUSINESS_NOT_FOUND');

  invalidatePublicBusinessData();
  return { isPending: hasOpenDraw };
};

export const getBusinessLocationsByUserId = async (userId: number) => {
  const pool = getPool();
  const result = await pool.query(`
    SELECT bl.id
    FROM business_location bl
    JOIN business b ON bl.business_id = b.id
    WHERE b.user_id = $1 OR bl.manager_user_id = $1
    ORDER BY bl.created_at ASC
  `, [userId]);
  return result.rows;
};
