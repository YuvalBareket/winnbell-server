import { Request, Response } from 'express';
import * as authService from './auth.service.js';
import { RegisterRequest, AuthResponse } from './auth.types.js'; // <--- Import here

// Request<{}, {}, RegisterRequest> tells TS that req.body must match RegisterRequest
export const register = async (
  req: Request<{}, {}, RegisterRequest>,
  res: Response<AuthResponse>,
): Promise<void> => {
  try {
    const { fullName, email, password, role, inviteToken } = req.body;

    // TypeScript now knows 'fullName' exists and is a string!
    if (!fullName || !email || !password) {
      res.status(400).json({ message: 'All fields are required' });
      return;
    }

    const result = await authService.registerUser(
      fullName,
      email,
      password,
      role,
      inviteToken,
    );
    res.status(201).json(result);
  } catch (error: any) {
    console.error('Registration Error:', error);

    if (error.message === 'User already exists') {
      res.status(409).json({ message: 'User already exists' });
      return;
    }

    res.status(500).json({ message: 'Server error' });
  }
};
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password,inviteToken } = req.body;

    if (!email || !password) {
      res.status(400).json({ message: 'Email and password are required' });
      return;
    }

    const result = await authService.loginUser(email, password,inviteToken);
    res.status(200).json(result);
  } catch (error: any) {
    console.error('Login Error:', error);
    res.status(401).json({ message: 'Invalid email or password' });
  }
};
