import { getPool } from '../../shared/db/db.js';
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
  lat: number,
  lon: number,
  radius: number = 10,
): Promise<NearbyBusiness[]> => {
  const pool = getPool();

  const query = `
    SELECT
      loc.id AS location_id,
      loc.address,
      loc.latitude,
      loc.longitude,
      b.id,
      b.description,
      b.terms_text,
      b.name,
      b.sector,
      b.logo_url,
      b.receipt_example_image_url,
      b.min_transaction_amount,
      b.website_url,
      b.phone,
      (
        SELECT COALESCE(json_agg(json_build_object('id', bl2.id, 'name', bl2.name, 'address', bl2.address) ORDER BY bl2.id), '[]'::json)
        FROM business_location bl2
        WHERE bl2.business_id = b.id AND bl2.is_active = true AND bl2.id != loc.id
      ) AS other_locations,
      (6371 * acos(
        LEAST(1.0, GREATEST(-1.0,
          cos($1 * 0.0174532925) * cos(loc.latitude * 0.0174532925) * cos((loc.longitude * 0.0174532925) - ($2 * 0.0174532925)) +
          sin($1 * 0.0174532925) * sin(loc.latitude * 0.0174532925)
        ))
      )) AS distance_km
    FROM business_location loc
    INNER JOIN business b ON loc.business_id = b.id
    WHERE loc.is_active = true AND b.is_subscribed = true AND b.is_participating = true
      AND (6371 * acos(
        LEAST(1.0, GREATEST(-1.0,
          cos($1 * 0.0174532925) * cos(loc.latitude * 0.0174532925) * cos((loc.longitude * 0.0174532925) - ($2 * 0.0174532925)) +
          sin($1 * 0.0174532925) * sin(loc.latitude * 0.0174532925)
        ))
      )) <= $3
    ORDER BY distance_km
  `;

  const result = await pool.query(query, [lat, lon, radius]);
  return result.rows;
};

export const getAddress = async (text: string): Promise<AddressSuggestion[]> => {
  const q = (text || '').trim();
  if (q.length < 3) return [];

  const apiKey = process.env.GOOGLE_PLACES_API;
  if (!apiKey) throw new Error('Missing GOOGLE_PLACES_API');

  // Places API (New) — Text Search returns formattedAddress + coordinates in one call
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.formattedAddress,places.location',
    },
    body: JSON.stringify({ textQuery: q, pageSize: 8 }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google Places error: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`);
  }

  const data = (await res.json()) as GooglePlacesResponse;

  const uniq = new Map<string, AddressSuggestion>();
  for (const place of data.places ?? []) {
    const label = (place as GooglePlaceResult).formattedAddress?.trim();
    const loc = (place as GooglePlaceResult).location;
    if (!label || typeof loc?.latitude !== 'number' || typeof loc?.longitude !== 'number') continue;
    if (!uniq.has(label)) uniq.set(label, { label, lat: loc.latitude, lon: loc.longitude });
  }

  return Array.from(uniq.values());
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
      [userId, data.businessName, data.businessSector, data.description, data.min_transaction_amount ?? null],
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
    return { businessId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const getMyBusinessData = async (userId: number): Promise<MyBusinessData | undefined> => {
  const pool = getPool();

  const [bizResult, settingsResult] = await Promise.all([
    pool.query(`
      SELECT
        b.id,
        b.name,
        b.sector,
        b.description,
        b.terms_text,
        b.logo_url,
        b.receipt_example_image_url,
        b.is_subscribed,
        b.is_participating,
        b.entry_mode,
        b.entry_cap,
        b.min_transaction_amount,
        b.website_url,
        b.phone,
        s.status AS subscription_status,
        s.current_period_end,
        s.cancel_at_period_end,
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
    `, [userId]),
    pool.query(`SELECT global_entry_cap FROM platform_settings WHERE id = 1`),
  ]);

  if (!bizResult.rows[0]) return undefined;
  return {
    ...bizResult.rows[0],
    global_entry_cap: settingsResult.rows[0]?.global_entry_cap ?? null,
  };
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

  const token = await jwt.sign(
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
    await client.query(`UPDATE "user" SET role = 'User' WHERE id = $1`, [managerId]);
    await client.query('COMMIT');
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

  const hasManager = ownerCheck.rows[0].manager_user_id !== null;

  if (hasManager) {
    await pool.query(`UPDATE business_location SET is_active = false WHERE id = $1`, [locationId]);
  } else {
    await pool.query(`DELETE FROM business_location WHERE id = $1`, [locationId]);
  }
};

export const updateBusinessLogo = async (ownerUserId: number, logoUrl: string): Promise<void> => {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE business SET logo_url = $1 WHERE user_id = $2`,
    [logoUrl, ownerUserId],
  );
  if (result.rowCount === 0) throw new Error('BUSINESS_NOT_FOUND');
};

export const getEntryModeService = async (): Promise<{ entry_mode: string }> => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT entry_mode FROM business WHERE is_participating = true LIMIT 1`,
  );
  return { entry_mode: result.rows[0]?.entry_mode ?? 'receipt' };
};

export const getParticipatingBusinessesService = async () => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT b.id, b.name, b.sector, b.logo_url, b.entry_mode
    FROM business b
    WHERE b.is_subscribed = true AND b.is_participating = true
    ORDER BY b.name ASC
  `);

  const businesses = result.rows;
  // All participating businesses share the same entry_mode; default to 'receipt' if none found
  const entry_mode = businesses[0]?.entry_mode ?? 'receipt';

  return { entry_mode, businesses };
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
      b.receipt_example_image_url
    FROM business_location bl
    JOIN business b ON bl.business_id = b.id
    WHERE bl.is_active = true AND b.is_subscribed = true AND b.is_participating = true
      AND (
        LOWER(b.name) LIKE LOWER($1) OR
        LOWER(bl.name) LIKE LOWER($1) OR
        LOWER(bl.address) LIKE LOWER($1)
      )
    ORDER BY b.name ASC, bl.name ASC
    LIMIT 20`,
    [`%${query}%`],
  );
  return result.rows;
};

export const getParticipatingLocationByIdService = async (locationId: number): Promise<ParticipatingLocation | null> => {
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
      b.receipt_example_image_url
    FROM business_location bl
    JOIN business b ON bl.business_id = b.id
    WHERE bl.id = $1 AND bl.is_active = true AND b.is_subscribed = true AND b.is_participating = true`,
    [locationId],
  );
  return result.rows[0] ?? null;
};

export const updateCampaignSettings = async (
  ownerUserId: number,
  data: UpdateCampaignSettingsInput,
): Promise<void> => {
  const pool = getPool();
  // receipt_example_image_url: if key present in data (even null) → update it;
  // if absent → leave existing value untouched via COALESCE pattern
  const updateExampleImage = 'receipt_example_image_url' in data;
  const result = await pool.query(
    `UPDATE business
     SET min_transaction_amount   = $1,
         receipt_example_image_url = CASE WHEN $2 THEN $3 ELSE receipt_example_image_url END
     WHERE user_id = $4`,
    [
      data.min_transaction_amount,
      updateExampleImage,
      data.receipt_example_image_url ?? null,
      ownerUserId,
    ],
  );
  if (result.rowCount === 0) throw new Error('BUSINESS_NOT_FOUND');
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
