import { getPool, sql } from '../../shared/db/db.js';
import {
  AddressSuggestion,
  BusinessSetupInput,
  GeoapifyResponse,
  GeoapifyResult,
  MyBusinessData,
  NearbyBusiness,
  UpdateBusinessInput,
  UpdateLocationInput,
} from './business.types.js';
import jwt from 'jsonwebtoken';
export const getNearbyBusinessesService = async (
  lat: number,
  lon: number,
  radius: number = 10,
): Promise<NearbyBusiness[]> => {
  const pool = getPool();

  // Haversine formula for MSSQL
  // We JOIN business_location (loc) with business (b)
  const query = `
    SELECT 
      loc.id AS location_id,
      loc.address,
      loc.latitude,
      loc.longitude,
      b.id ,
      b.description,
      b.terms_text,
      b.name ,
      b.sector,
      b.logo_url,
      (6371 * acos(
        LEAST(1.0, GREATEST(-1.0, 
          cos(@lat * 0.0174532925) * cos(loc.latitude * 0.0174532925) * cos((loc.longitude * 0.0174532925) - (@lon * 0.0174532925)) + 
          sin(@lat * 0.0174532925) * sin(loc.latitude * 0.0174532925)
        ))
      )) AS distance_km
    FROM business_location loc
    INNER JOIN business b ON loc.business_id = b.id
    WHERE loc.is_active = 1 AND (6371 * acos(
        LEAST(1.0, GREATEST(-1.0, 
          cos(@lat * 0.0174532925) * cos(loc.latitude * 0.0174532925) * cos((loc.longitude * 0.0174532925) - (@lon * 0.0174532925)) + 
          sin(@lat * 0.0174532925) * sin(loc.latitude * 0.0174532925)
        ))
      )) <= @radius
    ORDER BY distance_km;
  `;

  const result = await pool
    .request()
    .input('lat', sql.Decimal(10, 8), lat)
    .input('lon', sql.Decimal(11, 8), lon)
    .input('radius', sql.Int, radius)
    .query(query);

  return result.recordset;
};
export const getAddress = async (
  text: string,
): Promise<AddressSuggestion[]> => {
  const q = (text || '').trim();
  if (q.length < 3) return [];

  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) throw new Error('Missing GEOAPIFY_API_KEY');

  const url = new URL('https://api.geoapify.com/v1/geocode/autocomplete');
  url.searchParams.set('text', q);
  url.searchParams.set('format', 'json');
  url.searchParams.set('apiKey', apiKey);
  // ask for more, we’ll cut to 8 after sorting/dedupe
  url.searchParams.set('limit', '20');

  // ✅ IMPORTANT: do NOT restrict to city. We want streets + cities + addresses.
  // url.searchParams.delete("type"); // (no need to set anything)

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Geoapify error: ${res.status} ${res.statusText}${body ? ` - ${body}` : ''}`,
    );
  }

  const data = (await res.json()) as GeoapifyResponse;

  const toLabel = (r: GeoapifyResult): string =>
    (
      r.formatted ||
      [r.address_line1, r.address_line2].filter(Boolean).join(', ') ||
      r.name ||
      ''
    ).trim();

  const results = (data.results || [])
    .filter((r: GeoapifyResult) => typeof r.lat === 'number' && typeof r.lon === 'number')
    // Prefer higher confidence/importance when provided
    .sort((a: GeoapifyResult, b: GeoapifyResult) => {
      const ac = a.rank?.confidence ?? a.rank?.importance ?? 0;
      const bc = b.rank?.confidence ?? b.rank?.importance ?? 0;
      return bc - ac;
    });

  // ✅ dedupe by label so you don’t get repeats
  const uniq = new Map<string, AddressSuggestion>();
  for (const r of results) {
    const label = toLabel(r);
    if (!label) continue;

    if (!uniq.has(label)) {
      uniq.set(label, { label, lat: r.lat, lon: r.lon });
    }

    if (uniq.size >= 8) break;
  }

  return Array.from(uniq.values());
};
export const createFullBusinessProfile = async (
  userId: number,
  data: BusinessSetupInput, // No more businessName parameter
) => {
  const pool = getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    // 1. Fetch the User's Name to use as the Business Name
    const userResult = await transaction
      .request()
      .input('userId', sql.Int, userId)
      .query('SELECT full_name FROM [user] WHERE id = @userId');

    if (userResult.recordset.length === 0) {
      throw new Error('User not found');
    }

    const businessName = userResult.recordset[0].full_name;

    // 2. Create the Business Record using the fetched name
    const businessResult = await transaction
      .request()
      .input('userId', sql.Int, userId)
      .input('Name', sql.NVarChar, businessName)
      .input('Sector', sql.NVarChar, data.businessSector)
      .input('Description', sql.NVarChar, data.description)
      .input('Terms', sql.NVarChar, data.terms_text).query(`
        INSERT INTO business (user_id, name, sector,description, terms_text)
        OUTPUT INSERTED.id
        VALUES (@userId, @Name, @Sector, @Description,@Terms)
      `);

    const businessId = businessResult.recordset[0].id;

    // 3. Insert all Locations
    for (const loc of data.locations) {
      await transaction
        .request()
        .input('BusinessId', sql.Int, businessId)
        .input('LocName', sql.NVarChar, loc.name || 'Main Branch')
        .input('Address', sql.NVarChar, loc.address)
        .input('Lat', sql.Decimal(10, 8), loc.lat)
        .input('Lon', sql.Decimal(11, 8), loc.lon).query(`
          INSERT INTO business_location (business_id, name, address, latitude, longitude, is_active)
          VALUES (@BusinessId, @LocName, @Address, @Lat, @Lon, 1)
        `);
    }

    await transaction.commit();
    return { businessId };
  } catch (error) {
    // If anything fails (even the name fetch), we roll back
    await transaction.rollback();
    throw error;
  }
};
// server/src/features/business/business.service.ts

export const getMyBusinessData = async (userId: number): Promise<MyBusinessData | undefined> => {
  const pool = getPool(); // Following your standard DB pattern

  const result = await pool.request().input('userId', sql.Int, userId).query(`
      SELECT 
        b.id, 
        b.name, 
        b.sector, 
        b.description, 
        b.terms_text,
        s.status as subscription_status,
        s.monthly_fee,
        s.next_billing_date,
        (
          SELECT 
            bl.id, 
            bl.name, 
            bl.address, 
            bl.user_id as manager_id, 
            u.full_name as manager_name,
            bl.is_active
          FROM business_location bl
          LEFT JOIN [user] u ON bl.user_id = u.id
          WHERE bl.business_id = b.id
          FOR JSON PATH
        ) as locations
      FROM business b
      LEFT JOIN subscription s ON b.id = s.business_id
      WHERE b.user_id = @userId
    `);

  const business = result.recordset[0];

  // MSSQL returns JSON as a string; we must parse it for the frontend
  if (business && business.locations) {
    business.locations = JSON.parse(business.locations);
  }

  return business;
};

export const createManagerInviteLink = async (
  locationId: number,
  ownerUserId: number,
) => {
  const pool = getPool();

  // 1. Fetch the business_id while verifying the ownership chain
  // We join business and business_location to ensure the owner owns the location
  const result = await pool
    .request()
    .input('locId', sql.Int, locationId)
    .input('ownerId', sql.Int, ownerUserId).query(`
      SELECT b.id AS business_id
      FROM business b
      JOIN business_location bl ON b.id = bl.business_id
      WHERE b.user_id = @ownerId AND bl.id = @locId
    `);

  const businessRecord = result.recordset[0];

  // 2. Security Check: If no record is found, the link is broken or unauthorized
  if (!businessRecord) {
    throw new Error('UNAUTHORIZED_OR_INVALID_LOCATION');
  }

  const businessId = businessRecord.business_id;

  // 3. Generate the Token (1 hour expiry as requested)
  const token = await jwt.sign(
    {
      locationId,
      businessId,
      type: 'MANAGER_INVITE',
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' },
  );

  // 4. Construct the professional link
  const baseUrl = process.env.CLIENT_URL || 'http://localhost:8081';
  return `${baseUrl}/register/Location?token=${token}`;
};
export const updateBusinessProfile = async (
  ownerUserId: number,
  data: UpdateBusinessInput,
): Promise<void> => {
  const pool = getPool();

  const result = await pool
    .request()
    .input('ownerId', sql.Int, ownerUserId)
    .input('sector', sql.NVarChar, data.businessSector)
    .input('description', sql.NVarChar, data.description)
    .input('terms_text', sql.NVarChar, data.terms_text)
    .query(`
      UPDATE business
      SET sector      = @sector,
          description = @description,
          terms_text  = @terms_text
      WHERE user_id = @ownerId
    `);

  if (result.rowsAffected[0] === 0) {
    throw new Error('BUSINESS_NOT_FOUND');
  }
};

export const updateBusinessLocation = async (
  locationId: number,
  ownerUserId: number,
  data: UpdateLocationInput,
): Promise<void> => {
  const pool = getPool();

  const result = await pool
    .request()
    .input('locId', sql.Int, locationId)
    .input('ownerId', sql.Int, ownerUserId)
    .input('name', sql.NVarChar, data.name)
    .input('address', sql.NVarChar, data.address)
    .input('lat', sql.Decimal(10, 8), data.lat)
    .input('lon', sql.Decimal(11, 8), data.lon)
    .query(`
      UPDATE bl
      SET bl.name      = @name,
          bl.address   = @address,
          bl.latitude  = @lat,
          bl.longitude = @lon
      FROM business_location bl
      JOIN business b ON bl.business_id = b.id
      WHERE bl.id = @locId AND b.user_id = @ownerId
    `);

  if (result.rowsAffected[0] === 0) {
    throw new Error('UNAUTHORIZED_OR_INVALID_LOCATION');
  }
};

export const getBusinessLocationsByUserId = async (userId: number) => {
  const pool = await getPool();
  const result = await pool.request()
    .input('userId', userId)
    .query(`
      SELECT bl.id 
      FROM business_location bl
      JOIN business b ON bl.business_id = b.id
      WHERE b.user_id = @userId 
      ORDER BY bl.created_at ASC
    `);

  return result.recordset; // Returns array of locations
};