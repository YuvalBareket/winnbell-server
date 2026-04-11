import bcrypt from 'bcryptjs';
import { getPool } from '../../shared/db/db.js';
import jwt from 'jsonwebtoken';

interface ManagerInvitePayload {
  type: 'MANAGER_INVITE';
  locationId: number;
  businessId: number;
}

export const registerUser = async (
  fullName: string,
  email: string,
  password: string,
  role: string,
  inviteToken?: string,
) => {
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

    const result = await client.query(
      `INSERT INTO "user" (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, role, full_name, email`,
      [fullName, email, passwordHash, role ?? 'User'],
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
          await client.query(
            `UPDATE business_location SET manager_user_id = $1 WHERE id = $2`,
            [newUser.id, locationId],
          );
        }
      } catch {
        throw new Error('Invalid or expired invitation link');
      }
    }

    await client.query('COMMIT');

    const token = jwt.sign(
      { id: newUser.id, role: newUser.role, location_id: locationId },
      process.env.JWT_SECRET as string,
      { expiresIn: '30d' },
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
    `SELECT id, email, password_hash, full_name, role FROM "user" WHERE email = $1`,
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
        await client.query(
          `UPDATE business_location SET manager_user_id = $1 WHERE id = $2`,
          [user.id, decoded.locationId],
        );
        await client.query(
          `UPDATE "user" SET role = 'Business' WHERE id = $1`,
          [user.id],
        );
        await client.query('COMMIT');
        user.role = 'Business';
        locationId = decoded.locationId;
      }
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
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
      `SELECT id, is_subscribed, logo_url FROM business WHERE user_id = $1`,
      [user.id],
    );
    hasBusiness = bizResult.rows.length > 0;
    businessIsActive = !!bizResult.rows[0]?.is_active;
    businessLogoUrl = bizResult.rows[0]?.logo_url ?? null;
    businessId = bizResult.rows[0]?.id ?? null;
  }

  const token = jwt.sign(
    { id: user.id, role: user.role, location_id: locationId },
    process.env.JWT_SECRET as string,
    { expiresIn: '30d' },
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

export const syncExternalUser = async (
  externalId: string,
  email: string,
  fullName: string,
  metadata?: { role?: string; inviteToken?: string | null },
) => {
  const pool = getPool();
  const client = await pool.connect();
  let locationId: number | null = null;
  const rawRole = metadata?.role || 'User';
  const validRoles = ['User', 'Business', 'Admin'];
  const role = validRoles.find(r => r.toLowerCase() === rawRole.toLowerCase()) || 'User';
  const inviteToken = metadata?.inviteToken;

  try {
    await client.query('BEGIN');

    const upsertResult = await client.query(
      `INSERT INTO "user" (external_auth_id, email, full_name, role, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (email) DO UPDATE
         SET external_auth_id = EXCLUDED.external_auth_id, updated_at = NOW()
       RETURNING id, role, full_name AS "fullName", email`,
      [externalId, email, fullName, role],
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
          await client.query(
            `UPDATE business_location SET manager_user_id = $1 WHERE id = $2`,
            [dbUser.id, locationId],
          );
          await client.query(
            `UPDATE "user" SET role = 'Business' WHERE id = $1`,
            [dbUser.id],
          );
          dbUser.role = 'Business';
        }
      } catch (tokenErr: unknown) {
        console.error('Invite token processing failed during sync:', tokenErr instanceof Error ? tokenErr.message : tokenErr);
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
        `SELECT id, is_subscribed, logo_url FROM business WHERE user_id = $1`,
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
      { expiresIn: '30d' },
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
