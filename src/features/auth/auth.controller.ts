import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as authService from './auth.service.js';
import { RegisterRequest, AuthResponse } from './auth.types.js';
import { getPool } from '../../shared/db/db.js';

export const register = async (
  req: Request<{}, {}, RegisterRequest>,
  res: Response<AuthResponse>,
): Promise<void> => {
  try {
    const { fullName, email, password, role, inviteToken } = req.body;

    if (!fullName || !email || !password) {
      res.status(400).json({ message: 'All fields are required' });
      return;
    }

    const result = await authService.registerUser(fullName, email, password, role, inviteToken, req.ip);
    res.status(201).json(result);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'User already exists') {
      res.status(409).json({ message: 'User already exists' });
      return;
    }
    if (error instanceof Error && error.message.includes('disposable')) {
      res.status(400).json({ message: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes('invitation')) {
      res.status(400).json({ message: error.message });
      return;
    }
    res.status(500).json({ message: 'Server error' });
  }
};

export const checkEmail = async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  if (!email) { res.status(400).json({ message: 'Email required' }); return; }
  try {
    const pool = getPool();
    const result = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [email.toLowerCase().trim()]);
    res.json({ exists: result.rows.length > 0 });
  } catch {
    res.status(500).json({ message: 'Server error' });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password, inviteToken } = req.body;

    if (!email || !password) {
      res.status(400).json({ message: 'Email and password are required' });
      return;
    }

    const result = await authService.loginUser(email, password, inviteToken);
    res.status(200).json(result);
  } catch {
    res.status(401).json({ message: 'Invalid email or password' });
  }
};

// Called by the frontend after any Supabase sign-in to get an internal JWT
export const syncUser = async (req: Request, res: Response): Promise<void> => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ message: 'No token provided' });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    const JWKS = createRemoteJWKSet(
      new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
    );
    const { payload: verified } = await jwtVerify(token, JWKS);
    payload = verified as Record<string, unknown>;
  } catch (err: unknown) {
    console.error('JWT verify failed:', err instanceof Error ? err.message : err);
    res.status(401).json({ message: 'Invalid or expired token' });
    return;
  }

  try {
    const email = payload['email'] as string;
    const meta = (payload['user_metadata'] ?? {}) as Record<string, unknown>;
    const fullName = ((meta['full_name'] ?? meta['name'] ?? '') as string).trim();
    const { inviteToken, role: bodyRole } = req.body;
    // Role comes from JWT user_metadata (set at signUp time) — atomic, no race condition.
    // For OAuth sign-ins user_metadata.role is absent; fall back to req.body.role (set
    // from pendingRole localStorage by useSupabaseSync before calling syncUser).
    const roleFromToken = (meta['role'] as string | undefined) ?? (bodyRole as string | undefined);
    const ip = req.ip || '';

    const result = await authService.syncExternalUser(payload['sub'] as string, email, fullName, {
      role: roleFromToken,
      inviteToken: inviteToken || (meta['invite_token'] as string) || null,
      ip,
    });

    res.json(result);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'REGION_RESTRICTED') {
      res.status(403).json({ message: 'REGION_RESTRICTED' });
      return;
    }
    if (err instanceof Error && err.message === 'ACCOUNT_DELETED') {
      res.status(403).json({ message: 'ACCOUNT_DELETED' });
      return;
    }
    if (err instanceof Error && (err.message.includes('invitation') || err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
      res.status(400).json({ message: 'Your invitation link has expired or is invalid. Please request a new one.' });
      return;
    }
    console.error('Sync service error:', err instanceof Error ? err.message : err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getRegionConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    const pool = getPool();
    const result = await pool.query(`SELECT allowed_states FROM platform_settings WHERE id = 1`);
    const allowed_states: string[] = result.rows[0]?.allowed_states ?? [];
    res.json({ allowed_states });
  } catch {
    res.json({ allowed_states: [] });
  }
};

export const checkRegion = async (req: Request, res: Response): Promise<void> => {
  try {
    const ip = req.ip || '';
    const country = await authService.getCountryFromIp(ip);
    const pool = getPool();
    const result = await pool.query(`SELECT allowed_states FROM platform_settings WHERE id = 1`);
    const allowedStates: string[] = result.rows[0]?.allowed_states ?? [];
    const blocked = !!country && allowedStates.length > 0 && !allowedStates.includes(country);
    res.json({ blocked, country });
  } catch {
    res.json({ blocked: false, country: null });
  }
};

