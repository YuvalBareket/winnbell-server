import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getPool } from '../db/db.js';
import { userCache } from '../cache/cache.js';

// 1. Define the shape of the User object inside the token
export interface UserPayload {
  id: number;
  role: string;
  location_id?: number | null;
}

// 2. Extend the standard Request to include 'user'
export interface AuthRequest extends Request {
  user?: UserPayload;
}

// Guards ticket mutation routes: checks both is_active and is_phone_verified in one query.
// Business/Admin roles skip phone verification but still get the is_active check.
export const requirePhoneVerified = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  type GuardData = { is_active: boolean; is_phone_verified: boolean };
  const guard = await getGuardData(userId, res);
  if (!guard) return; // response already sent

  if (!guard.is_active) {
    res.status(401).json({ message: 'Account is deactivated.' });
    return;
  }

  // Business and Admin roles are exempt from phone verification
  const role = req.user?.role;
  if (role !== 'Business' && role !== 'Admin' && !guard.is_phone_verified) {
    res.status(403).json({ message: 'Phone verification required.' });
    return;
  }

  next();
};

// Guards business ticket generation: checks is_active only (no phone requirement).
export const requireActive = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  const guard = await getGuardData(userId, res);
  if (!guard) return;

  if (!guard.is_active) {
    res.status(401).json({ message: 'Account is deactivated.' });
    return;
  }

  next();
};

type GuardData = { is_active: boolean; is_phone_verified: boolean };

async function getGuardData(userId: number, res: Response): Promise<GuardData | null> {
  const cacheKey = `user:guard:${userId}`;
  const cached = userCache.get<GuardData>(cacheKey);
  if (cached) return cached;

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT is_active, is_phone_verified FROM "user" WHERE id = $1`,
      [userId],
    );
    const guard: GuardData = result.rows[0] ?? { is_active: false, is_phone_verified: false };
    userCache.set(cacheKey, guard);
    return guard;
  } catch {
    res.status(503).json({ message: 'Service temporarily unavailable.' });
    return null;
  }
}

export const requireRole = (...roles: string[]) =>
  (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ message: 'Forbidden: insufficient permissions' });
      return;
    }
    next();
  };

// JWT-only verification. No DB query. Banned users are blocked at mutation
// points (requirePhoneVerified / requireActive), not here.
export const authenticateToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({ message: 'Access denied. No token provided.' });
    return;
  }

  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error('JWT_SECRET is not configured');
    const decoded = jwt.verify(token, jwtSecret) as UserPayload;
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid or expired token.' });
  }
};
