import { getPool } from '../../shared/db/db.js';
import { safeRollback } from '../../shared/db/txn.js';
import { OPEN_DRAW_ID_SUBQUERY } from '../../shared/db/queries.js';
import { publicCache, invalidatePublicBusinessData, invalidatePublicLocation, getPlatformSettings, invalidateUserAuth } from '../../shared/cache/cache.js';
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
  // Cap the user-controlled filter values so they can't bloat the cache key (heap-DoS via
  // unbounded distinct keys). The SAME capped values feed both the key and the query, so a
  // cached entry can never be returned for a different effective filter.
  const safeSector = sector ? String(sector).slice(0, 32) : undefined;
  const safeName = name ? String(name).trim().slice(0, 40) : undefined;

  const CACHE_KEY = `business:nearby:${Math.round(minLat * 100)}:${Math.round(maxLat * 100)}:${Math.round(minLng * 100)}:${Math.round(maxLng * 100)}:${safeSector || 'all'}:${safeName || ''}`;
  const cached = publicCache.get<NearbyBusiness[]>(CACHE_KEY);
  if (cached !== undefined) return cached;

  const pool = getPool();

  // Hard project rule: map responses never exceed 30 rows - name searches included.
  const cappedLimit = Math.min(limit, 30);
  const params: (number | string)[] = [minLat, maxLat, minLng, maxLng];
  const sectorClause = safeSector ? `AND b.sector = $${params.push(safeSector)}` : '';
  const nameClause = safeName ? `AND b.name ILIKE $${params.push(`%${safeName}%`)}` : '';
  const limitPlaceholder = `$${params.push(cappedLimit)}`;

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
    -- Participation = membership in the Open campaign (draw_entry), NOT subscription
    -- status: billing runs on the 24th while campaigns run to month end, so a business
    -- whose subscription ended on the 24th still owns the campaign it paid for.
    -- Exception: participation_paused is a VOLUNTARY opt-out (founding cancel) - the
    -- owner asked to leave the map immediately, so it overrides the draw_entry rule.
    WHERE loc.is_active = true
      AND EXISTS (
        SELECT 1 FROM draw_entry de
        JOIN draw d ON d.id = de.draw_id
        WHERE de.business_id = b.id AND d.status = 'Open'
          AND de.paused_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM subscription sp
        WHERE sp.business_id = b.id AND sp.participation_paused = TRUE
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
      // US-only platform: never suggest addresses outside the United States
      includedRegionCodes: ['us'],
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

    // One user = one business (enforced by UNIQUE(business.user_id) at the schema level). Guard
    // here so a double-submit / retry / direct API call returns a clean "already exists" instead
    // of silently creating a duplicate. The UNIQUE constraint is the race-safe backstop; the
    // controller also maps its 23505 violation to the same 409.
    const existing = await client.query(
      `SELECT id FROM business WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (existing.rows.length > 0) {
      // Let the shared catch ROLLBACK the (empty) transaction and release the client.
      throw new Error('BUSINESS_ALREADY_EXISTS');
    }

    const businessResult = await client.query(
      `INSERT INTO business (user_id, name, legal_name, sector, description, website_url, logo_url, min_transaction_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      // A specific minimum is mandatory; default to $20 when the setup form omits one
      // (the subscribe flow no longer collects it - owners tune it in the Business Hub).
      [userId, data.businessName, data.legal_name?.trim() || null, data.businessSector, data.description, data.website_url || null, data.logo_url || null, data.min_transaction_amount ?? 20],
    );
    const businessId = businessResult.rows[0].id;

    for (const loc of data.locations) {
      await client.query(
        `INSERT INTO business_location (business_id, name, address, suite, phone, latitude, longitude, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [businessId, loc.name || 'Main Branch', loc.address, loc.suite || null, loc.phone || null, loc.lat, loc.lon],
      );
    }

    await client.query('COMMIT');
    invalidatePublicBusinessData();
    return { businessId };
  } catch (error) {
    await safeRollback(client);
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
        b.legal_name,
        b.sector,
        b.description,
        b.terms_text,
        b.logo_url,
        b.receipt_example_image_url,
        b.min_transaction_amount,
        b.pending_min_transaction_amount,
        b.website_url,
        (s.status IN ('Active', 'Trialing')) AS is_subscribed,
        s.status AS subscription_status,
        s.current_period_end,
        s.cancel_at_period_end,
        s.entries_per_location,
        -- Enrolled in the currently OPEN campaign (draw_entry = the paid-participation
        -- record, same rule as the location profile). Gates the pre-save "campaign is
        -- live, change applies next campaign" warning on CampaignCard (audit P2-10).
        -- participation_paused counts as not participating (voluntary cancel/removal),
        -- same exception every public-facing surface applies.
        -- DELIBERATELY no admin-campaign-pause check here: that pause is SILENT toward
        -- the owner (shadow-ban philosophy, pinned by draw-entry-pause.test.ts).
        (EXISTS (
          SELECT 1 FROM draw_entry de JOIN draw d ON d.id = de.draw_id
          WHERE de.business_id = b.id AND d.status = 'Open'
        ) AND COALESCE(s.participation_paused, FALSE) = FALSE) AS is_participating,
        (
          SELECT COALESCE(json_agg(json_build_object(
            'id', bl.id,
            'name', bl.name,
            'address', bl.address,
            'latitude', bl.latitude,
            'longitude', bl.longitude,
            'manager_id', bl.manager_user_id,
            'manager_name', u.full_name,
            'is_active', bl.is_active,
            'activate_at_open', bl.activate_at_open,
            'deactivate_at_open', bl.deactivate_at_open,
            'suite', bl.suite,
            'phone', bl.phone
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

  if (managedLocationId != null) {
    // Location managers get CAMPAIGN facts, never the owner's billing (audit P2-9,
    // same scoping as getSubscriptionDetails). The UI never rendered these for
    // managers, but the raw values were on the wire:
    //  - subscription_status is coarsened to Active/null (is_subscribed already says
    //    that much; Past_Due/Incomplete/Cancelled internals are the owner's business)
    //  - renew/cancel dates and the plan tier (entries_per_location) are nulled
    return {
      ...full,
      subscription_status: full.is_subscribed ? 'Active' : null,
      current_period_end: null,
      cancel_at_period_end: null,
      entries_per_location: null,
      locations: Array.isArray(full.locations)
        ? full.locations.filter((l: { id: number }) => l.id === managedLocationId)
        : full.locations,
    };
  }

  return full;
};

export const createManagerInviteToken = async (locationId: number, ownerUserId: number) => {
  const pool = getPool();

  const result = await pool.query(`
    SELECT b.id AS business_id, bl.manager_user_id
    FROM business b
    JOIN business_location bl ON b.id = bl.business_id
    WHERE b.user_id = $1 AND bl.id = $2
  `, [ownerUserId, locationId]);

  const businessRecord = result.rows[0];
  if (!businessRecord) throw new Error('UNAUTHORIZED_OR_INVALID_LOCATION');

  // One manager per location, enforced at mint time. Accepting an invite overwrites
  // manager_user_id WITHOUT demoting the incumbent (no role reset, no session revoke),
  // which would strand the displaced manager as a business-less 'Business' user. The UI
  // already hides Invite when a manager exists; this guard closes the API path.
  if (businessRecord.manager_user_id != null) throw new Error('LOCATION_HAS_MANAGER');

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

  // Return only the signed invite token. The client builds the full URL from its own origin
  // (window.location.origin + /register/Location?token=), the same way the referral link is
  // built, so the link always matches the environment the owner is actually using.
  return token;
};

// Log a business profile view (Acquisition analytics). One row per (user, business, location):
// repeat opens of the same location bump last_viewed_at (so multiple views = one view). Owner
// self-views and unknown businesses are skipped. Fire-and-forget: callers must never let this
// disrupt the user experience.
export const logBusinessProfileViewService = async (
  userId: number,
  businessId: number,
  locationId: number | null,
): Promise<void> => {
  const pool = getPool();
  // Single round trip (this fires on every map profile tap): the SELECT source skips unknown
  // businesses and owner self-views, and downgrades a location that does not belong to the
  // business to NULL - same semantics as the previous three sequential queries.
  const locId = locationId && Number.isInteger(locationId) && locationId > 0 ? locationId : null;
  await pool.query(
    `INSERT INTO business_profile_view (business_id, location_id, user_id)
     SELECT b.id,
            CASE WHEN EXISTS (SELECT 1 FROM business_location bl WHERE bl.id = $2 AND bl.business_id = b.id)
                 THEN $2::int ELSE NULL END,
            $3
     FROM business b
     WHERE b.id = $1 AND b.user_id != $3
     ON CONFLICT (user_id, business_id, location_id)
     DO UPDATE SET last_viewed_at = NOW()`,
    [businessId, locId, userId],
  );
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
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
};

export const updateBusinessProfile = async (ownerUserId: number, data: UpdateBusinessInput): Promise<void> => {
  const pool = getPool();

  // legal_name: COALESCE keeps the stored value when the client omits it or sends empty -
  // the legal name can be corrected but never cleared from the settings dialog.
  const result = await pool.query(`
    UPDATE business
    SET name = $1, sector = $2, description = $3, terms_text = $4, website_url = $5,
        legal_name = COALESCE($6, legal_name)
    WHERE user_id = $7
  `, [data.businessName.trim(), data.businessSector, data.description, data.terms_text, data.website_url ?? null, data.legal_name?.trim() || null, ownerUserId]);

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
    SET name = $1, address = $2, latitude = $3, longitude = $4, suite = $5, phone = $6
    FROM business
    WHERE business_location.business_id = business.id
      AND business_location.id = $7
      AND business.user_id = $8
  `, [data.name, data.address, data.lat, data.lon, data.suite ?? null, data.phone ?? null, locationId, ownerUserId]);

  if (result.rowCount === 0) throw new Error('UNAUTHORIZED_OR_INVALID_LOCATION');

  invalidatePublicBusinessData();
  invalidatePublicLocation(locationId);
};

export const addBusinessLocation = async (
  ownerUserId: number,
  data: AddLocationInput,
  // While the business participates in the Open campaign, new locations are STAGED
  // (inactive until the next campaign opens) — the running campaign is never changed.
  stageForNextCampaign = false,
): Promise<{ locationId: number }> => {
  const pool = getPool();

  const ownerCheck = await pool.query(`SELECT id FROM business WHERE user_id = $1`, [ownerUserId]);
  if (ownerCheck.rows.length === 0) throw new Error('BUSINESS_NOT_FOUND');

  const businessId = ownerCheck.rows[0].id;

  const result = await pool.query(`
    INSERT INTO business_location (business_id, name, address, suite, phone, latitude, longitude, is_active, activate_at_open)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `, [businessId, data.name, data.address, data.suite ?? null, data.phone ?? null, data.lat, data.lon, !stageForNextCampaign, stageForNextCampaign]);

  invalidatePublicBusinessData();
  return { locationId: result.rows[0].id };
};

// Schedule a location to stop serving when the next campaign opens (used while the
// business participates in the Open campaign — the running campaign keeps the location).
export const scheduleLocationDeactivation = async (locationId: number, ownerUserId: number): Promise<void> => {
  const pool = getPool();
  const result = await pool.query(`
    UPDATE business_location bl
    SET deactivate_at_open = TRUE, updated_at = NOW()
    FROM business b
    WHERE bl.id = $1 AND bl.business_id = b.id AND b.user_id = $2 AND bl.is_active = TRUE
    RETURNING bl.id
  `, [locationId, ownerUserId]);
  if (result.rowCount === 0) throw new Error('UNAUTHORIZED_OR_INVALID_LOCATION');
  invalidatePublicBusinessData();
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
    invalidatePublicLocation(locationId);
    if (managerId) invalidateUserAuth(managerId);
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
};

/** CONTRACT: `logo_url` stores the bare R2 file KEY (e.g. "abc123.webp"), NOT a full URL.
 *  Every consumer must build the URL as `${R2_PUBLIC_URL}/business-logos/${logo_url}`.
 *  (Unlike ticket.receipt_image_url, which stores a full validated URL.) */
export const updateBusinessLogo = async (ownerUserId: number, logoUrl: string): Promise<void> => {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE business SET logo_url = $1 WHERE user_id = $2`,
    [logoUrl, ownerUserId],
  );
  if (result.rowCount === 0) throw new Error('BUSINESS_NOT_FOUND');

  invalidatePublicBusinessData();
};

export const searchParticipatingLocationsService = async (query: string): Promise<ParticipatingLocation[]> => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT
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
      (
        SELECT COUNT(*)::int FROM ticket t
        WHERE t.business_id = b.id
          AND t.location_id = bl.id
          AND t.draw_id = ${OPEN_DRAW_ID_SUBQUERY}
          AND t.is_quarantined = FALSE
      ) >= COALESCE(s.entries_per_location, (SELECT global_entry_cap FROM platform_settings WHERE id = 1)) AS cap_reached
    FROM business_location bl
    JOIN business b ON bl.business_id = b.id
    LEFT JOIN subscription s ON s.business_id = b.id
    WHERE bl.is_active = true
      AND EXISTS (
        SELECT 1 FROM draw_entry de
        JOIN draw d ON d.id = de.draw_id
        WHERE de.business_id = b.id AND d.status = 'Open'
          AND de.paused_at IS NULL
      )
      -- Voluntary opt-out (founding cancel): the owner asked to stop participating,
      -- so search omits the business even though its draw_entry is kept.
      AND COALESCE(s.participation_paused, FALSE) = FALSE
      -- A location at its campaign capacity cannot accept entries, so search (the
      -- "where can I enter" tool) omits it entirely. NULL cap = uncapped, always shown.
      AND (
        SELECT COUNT(*)::int FROM ticket t
        WHERE t.business_id = b.id
          AND t.location_id = bl.id
          AND t.draw_id = ${OPEN_DRAW_ID_SUBQUERY}
          AND t.is_quarantined = FALSE
      ) < COALESCE(s.entries_per_location, (SELECT global_entry_cap FROM platform_settings WHERE id = 1), 2147483647)
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

// Shared fetch for a location's public profile. When `participatingOnly` is true it restores the
// strict gating (active location + enrolled in the current Open draw via draw_entry) used by the
// submit / scan flow so a receipt can only be started for a live, participating location. Do NOT
// re-add a subscription-status filter here: a business that cancelled or lapsed AFTER the campaign
// opened still owns the campaign it paid for (draw_entry is the paid-participation record). Without
// the flag the profile is returned for ANY location (map popup + draw-history winner link).
const fetchLocationProfile = async (
  locationId: number,
  participatingOnly: boolean,
): Promise<ParticipatingLocation | null> => {
  const CACHE_KEY = `business:location:${locationId}:${participatingOnly ? 'participating' : 'any'}`;
  const cached = publicCache.get<ParticipatingLocation | null>(CACHE_KEY);
  if (cached !== undefined) return cached;

  const gate = participatingOnly
    ? `AND bl.is_active
       AND EXISTS (SELECT 1 FROM draw_entry de JOIN draw d ON d.id = de.draw_id WHERE de.business_id = b.id AND d.status = 'Open' AND de.paused_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM subscription sp WHERE sp.business_id = b.id AND sp.participation_paused = TRUE)`
    : '';

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
      bl.phone,
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
      ) >= COALESCE(
            (SELECT entries_per_location FROM subscription WHERE business_id = b.id LIMIT 1),
            (SELECT global_entry_cap FROM platform_settings WHERE id = 1)
          ) AS cap_reached,
      (SELECT prize_pool FROM open_draw) AS draw_prize_amount,
      (SELECT draw_date FROM open_draw) AS draw_date,
      -- active location + enrolled in the open draw (draw_entry = the paid-participation
      -- record; subscription status is NOT consulted, since a subscription that ended on
      -- the 24th still owns the campaign it paid for). participation_paused IS consulted:
      -- it is a voluntary opt-out (founding cancel), not a billing lapse. On the
      -- unconditional fetch this tells the client whether to show "Submit a Receipt".
      (
        bl.is_active
        AND EXISTS (SELECT 1 FROM draw_entry de JOIN draw d ON d.id = de.draw_id WHERE de.business_id = b.id AND d.status = 'Open' AND de.paused_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM subscription sp WHERE sp.business_id = b.id AND sp.participation_paused = TRUE)
      ) AS is_participating
    FROM business_location bl
    JOIN business b ON bl.business_id = b.id
    WHERE bl.id = $1
      ${gate}`,
    [locationId],
  );
  const value = result.rows[0] ?? null;
  publicCache.set(CACHE_KEY, value, 15);
  return value;
};

// Unconditional: ANY location's profile (map popup + draw-history winner link). is_participating
// tells the client whether the submit action applies.
export const getLocationProfileByIdService = (locationId: number): Promise<ParticipatingLocation | null> =>
  fetchLocationProfile(locationId, false);

// Gated: only returns a location that is currently active + subscribed + enrolled in the open draw.
// Used by the submit / scan flow so a receipt can only be started for a live, participating location.
export const getParticipatingLocationByIdService = (locationId: number): Promise<ParticipatingLocation | null> =>
  fetchLocationProfile(locationId, true);

export const updateCampaignSettings = async (
  ownerUserId: number,
  data: UpdateCampaignSettingsInput,
): Promise<{ isPending: boolean }> => {
  const pool = getPool();

  const updateMin = data.min_transaction_amount !== undefined;
  const updateExampleImage = 'receipt_example_image_url' in data;

  if (!updateMin && !updateExampleImage) return { isPending: false };

  // Only the threshold is deferred to "next campaign"; the receipt example always applies now.
  // So we only need the open-draw check when the minimum is actually changing.
  let hasOpenDraw = false;
  if (updateMin) {
    const drawCheck = await pool.query(
      `SELECT de.id FROM draw_entry de
       JOIN draw d ON d.id = de.draw_id
       JOIN business b ON b.id = de.business_id
       WHERE d.status = 'Open' AND b.user_id = $1
       LIMIT 1`,
      [ownerUserId],
    );
    hasOpenDraw = drawCheck.rows.length > 0;
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (updateMin) {
    if (hasOpenDraw) {
      // In an active campaign — store as pending, takes effect when the draw closes.
      sets.push(`pending_min_transaction_amount = $${i++}`);
      params.push(data.min_transaction_amount);
    } else {
      // No active campaign — apply immediately and clear any stale pending value.
      sets.push(`min_transaction_amount = $${i++}`);
      params.push(data.min_transaction_amount);
      sets.push('pending_min_transaction_amount = NULL');
    }
  }

  if (updateExampleImage) {
    sets.push(`receipt_example_image_url = $${i++}`);
    params.push(data.receipt_example_image_url ?? null);
  }

  params.push(ownerUserId);
  const result = await pool.query(
    `UPDATE business SET ${sets.join(', ')} WHERE user_id = $${i}`,
    params,
  );

  if (result.rowCount === 0) throw new Error('BUSINESS_NOT_FOUND');

  invalidatePublicBusinessData();
  return { isPending: hasOpenDraw && updateMin };
};

// ── Free-trial campaign join (September 2026 3-month trial) ─────────────────────
// The trial-era door: a business joins the current campaign directly from the preparation
// checklist, no payment. Targets the OPEN draw, or (before it opens) the earliest Upcoming
// one as a registration. The INSERT mirrors the admin manual-add: a business WITH a
// subscription snapshots its fee/tier; one without gets fee 0 and snapshots the CURRENT
// global entry cap so capacity displays show a number (same display-only semantics as the
// admin add - enforcement always reads the LIVE plan/global values at submission time,
// via the platform_settings.global_entry_cap fallback, the trial cap knob). The
// paused/skip subscription flags are respected so this door can never bypass an explicit
// opt-out, and ON CONFLICT makes a double-click a no-op. Owner-only: managers resolve no
// business row. When paid campaigns return, retire this endpoint together with the client
// button in DrawPreparationView.
export const joinCurrentCampaignService = async (
  ownerUserId: number,
): Promise<{ drawId: number; drawName: string; drawStatus: string }> => {
  const pool = getPool();

  const bizRes = await pool.query(
    `SELECT b.id,
            EXISTS (SELECT 1 FROM business_location bl
                    WHERE bl.business_id = b.id AND bl.is_active = TRUE) AS has_active_location
     FROM business b WHERE b.user_id = $1 ORDER BY b.id LIMIT 1`,
    [ownerUserId],
  );
  if (!bizRes.rows[0]) throw new Error('BUSINESS_NOT_FOUND');
  // A campaign membership without a live location would be invisible on the map and
  // unable to validate receipts - make the location step come first.
  if (!bizRes.rows[0].has_active_location) throw new Error('NO_ACTIVE_LOCATION');
  const businessId: number = bizRes.rows[0].id;

  const drawRes = await pool.query(
    `SELECT id, name, status FROM draw
     WHERE status IN ('Open', 'Upcoming')
     ORDER BY (status = 'Open') DESC, draw_date ASC
     LIMIT 1`,
  );
  if (!drawRes.rows[0]) throw new Error('NO_CAMPAIGN');
  const draw = drawRes.rows[0] as { id: number; name: string; status: string };

  const inserted = await pool.query(
    `INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, cap_at_entry, min_transaction_at_entry)
     SELECT $1, b.id, COALESCE(s.fee_at_entry, 0),
            COALESCE(s.entries_per_location, (SELECT global_entry_cap FROM platform_settings WHERE id = 1)),
            b.min_transaction_amount
     FROM business b
     LEFT JOIN subscription s ON s.business_id = b.id
     WHERE b.id = $2
       AND COALESCE(s.participation_paused, FALSE) = FALSE
       AND COALESCE(s.skip_next_campaign, FALSE) = FALSE
     ON CONFLICT (draw_id, business_id) DO NOTHING`,
    [draw.id, businessId],
  );

  // Zero rows has TWO distinct causes that must not both read as success: the row already
  // exists (double-click / already joined - genuinely fine), or the paused/skip flags
  // filtered the SELECT away (the business asked to sit out - "joined" would be a lie;
  // their entry silently not existing would surface as a support mystery later).
  if (inserted.rowCount === 0) {
    const existing = await pool.query(
      `SELECT 1 FROM draw_entry WHERE draw_id = $1 AND business_id = $2`,
      [draw.id, businessId],
    );
    if (existing.rows.length === 0) throw new Error('PARTICIPATION_PAUSED');
  }

  // Joining an OPEN campaign flips the business's locations to participating on the public
  // map/search - drop the public caches so it shows up without waiting for expiry.
  invalidatePublicBusinessData();
  return { drawId: draw.id, drawName: draw.name, drawStatus: draw.status };
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
