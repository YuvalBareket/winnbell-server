import { Request, Response } from 'express';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { Webhook } from 'svix';
import * as authService from './auth.service.js';
import { RegisterRequest, AuthResponse } from './auth.types.js';

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

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

    const result = await authService.registerUser(fullName, email, password, role, inviteToken);
    res.status(201).json(result);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'User already exists') {
      res.status(409).json({ message: 'User already exists' });
      return;
    }
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

// Called by the frontend after any Clerk sign-in to get an internal JWT
export const syncUser = async (req: Request, res: Response): Promise<void> => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ message: 'No token provided' });
    return;
  }

  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    const clerkUser = await clerk.users.getUser(payload.sub);

    const email = clerkUser.emailAddresses[0]?.emailAddress;
    const fullName = `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim();
    const { inviteToken } = req.body;

    // Role is NEVER accepted from the request body — only from Clerk metadata (Business/User only, never Admin).
    // Admin role can only be assigned directly in the database by an existing admin.
    const role = (clerkUser.unsafeMetadata?.role as string) || 'User';

    const result = await authService.syncExternalUser(payload.sub, email, fullName, {
      role,
      inviteToken: inviteToken || (clerkUser.unsafeMetadata?.inviteToken as string) || null,
    });

    res.json(result);
  } catch (err: unknown) {
    console.error('Sync error:', err instanceof Error ? err.message : err);
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};

export const handleClerkWebhook = async (req: Request, res: Response): Promise<void> => {
  const CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

  if (!CLERK_WEBHOOK_SECRET) {
    res.status(500).json({ error: 'Webhook secret not configured' });
    return;
  }

  const svix_id = req.headers['svix-id'] as string;
  const svix_timestamp = req.headers['svix-timestamp'] as string;
  const svix_signature = req.headers['svix-signature'] as string;

  if (!svix_id || !svix_timestamp || !svix_signature) {
    res.status(400).json({ error: 'Missing svix headers' });
    return;
  }

  const payload = (req.body as Buffer).toString();
  const wh = new Webhook(CLERK_WEBHOOK_SECRET);

  let evt: { type: string; data: Record<string, unknown> };
  try {
    evt = wh.verify(payload, {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature,
    }) as { type: string; data: Record<string, unknown> };
  } catch {
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  if (evt.type === 'user.created') {
    const { id, email_addresses, first_name, last_name, unsafe_metadata } = evt.data as {
      id: string;
      email_addresses: Array<{ email_address: string }>;
      first_name: string | null;
      last_name: string | null;
      unsafe_metadata: Record<string, unknown>;
    };
    const email = email_addresses[0]?.email_address;
    const fullName = `${first_name || ''} ${last_name || ''}`.trim();

    try {
      await authService.syncExternalUser(id, email, fullName, {
        role: typeof unsafe_metadata?.role === 'string' ? unsafe_metadata.role : undefined,
        inviteToken: typeof unsafe_metadata?.inviteToken === 'string' ? unsafe_metadata.inviteToken : null,
      });
    } catch (dbErr: unknown) {
      console.error('Webhook DB sync failed:', dbErr instanceof Error ? dbErr.message : dbErr);
      res.status(500).json({ error: 'Internal database sync failed' });
      return;
    }
  }

  res.status(200).json({ success: true });
};
