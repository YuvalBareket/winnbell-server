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

// Global augmentation so `req.user` is typed on the base Express Request everywhere
// (error handler, rate-limiter keyGenerators, etc.) without resorting to `as any`.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
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

// Cached current role + whether the user still actively manages a location.
// Used to detect stale elevated sessions (e.g. a manager removed from a location
// whose 1h JWT still claims Business + location_id).
type RoleState = { role: string; managedLocationIds: number[] };

async function getRoleState(userId: number): Promise<RoleState | null> {
  const cacheKey = `user:role:${userId}`;
  const cached = userCache.get<RoleState>(cacheKey);
  if (cached) return cached;

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT u.role,
              COALESCE(
                (SELECT array_agg(bl.id) FROM business_location bl
                 WHERE bl.manager_user_id = $1 AND bl.is_active = TRUE),
                '{}'
              ) AS managed_location_ids
       FROM "user" u WHERE u.id = $1`,
      [userId],
    );
    if (result.rows.length === 0) return null;
    const state: RoleState = {
      role: result.rows[0].role,
      managedLocationIds: (result.rows[0].managed_location_ids ?? []).map(Number),
    };
    userCache.set(cacheKey, state);
    return state;
  } catch {
    return null; // fail open on transient DB errors; mutation guards still apply
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

    // Detect stale elevated sessions. Only business/manager tokens pay the (cached)
    // DB lookup; regular-user tokens pass straight through. If the token claims a
    // privileged role or a managed location that the DB no longer backs (e.g. the
    // manager was removed), reject so the client refreshes -> refresh token was
    // revoked -> hard logout and re-login as a regular user.
    if (decoded.role !== 'Admin' && (decoded.role === 'Business' || decoded.location_id != null)) {
      const fresh = await getRoleState(decoded.id);
      if (fresh) {
        const roleMatches = fresh.role === decoded.role;
        // Must still manage the SPECIFIC location the token was scoped to — not just "any" location.
        // Prevents a manager reassigned to another business from reading their old business's data
        // with a stale token (they'd still manage some location, which the old "any" check allowed).
        const locationStillValid = decoded.location_id == null || fresh.managedLocationIds.includes(decoded.location_id);
        if (!roleMatches || !locationStillValid) {
          console.info(`[auth] stale elevated session rejected: userId=${decoded.id} tokenRole=${decoded.role} dbRole=${fresh.role} tokenLoc=${decoded.location_id ?? 'none'} managedLocs=[${fresh.managedLocationIds.join(',')}]`);
          res.status(401).json({ message: 'Session no longer valid. Please sign in again.' });
          return;
        }
      }
    }

    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid or expired token.' });
  }
};

// Populates req.user when a valid Bearer token is present, but NEVER rejects. For public routes
// that must stay open to anonymous callers yet want to know the user when they are logged in
// (e.g. attributing a profile view to a real User and excluding Business/Manager accounts).
export const optionalAuth = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): void => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    try {
      const jwtSecret = process.env.JWT_SECRET;
      if (jwtSecret) req.user = jwt.verify(token, jwtSecret) as UserPayload;
    } catch {
      // invalid/expired token — treat as anonymous, do not block the request
    }
  }
  next();
};