export const deleteAccount = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  try {
    const pool = getPool();
    // Prevent business owners from self-deleting (must contact support to avoid orphaned data)
    const bizCheck = await pool.query(`SELECT id FROM business WHERE user_id = $1 LIMIT 1`, [userId]);
    if (bizCheck.rows.length > 0) {
      res.status(400).json({ message: 'Business accounts cannot be deleted here. Please contact support.' });
      return;
    }

    // Grab external_auth_id before anonymizing so we can delete from Supabase
    const userRow = await pool.query(`SELECT external_auth_id FROM "user" WHERE id = $1`, [userId]);
    const externalAuthId: string | null = userRow.rows[0]?.external_auth_id ?? null;

    // Revoke all refresh tokens before anonymizing
    await pool.query(`DELETE FROM refresh_token WHERE user_id = $1`, [userId]);

    // Anonymize PII — preserve tickets/entries for draw integrity
    await pool.query(
      `UPDATE "user" SET
         full_name    = 'Deleted User',
         email        = 'deleted_' || id::text || '@winnbell.invalid',
         phone_number = NULL,
         is_active    = FALSE,
         role         = 'User'
       WHERE id = $1`,
      [userId],
    );

    // Remove from Supabase so the email is free for re-registration
    if (externalAuthId && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const resp = await fetch(
          `${process.env.SUPABASE_URL}/auth/v1/admin/users/${externalAuthId}`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
              apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            },
          },
        );
        if (!resp.ok) {
          console.error('[deleteAccount] Supabase returned', resp.status, await resp.text().catch(() => ''));
        }
      } catch (supabaseErr) {
        // Non-fatal: DB is already anonymized; log and continue
        console.error('[deleteAccount] Supabase user deletion failed:', supabaseErr);
      }
    }

    res.json({ success: true });
  } catch (err: unknown) {
    console.error('[deleteAccount]', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const refreshTokenController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken || typeof refreshToken !== 'string') {
      res.status(400).json({ message: 'Refresh token required' });
      return;
    }

    const pool = getPool();
    const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');

    // Atomic consume: DELETE...RETURNING prevents race conditions on concurrent refresh
    const result = await pool.query(
      `DELETE FROM refresh_token WHERE token_hash = $1 AND expires_at > NOW() RETURNING id, user_id`,
      [hash],
    );
    const row = result.rows[0];
    if (!row) {
      res.status(401).json({ message: 'Invalid or expired refresh token' });
      return;
    }

    const userResult = await pool.query(
      `SELECT id, role, is_active FROM "user" WHERE id = $1`,
      [row.user_id],
    );
    const user = userResult.rows[0];
    if (!user || !user.is_active) {
      await pool.query('DELETE FROM refresh_token WHERE user_id = $1', [row.user_id]);
      res.status(401).json({ message: 'Account deactivated' });
      return;
    }

    const locResult = await pool.query(
      `SELECT bl.id AS location_id FROM business_location bl WHERE bl.manager_user_id = $1 AND bl.is_active = TRUE LIMIT 1`,
      [user.id],
    );
    const locationId = locResult.rows[0]?.location_id ?? null;

    const newToken = jwt.sign(
      { id: user.id, role: user.role, location_id: locationId },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' },
    );

    const newRefreshToken = crypto.randomBytes(40).toString('hex');
    const newRefreshHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    const newRefreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO refresh_token (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.id, newRefreshHash, newRefreshExpiry],
    );

    res.json({ token: newToken, refreshToken: newRefreshToken });
  } catch (err: unknown) {
    console.error('[refreshToken]', err instanceof Error ? err.message : err);
    res.status(500).json({ message: 'Token refresh failed' });
  }
};

export const changePassword = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) { res.status(400).json({ message: 'Both currentPassword and newPassword are required' }); return; }

  try {
    await authService.changePasswordService(userId, currentPassword, newPassword);
    res.json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : '';
    if (msg === 'WRONG_PASSWORD') { res.status(400).json({ message: 'Current password is incorrect' }); return; }
    if (msg === 'SSO_ACCOUNT') { res.status(400).json({ message: 'Password cannot be changed for social login accounts' }); return; }
    if (msg === 'PASSWORD_TOO_SHORT') { res.status(400).json({ message: 'New password must be at least 8 characters' }); return; }
    if (msg === 'USER_NOT_FOUND') { res.status(404).json({ message: 'User not found' }); return; }
    res.status(500).json({ message: 'Server error' });
  }
};
