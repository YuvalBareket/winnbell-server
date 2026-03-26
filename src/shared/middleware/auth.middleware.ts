import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

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

export const authenticateToken = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void => {
  // Get the header: "Authorization: Bearer <token>"
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Extract just the token

  if (!token) {
    res.status(401).json({ message: 'Access denied. No token provided.' });
    return;
  }

  try {
    // Verify the token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'secret_key',
    ) as UserPayload;

    // Attach user info to the request object so controllers can use it
    req.user = decoded;

    next(); // Pass control to the next handler (the controller)
  } catch (error) {
    res.status(403).json({ message: 'Invalid or expired token.' });
  }
};
