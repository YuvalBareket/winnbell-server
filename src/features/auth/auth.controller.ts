import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
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
  const pool = getPool();
  const result = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [email.toLowerCase().trim()]);
  res.json({ exists: result.rows.length > 0 });
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
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';

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
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';
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

export const changePassword = async (req: Request, res: Response): Promise<void> => {
  const userId = (req as any).user?.id;
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
