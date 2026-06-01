import bcrypt from 'bcryptjs';
import { getPool } from '../../shared/db/db.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
const getAllowedStates = async (): Promise<string[]> => {
  const pool = getPool();
  const result = await pool.query(`SELECT allowed_states FROM platform_settings WHERE id = 1`);
  return result.rows[0]?.allowed_states ?? [];
};

export const getCountryFromIp = async (ip: string): Promise<string | null> => {
  if (!ip) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`https://ipinfo.io/${ip}/country`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      return null;
    }
    const text = (await res.text()).trim();
    return text.length === 2 ? text : null;
  } catch (err) {
    return null;
  }
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
       RETURNING id, role, full_name, email`,
      [fullName, email, passwordHash, registrationIp ?? null],
    );
    const newUser = result.rows[0];

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
             WHERE id = $2 AND invite_token_hash = $3 AND invite_used_at IS NULL
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
        throw new Error(err instanceof Error ? err.message : 'Invalid or expired invitation link');
      }
    }

    await client.query('COMMIT');

    const token = jwt.sign(
      { id: newUser.id, role: newUser.role, location_id: locationId },
      process.env.JWT_SECRET as string,
      { expiresIn: '7d' },
    );

    return {
      message: 'User registered successfully',
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        fullName: newUser.full_name,
        role: newUser.role,
        location_id: locationId,
        requiresBusinessSetup: newUser.role === 'Business' && !inviteToken,
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

  const result = await pool.query(
    `SELECT id, email, password_hash, full_name, role FROM "user" WHERE email = $1 AND is_active = true`,
    [email],
  );
  const user = result.rows[0];
  if (!user) throw new Error('Invalid credentials');

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) throw new Error('Invalid credentials');

  let locationId: number | null = null;

  if (inviteToken) {
    const client = await pool.connect();
    try {
      const decoded = jwt.verify(
        inviteToken,
        process.env.JWT_SECRET as string,
      ) as ManagerInvitePayload;
      if (decoded.type === 'MANAGER_INVITE' && decoded.locationId) {
        await client.query('BEGIN');

        // Single-use enforcement
        const tokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
        const updateResult = await client.query(
          `UPDATE business_location
           SET manager_user_id = $1, invite_used_at = NOW(), invite_token_hash = NULL
           WHERE id = $2 AND invite_token_hash = $3 AND invite_used_at IS NULL
           RETURNING id`,
          [user.id, decoded.locationId, tokenHash],
        );
        if (updateResult.rowCount === 0) throw new Error('Invalid or already-used invitation link');

        await client.query(
          `UPDATE "user" SET role = 'Business' WHERE id = $1`,
          [user.id],
        );
        await client.query('COMMIT');
        user.role = 'Business';
        locationId = decoded.locationId;
      }
    } catch (err: unknown) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      if (err instanceof Error) throw err;
    } finally {
      client.release();
    }
  } else {
    const locResult = await pool.query(
      `SELECT id FROM business_location WHERE manager_user_id = $1`,
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
    { id: user.id, role: user.role, location_id: locationId },
    process.env.JWT_SECRET as string,
    { expiresIn: '7d' },
  );

  return {
    message: 'Login successful',
    token,
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
    },
  };
};

export const changePasswordService = async (userId: number, currentPassword: string, newPassword: string): Promise<void> => {
  const pool = getPool();
  // Only works for users with a local password (SSO-only users have NULL password_hash)
  const result = await pool.query(`SELECT password_hash FROM "user" WHERE id = $1`, [userId]);
  const user = result.rows[0];
  if (!user) throw new Error('USER_NOT_FOUND');
  if (!user.password_hash) throw new Error('SSO_ACCOUNT');

  const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
  if (!isMatch) throw new Error('WRONG_PASSWORD');

  if (newPassword.length < 8) throw new Error('PASSWORD_TOO_SHORT');

  const salt = await bcrypt.genSalt(10);
  const newHash = await bcrypt.hash(newPassword, salt);
  await pool.query(`UPDATE "user" SET password_hash = $1 WHERE id = $2`, [newHash, userId]);
};

export const syncExternalUser = async (
  externalId: string,
  email: string,
  fullName: string,
  metadata?: { role?: string; inviteToken?: string | null; ip?: string },
) => {
  const pool = getPool();
  const client = await pool.connect();
  let locationId: number | null = null;
  // Admin role can never be assigned through sync — only via direct DB action.
  // 'Business' is allowed for new users (INSERT path) so the external auth sync flow works.
  // For existing users the ON CONFLICT clause does NOT update role, so sync can never downgrade
  // or escalate an already-created account regardless of what metadata says.
  const rawRole = metadata?.role || 'User';
  const role = rawRole === 'Business' ? 'Business' : 'User';
  const inviteToken = metadata?.inviteToken;

  const detectedState = metadata?.ip ? await getCountryFromIp(metadata.ip) : null;

  // Region check: only validate when state detection succeeds
  if (detectedState) {
    const allowedStates = await getAllowedStates();
    if (allowedStates.length > 0 && !allowedStates.includes(detectedState)) {
      throw new Error('REGION_RESTRICTED');
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

    const upsertResult = await client.query(
      `INSERT INTO "user" (external_auth_id, email, full_name, role, is_active, is_email_verified, declared_state)
       VALUES ($1, $2, $3, $4, true, true, $5)
       ON CONFLICT (email) DO UPDATE
         SET external_auth_id = EXCLUDED.external_auth_id,
             is_email_verified = true,
             declared_state = COALESCE(EXCLUDED.declared_state, "user".declared_state),
             updated_at = NOW()
       RETURNING id, role, full_name AS "fullName", email`,
      [externalId, email, fullName, role, detectedState],
    );
    const dbUser = upsertResult.rows[0];

    if (inviteToken) {
      try {
        const decoded = jwt.verify(
          inviteToken,
          process.env.JWT_SECRET as string,
        ) as ManagerInvitePayload;

        if (decoded.type === 'MANAGER_INVITE' && decoded.locationId) {
          locationId = decoded.locationId;

          // Single-use enforcement
          const tokenHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
          const updateResult = await client.query(
            `UPDATE business_location
             SET manager_user_id = $1, invite_used_at = NOW(), invite_token_hash = NULL
             WHERE id = $2 AND invite_token_hash = $3 AND invite_used_at IS NULL
             RETURNING id`,
            [dbUser.id, locationId, tokenHash],
          );
          if (updateResult.rowCount === 0) throw new Error('Invalid or already-used invitation link');

          await client.query(
            `UPDATE "user" SET role = 'Business' WHERE id = $1`,
            [dbUser.id],
          );
          dbUser.role = 'Business';
        }
      } catch (tokenErr: unknown) {
        console.error('Invite token processing failed during sync:', tokenErr instanceof Error ? tokenErr.message : tokenErr);
        throw tokenErr; // propagate so the caller gets a 4xx instead of silently succeeding
      }
    } else {
      const locResult = await client.query(
        `SELECT id FROM business_location WHERE manager_user_id = $1`,
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

    await client.query('COMMIT');

    const internalToken = jwt.sign(
      { id: dbUser.id, role: dbUser.role, location_id: locationId },
      process.env.JWT_SECRET as string,
      { expiresIn: '7d' },
    );

    return {
      message: 'Sync successful',
      token: internalToken,
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
