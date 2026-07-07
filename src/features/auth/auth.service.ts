import bcrypt from 'bcryptjs';
import { getPool } from '../../shared/db/db.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { isIP } from 'net';
import { getPlatformSettings, invalidateUserAuth } from '../../shared/cache/cache.js';
import { resolveReferrerIdForSignup } from '../referral/referral.service.js';
const getAllowedStates = async (): Promise<string[]> => {
  const settings = await getPlatformSettings();
  return settings.allowed_states ?? [];
};

// Cap on simultaneously-live refresh tokens per user. Each login/auth inserts a 30-day
// token; without a cap a user accumulates unlimited live "remember me" sessions (row
// bloat + a larger stolen-token surface). Keep only the N most recent, prune the rest.
const MAX_REFRESH_TOKENS_PER_USER = 5;

// Accepts a Pool or a transaction PoolClient (both expose .query).
type DbExecutor = { query: (text: string, params: unknown[]) => Promise<unknown> };

/**
 * Insert a refresh token, then prune the user's tokens down to the most recent N.
 * Bounds live sessions per user. The just-inserted token is always among the newest,
 * so it survives; the oldest (least-recently-active) sessions beyond N are evicted.
 */
export const insertRefreshTokenCapped = async (
  exec: DbExecutor,
  userId: number,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> => {
  await exec.query(
    `INSERT INTO refresh_token (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  );
  // Keep the N newest LIVE tokens (unconsumed, or consumed within the rotation grace
  // window - those are still redeemable by a racing tab). Everything else goes: consumed
  // rows past grace and live-token overflow beyond the cap.
  await exec.query(
    `DELETE FROM refresh_token
     WHERE user_id = $1
       AND id NOT IN (
         SELECT id FROM refresh_token
         WHERE user_id = $1
           AND (consumed_at IS NULL OR consumed_at > NOW() - interval '60 seconds')
         ORDER BY id DESC LIMIT $2
       )`,
    [userId, MAX_REFRESH_TOKENS_PER_USER],
  );
};

// US state full name (as returned by ipinfo's `region` field) → USPS 2-letter code.
// allowed_states in platform_settings stores the 2-letter codes (admin picks from US_STATES).
const US_STATE_NAME_TO_CODE: Record<string, string> = {
  'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA',
  'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA',
  'Hawaii': 'HI', 'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
  'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
  'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS', 'Missouri': 'MO',
  'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH',
  'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT',
  'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY',
  'District of Columbia': 'DC',
};

export interface IpRegion {
  /** ISO 3166-1 alpha-2 country code, e.g. 'US', 'IL'. Null when detection failed. */
  country: string | null;
  /** USPS state code, e.g. 'FL'. Only set for US IPs whose region was recognised. */
  stateCode: string | null;
  /** City name from the IP geo lookup (ipinfo). Null when detection failed. */
  city: string | null;
}

/**
 * Resolve country + US state from an IP via ipinfo.io's /json endpoint.
 * (The old /country endpoint only returned the country, which could never match
 * the state codes stored in platform_settings.allowed_states.)
 * Returns nulls on any failure — callers fail open.
 */
export const getRegionFromIp = async (ip: string): Promise<IpRegion> => {
  if (!ip) return { country: null, stateCode: null, city: null };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const tokenParam = process.env.IPINFO_TOKEN ? `?token=${process.env.IPINFO_TOKEN}` : '';
    // encode the client-controlled IP (from X-Forwarded-For/cf-connecting-ip) so a crafted
    // value can't inject path/query into the external URL or maneuver around the token param.
    const res = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json${tokenParam}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { country: null, stateCode: null, city: null };
    const data = await res.json() as { country?: string; region?: string; city?: string };
    const country = typeof data.country === 'string' && data.country.length === 2 ? data.country : null;
    const stateCode = country === 'US' && data.region ? (US_STATE_NAME_TO_CODE[data.region] ?? null) : null;
    const city = typeof data.city === 'string' && data.city.trim() ? data.city.trim().slice(0, 120) : null;
    return { country, stateCode, city };
  } catch {
    return { country: null, stateCode: null, city: null };
  }
};

export interface RegionCheckResult {
  blocked: boolean;
  country: string | null;
  state: string | null;
  city: string | null;
}

/**
 * Shared region-restriction decision used by signup sync and /auth/region-check.
 * allowed_states empty/null = no restriction. Detection failures fail open so a
 * geo-API hiccup never locks out legitimate users.
 */
export const evaluateRegionRestriction = async (ip: string): Promise<RegionCheckResult> => {
  const { country, stateCode, city } = await getRegionFromIp(ip);
  const allowedStates = await getAllowedStates();

  if (allowedStates.length === 0) return { blocked: false, country, state: stateCode, city };
  if (!country) return { blocked: false, country, state: stateCode, city }; // fail open
  if (country !== 'US') return { blocked: true, country, state: stateCode, city };
  if (!stateCode) return { blocked: false, country, state: stateCode, city }; // US, state unknown — fail open
  return { blocked: !allowedStates.includes(stateCode), country, state: stateCode, city };
};

// ── Bot / throwaway-email protection ──────────────────────────────────────────

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.org', 'guerrillamail.net',
  'guerrillamail.de', 'guerrillamail.biz', 'guerrillamail.info',
  'tempmail.com', 'temp-mail.org', 'throwam.com', 'yopmail.com',
  '10minutemail.com', '10minutemail.net', 'trashmail.com', 'trashmail.me',
  'maildrop.cc', 'dispostable.com', 'spamgourmet.com', 'getairmail.com',
  'sharklasers.com', 'grr.la', 'spam4.me', 'mailnull.com', 'nada.email',
  'tempr.email', 'discard.email', 'fakeinbox.com', 'mailnesia.com',
  'anonbox.net', 'binkmail.com', 'bob.email', 'trashmail.at', 'trashmail.io',
]);

const isDisposableEmail = (email: string): boolean => {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? DISPOSABLE_EMAIL_DOMAINS.has(domain) : false;
};

interface ManagerInvitePayload {
  type: 'MANAGER_INVITE';
  locationId: number;
  businessId: number;
}

export const registerUser = async (
  fullName: string,
  email: string,
  password: string,
  _roleIgnored: string, // role from request body is NEVER trusted — always defaulted to 'User'
  inviteToken?: string,
  registrationIp?: string,
) => {
  email = email.toLowerCase().trim(); // schema email is case-sensitive UNIQUE — always store normalized
  if (isDisposableEmail(email)) {
    throw new Error('Registration with disposable email addresses is not allowed.');
  }

  const pool = getPool();
  const client = await pool.connect();
  let locationId: number | null = null;

  try {
    await client.query('BEGIN');

    const checkUser = await client.query(
      `SELECT id FROM "user" WHERE email = $1`,
      [email],
    );
    if (checkUser.rows.length > 0) throw new Error('User already exists');

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // All self-registered users start as 'User'. Role can only be elevated to 'Business'
    // via a valid invite token, never by client-supplied input.
    const result = await client.query(
      `INSERT INTO "user" (full_name, email, password_hash, role, registration_ip)
       VALUES ($1, $2, $3, 'User', $4)
       RETURNING id, role, full_name, email, is_phone_verified, token_epoch`,
      [fullName, email, passwordHash, registrationIp ?? null],
    );
    const newUser = result.rows[0];

    // Keep the 1:1 acquisition row invariant (legacy password path has no channel metadata).
    await client.query(
      `INSERT INTO user_acquisition (user_id, source) VALUES ($1, 'direct') ON CONFLICT (user_id) DO NOTHING`,
      [newUser.id],
    );

    if (inviteToken) {
      try {
        const decoded = jwt.verify(
          inviteToken,
          process.env.JWT_SECRET as string,
        ) as ManagerInvitePayload;

        if (decoded.type === 'MANAGER_INVITE' && decoded.locationId) {
          locationId = decoded.locationId;

          // Single-use enforcement: verify token hash matches and hasn't been used yet
          const tokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
          const locResult = await client.query(
            `UPDATE business_location
             SET manager_user_id = $1, invite_used_at = NOW(), invite_token_hash = NULL
             WHERE id = $2 AND invite_token_hash = $3 AND invite_used_at IS NULL AND is_active = TRUE
             RETURNING id`,
            [newUser.id, locationId, tokenHash],
          );
          if (locResult.rowCount === 0) {
            throw new Error('Invalid or already-used invitation link');
          }
          // Valid invite → promote to Business role
          await client.query(
            `UPDATE "user" SET role = 'Business' WHERE id = $1`,
            [newUser.id],
          );
          newUser.role = 'Business';
        }
      } catch (err: unknown) {
        // jwt.verify throws "jwt expired" / "invalid signature" — translate to a
        // message the user can act on (and that the controller maps to a 400)
        if (err instanceof Error && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
          throw new Error('This invitation link has expired or is invalid. Please ask the business owner to send you a new invitation.');
        }
        throw new Error(err instanceof Error ? err.message : 'Invalid or expired invitation link');
      }
    }

    const refreshToken = crypto.randomBytes(40).toString('hex');
    const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await insertRefreshTokenCapped(client, newUser.id, refreshHash, refreshExpiry);

    await client.query('COMMIT');
    invalidateUserAuth(newUser.id);

    const token = jwt.sign(
      { id: newUser.id, role: newUser.role, location_id: locationId, se: newUser.token_epoch ?? 0 },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' },
    );

    return {
      message: 'User registered successfully',
      token,
      refreshToken,
      user: {
        id: newUser.id,
        email: newUser.email,
        fullName: newUser.full_name,
        role: newUser.role,
        location_id: locationId,
        requiresBusinessSetup: newUser.role === 'Business' && !inviteToken,
        isPhoneVerified: newUser.is_phone_verified,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const loginUser = async (
  email: string,
  password: string,
  inviteToken?: string,
) => {
  const pool = getPool();
  email = email.toLowerCase().trim();

  const result = await pool.query(
    `SELECT id, email, password_hash, full_name, role, is_phone_verified, token_epoch FROM "user" WHERE email = $1 AND is_active = true`,
    [email],
  );
  const user = result.rows[0];
  if (!user) throw new Error('Invalid credentials');

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) throw new Error('Invalid credentials');

  let locationId: number | null = null;
  let inviteApplied = false;

  if (inviteToken) {
    const client = await pool.connect();
    let transactionStarted = false;
    try {
      const decoded = jwt.verify(
        inviteToken,
        process.env.JWT_SECRET as string,
      ) as ManagerInvitePayload;
      if (decoded.type === 'MANAGER_INVITE' && decoded.locationId) {
        await client.query('BEGIN');
        transactionStarted = true;

        // Single-use enforcement (and the location must still be active)
        const tokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
        const updateResult = await client.query(
          `UPDATE business_location
           SET manager_user_id = $1, invite_used_at = NOW(), invite_token_hash = NULL
           WHERE id = $2 AND invite_token_hash = $3 AND invite_used_at IS NULL AND is_active = TRUE
           RETURNING id`,
          [user.id, decoded.locationId, tokenHash],
        );
        if (updateResult.rowCount && updateResult.rowCount > 0) {
          await client.query(
            `UPDATE "user" SET role = 'Business' WHERE id = $1`,
            [user.id],
          );
          await client.query('COMMIT');
          invalidateUserAuth(user.id);
          user.role = 'Business';
          locationId = decoded.locationId;
          inviteApplied = true;
        } else {
          await client.query('ROLLBACK');
        }
      }
    } catch (err: unknown) {
      if (transactionStarted) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      }
      // A stale/used/expired invite token must not block sign-in; ignore it and
      // log the user in with their current role (mirrors syncExternalUser).
      console.error('Invite token ignored during login:', err instanceof Error ? err.message : err);
    } finally {
      client.release();
    }
  }

  if (!inviteApplied) {
    const locResult = await pool.query(
      `SELECT id FROM business_location WHERE manager_user_id = $1 AND is_active = TRUE`,
      [user.id],
    );
    if (locResult.rows.length > 0) {
      locationId = locResult.rows[0].id;
    }
  }

  let hasBusiness = false;
  let businessIsActive = false;
  let businessLogoUrl: string | null = null;
  let businessId: number | null = null;
  if (user.role === 'Business' && !locationId) {
    const bizResult = await pool.query(
      `SELECT b.id, b.logo_url, (s.status IN ('Active', 'Trialing')) AS is_subscribed
       FROM business b
       LEFT JOIN subscription s ON s.business_id = b.id
       WHERE b.user_id = $1`,
      [user.id],
    );
    hasBusiness = bizResult.rows.length > 0;
    businessIsActive = !!bizResult.rows[0]?.is_subscribed;
    businessLogoUrl = bizResult.rows[0]?.logo_url ?? null;
    businessId = bizResult.rows[0]?.id ?? null;
  }

  const token = jwt.sign(
    { id: user.id, role: user.role, location_id: locationId, se: user.token_epoch ?? 0 },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' },
  );

  const refreshToken = crypto.randomBytes(40).toString('hex');
  const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await insertRefreshTokenCapped(pool, user.id, refreshHash, refreshExpiry);

  return {
    message: 'Login successful',
    token,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      location_id: locationId,
      business_id: businessId,
      requiresBusinessSetup: user.role === 'Business' && !locationId && !hasBusiness,
      businessIsActive,
      businessLogoUrl,
      isPhoneVerified: user.is_phone_verified,
    },
  };
};


export const syncExternalUser = async (
  externalId: string,
  email: string,
  fullName: string,
  metadata?: { role?: string; inviteToken?: string | null; ip?: string; referralCode?: string | null; acquisitionSource?: string | null; acquiredViaLocationId?: number | null; promoCode?: string | null },
) => {
  const pool = getPool();
  email = email.toLowerCase().trim();
  const client = await pool.connect();
  let locationId: number | null = null;
  // Admin role can never be assigned through sync — only via direct DB action.
  // 'Business' is allowed for new users (INSERT path) so the external auth sync flow works.
  // For existing users the ON CONFLICT clause does NOT update role, so sync can never downgrade
  // or escalate an already-created account regardless of what metadata says.
  const rawRole = metadata?.role || 'User';
  const role = rawRole === 'Business' ? 'Business' : 'User';
  const inviteToken = metadata?.inviteToken;

  // Region check: country must be US and state must be in allowed_states (when configured).
  // Detection failures fail open inside evaluateRegionRestriction.
  // Existing Admin accounts are exempt — admins must be able to sign in from anywhere
  // (e.g. operating the platform from outside the allowed states).
  let detectedState: string | null = null;
  let detectedCity: string | null = null;
  if (metadata?.ip) {
    const adminCheck = await pool.query(
      `SELECT role FROM "user" WHERE external_auth_id = $1 OR email = $2 LIMIT 1`,
      [externalId, email],
    );
    const isExistingAdmin = adminCheck.rows[0]?.role === 'Admin';
    if (!isExistingAdmin) {
      const region = await evaluateRegionRestriction(metadata.ip);
      if (region.blocked) throw new Error('REGION_RESTRICTED');
      detectedState = region.state ?? region.country;
      detectedCity = region.city;
    }
  }

  try {
    await client.query('BEGIN');

    // Detect deleted accounts before the upsert so we don't crash on the external_auth_id unique constraint.
    // Check both by external_auth_id AND by email — a re-registered user gets a new Supabase ID
    // but the same email, so the email check catches that bypass.
    const deletedCheck = await client.query(
      `SELECT id FROM "user" WHERE (external_auth_id = $1 OR email = $2) AND is_active = FALSE LIMIT 1`,
      [externalId, email],
    );
    if (deletedCheck.rows.length > 0) {
      throw new Error('ACCOUNT_DELETED');
    }

    // Acquisition attribution (its own 1:1 table, written once at signup). Resolve the ?ref= code
    // to a referrer — resolveReferrerIdForSignup rejects self-referral and unknown codes.
    const referrerId = await resolveReferrerIdForSignup(metadata?.referralCode, email);

    // Channel: validate the client-derived source against the enum, default 'direct'.
    const ALLOWED_SOURCES = ['referral', 'promo_code', 'location_flyer', 'direct'];
    const acquisitionSource = ALLOWED_SOURCES.includes(metadata?.acquisitionSource ?? '')
      ? (metadata!.acquisitionSource as string)
      : 'direct';

    // registration_ip is an INET column — only pass a valid IPv4/IPv6 address, else NULL, so a
    // bad/empty IP can never break signup.
    const safeIp = metadata?.ip && isIP(metadata.ip) ? metadata.ip : null;

    // Acquiring location (location_flyer signups): only attribute when the location exists, so a
    // bad/stale id can never violate the FK. Validated against business_location, else NULL.
    let acquiredViaLocationId: number | null = null;
    const rawLoc = metadata?.acquiredViaLocationId;
    if (acquisitionSource === 'location_flyer' && typeof rawLoc === 'number' && Number.isInteger(rawLoc) && rawLoc > 0) {
      const locCheck = await client.query(`SELECT 1 FROM business_location WHERE id = $1`, [rawLoc]);
      if (locCheck.rows.length > 0) acquiredViaLocationId = rawLoc;
    }
    const promoCode = acquisitionSource === 'promo_code' && typeof metadata?.promoCode === 'string'
      ? (metadata.promoCode.trim().slice(0, 100) || null)
      : null;

    const upsertResult = await client.query(
      `INSERT INTO "user" (external_auth_id, email, full_name, role, is_active, is_email_verified, declared_state, registration_ip, city)
       VALUES ($1, $2, $3, $4, true, true, $5, $6, $7)
       ON CONFLICT (email) DO UPDATE
         SET external_auth_id = EXCLUDED.external_auth_id,
             is_email_verified = true,
             declared_state = COALESCE(EXCLUDED.declared_state, "user".declared_state),
             registration_ip = COALESCE("user".registration_ip, EXCLUDED.registration_ip),
             city = COALESCE("user".city, EXCLUDED.city),
             updated_at = NOW()
       RETURNING id, role, full_name AS "fullName", email, token_epoch`,
      [externalId, email, fullName, role, detectedState, safeIp, detectedCity],
    );
    const dbUser = upsertResult.rows[0];

    // Write the acquisition row once (fresh signup). ON CONFLICT DO NOTHING so an existing user
    // re-syncing never overwrites their original acquisition.
    await client.query(
      `INSERT INTO user_acquisition (user_id, source, location_id, promo_code, referred_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO NOTHING`,
      [dbUser.id, acquisitionSource, acquiredViaLocationId, promoCode, referrerId],
    );

    let inviteApplied = false;
    if (inviteToken) {
      try {
        const decoded = jwt.verify(
          inviteToken,
          process.env.JWT_SECRET as string,
        ) as ManagerInvitePayload;

        if (decoded.type === 'MANAGER_INVITE' && decoded.locationId) {
          // Single-use enforcement (and the location must still be active)
          const tokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
          const updateResult = await client.query(
            `UPDATE business_location
             SET manager_user_id = $1, invite_used_at = NOW(), invite_token_hash = NULL
             WHERE id = $2 AND invite_token_hash = $3 AND invite_used_at IS NULL AND is_active = TRUE
             RETURNING id`,
            [dbUser.id, decoded.locationId, tokenHash],
          );
          if (updateResult.rowCount && updateResult.rowCount > 0) {
            locationId = decoded.locationId;
            await client.query(
              `UPDATE "user" SET role = 'Business' WHERE id = $1`,
              [dbUser.id],
            );
            dbUser.role = 'Business';
            inviteApplied = true;
          }
        }
      } catch (tokenErr: unknown) {
        // A stale/used/expired invite token must NOT block sign-in. A former
        // manager (or anyone with a leftover token) just logs in with their
        // current role; we ignore the bad invite instead of throwing.
        console.error('Invite token ignored during sync:', tokenErr instanceof Error ? tokenErr.message : tokenErr);
      }
    }

    if (!inviteApplied) {
      // Resolve the user's location only from a location they still actively
      // manage, so a removed/soft-deleted location never grants manager access.
      const locResult = await client.query(
        `SELECT id FROM business_location WHERE manager_user_id = $1 AND is_active = TRUE`,
        [dbUser.id],
      );
      if (locResult.rows.length > 0) {
        locationId = locResult.rows[0].id;
      }
    }

    let hasBusiness = false;
    let businessIsActive = false;
    let businessLogoUrl: string | null = null;
    let businessId: number | null = null;
    if (dbUser.role === 'Business' && !locationId) {
      const bizResult = await client.query(
        `SELECT b.id, b.logo_url, (s.status IN ('Active', 'Trialing')) AS is_subscribed
         FROM business b
         LEFT JOIN subscription s ON s.business_id = b.id
         WHERE b.user_id = $1`,
        [dbUser.id],
      );
      hasBusiness = bizResult.rows.length > 0;
      businessIsActive = !!bizResult.rows[0]?.is_subscribed;
      businessLogoUrl = bizResult.rows[0]?.logo_url ?? null;
      businessId = bizResult.rows[0]?.id ?? null;
    }

    const internalToken = jwt.sign(
      { id: dbUser.id, role: dbUser.role, location_id: locationId, se: dbUser.token_epoch ?? 0 },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' },
    );

    const refreshToken = crypto.randomBytes(40).toString('hex');
    const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const refreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await insertRefreshTokenCapped(client, dbUser.id, refreshHash, refreshExpiry);

    await client.query('COMMIT');
    invalidateUserAuth(dbUser.id);

    return {
      message: 'Sync successful',
      token: internalToken,
      refreshToken,
      user: {
        ...dbUser,
        location_id: locationId,
        business_id: businessId,
        requiresBusinessSetup: dbUser.role === 'Business' && !locationId && !hasBusiness,
        businessIsActive,
        businessLogoUrl,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const cleanupExpiredRefreshTokens = async (): Promise<void> => {
  const pool = getPool();
  await pool.query(
    `DELETE FROM refresh_token
     WHERE expires_at < NOW()
        OR consumed_at < NOW() - interval '60 seconds'`,
  );
};
