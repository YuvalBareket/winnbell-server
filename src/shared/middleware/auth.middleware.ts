import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getPool } from '../db/db.js';

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

export const requireRole = (...roles: string[]) =>
  (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ message: 'Forbidden: insufficient permissions' });
      return;
    }
    next();
  };

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

    // Verify the account is still active in the database (catches banned/deactivated users)
    const pool = getPool();
    const userCheck = await pool.query(
      `SELECT is_active, role FROM "user" WHERE id = $1`,
      [decoded.id],
    );
    if (!userCheck.rows[0]?.is_active) {
      res.status(401).json({ message: 'Account is deactivated.' });
      return;
    }

    req.user = { ...decoded, role: userCheck.rows[0].role };
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid or expired token.' });
  }
};
