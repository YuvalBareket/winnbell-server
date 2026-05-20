/**
 * test-setup.controller.ts
 *
 * Dev/test-only endpoint: POST /auth/test-setup
 *
 * Creates (or resets) a named test persona in the DB and returns a fresh JWT.
 * Blocked in production via NODE_ENV check.
 *
 * Body: { persona: 'maya' | 'lior' | 'scammer' | 'david' | 'noa' }
 */

import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClerkClient } from '@clerk/backend';
import { getPool } from '../../shared/db/db.js';

const PERSONAS: Record<string, {
  fullName: string;
  email: string;
  password: string;
  role: 'User' | 'Business';
  businessName?: string;
  businessSector?: string;
  businessLocation?: string;
}> = {
  maya:    { fullName: 'Maya Tester',    email: 'e2e.maya@e2e.winnbell.com',    password: 'Wbll-E2E#9xTq2026!', role: 'User' },
  lior:    { fullName: 'Lior Tester',    email: 'e2e.lior@e2e.winnbell.com',    password: 'Wbll-E2E#9xTq2026!', role: 'User' },
  scammer: { fullName: 'Scammer Tester', email: 'e2e.scammer@e2e.winnbell.com', password: 'Wbll-E2E#9xTq2026!', role: 'User' },
  david:   {
    fullName: 'David Tester',
    email: 'e2e.david@e2e.winnbell.com',
    password: 'Wbll-E2E#9xTq2026!',
    role: 'Business',
    businessName: 'David Test Bakery',
    businessSector: 'Food',
    businessLocation: 'Tel Aviv',
  },
  noa:     {
    fullName: 'Noa Tester',
    email: 'e2e.noa@e2e.winnbell.com',
    password: 'Wbll-E2E#9xTq2026!',
    role: 'Business',
    businessName: 'Noa Test Cafe',
    businessSector: 'Food',
    businessLocation: 'Tel Aviv',
  },
};

export const testSetup = async (req: Request, res: Response): Promise<void> => {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ message: 'Not found' });
    return;
  }

  const { persona } = req.body as { persona: string };
  const config = PERSONAS[persona];
  if (!config) {
    res.status(400).json({ message: `Unknown persona "${persona}". Valid: ${Object.keys(PERSONAS).join(', ')}` });
    return;
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Upsert user ───────────────────────────────────────────────────────────
    const existing = await client.query(
      `SELECT id, role FROM "user" WHERE email = $1`,
      [config.email],
    );

    let userId: number;
    let userRole = config.role;

    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      // Ensure role is correct
      await client.query(
        `UPDATE "user" SET role = $1, full_name = $2 WHERE id = $3`,
        [config.role, config.fullName, userId],
      );
    } else {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(config.password, salt);
      const inserted = await client.query(
        `INSERT INTO "user" (full_name, email, password_hash, role, is_email_verified)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [config.fullName, config.email, hash, config.role],
      );
      userId = inserted.rows[0].id;
    }

    // ── Business record for Business personas ─────────────────────────────────
    let businessIsActive = false;
    let hasBusiness = false;

    if (config.role === 'Business') {
      // For 'david' and 'noa': ensure business exists, is active, enrolled in current draw
      if ((persona === 'david' || persona === 'noa') && config.businessName) {
        let bizId: number;
        const bizCheck = await client.query(
          `SELECT id FROM business WHERE user_id = $1`,
          [userId],
        );
        if (bizCheck.rows.length === 0) {
          const ins = await client.query(
            `INSERT INTO business (user_id, name, sector, description, is_subscribed, is_participating)
             VALUES ($1, $2, $3, $4, true, true) RETURNING id`,
            [userId, config.businessName, config.businessSector ?? 'Food',
              persona === 'david'
                ? 'A neighborhood bakery offering fresh bread and pastries baked daily.'
                : 'A modern café serving specialty coffee and light bites.'],
          );
          bizId = ins.rows[0].id;
        } else {
          bizId = bizCheck.rows[0].id;
          await client.query(
            `UPDATE business SET is_subscribed = true, is_participating = true WHERE id = $1`,
            [bizId],
          );
        }

        // Ensure at least one active location exists with valid lat/lon
        const locCheck = await client.query(
          `SELECT id, latitude, longitude FROM business_location WHERE business_id = $1 AND is_active = true LIMIT 1`,
          [bizId],
        );
        if (locCheck.rows.length === 0) {
          await client.query(
            `INSERT INTO business_location (business_id, name, address, latitude, longitude, is_active)
             VALUES ($1, $2, $3, $4, $5, true)`,
            [bizId,
              persona === 'david' ? 'Main Branch' : 'Tel Aviv Branch',
              persona === 'david' ? '123 Herzl Street, Tel Aviv' : '45 Rothschild Blvd, Tel Aviv',
              32.0853, 34.7818],
          );
        } else if (locCheck.rows[0].latitude == null || locCheck.rows[0].longitude == null) {
          // Fix any location that was saved without coordinates (e.g. from old free-text address bug)
          await client.query(
            `UPDATE business_location SET latitude = $1, longitude = $2 WHERE id = $3`,
            [32.0853, 34.7818, locCheck.rows[0].id],
          );
        }

        // Find or create an Open draw and enroll this business
        const drawRow = await client.query(
          `SELECT id FROM draw WHERE status = 'Open' ORDER BY draw_date ASC LIMIT 1`,
        );
        let drawId: number;
        if (drawRow.rows.length === 0) {
          const now = new Date();
          const drawDate = new Date(now.getFullYear(), now.getMonth() + 1, 0); // last day of current month
          const drawName = `${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()} Draw`;
          const newDraw = await client.query(
            `INSERT INTO draw (name, prize_pool, draw_date, status) VALUES ($1, 0, $2, 'Open') RETURNING id`,
            [drawName, drawDate],
          );
          drawId = newDraw.rows[0].id;
        } else {
          drawId = drawRow.rows[0].id;
        }

        await client.query(
          `INSERT INTO draw_entry (draw_id, business_id, fee_at_entry, contribution_amount)
           VALUES ($1, $2, 0, 0) ON CONFLICT (draw_id, business_id) DO NOTHING`,
          [drawId, bizId],
        );

        businessIsActive = true;
        hasBusiness = true;
      }
    }

    await client.query('COMMIT');

    let signInToken: string | undefined;
    if (process.env.CLERK_SECRET_KEY) {
      try {
        const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
        const nameParts = config.fullName.split(' ');
        const existing = await clerkClient.users.getUserList({ emailAddress: [config.email], limit: 1 });
        let clerkUserId: string;
        if (existing.data.length === 0) {
          const created = await clerkClient.users.createUser({
            emailAddress: [config.email],
            password: config.password,
            firstName: nameParts[0],
            lastName: nameParts.slice(1).join(' ') || undefined,
            skipPasswordChecks: true,
          });
          clerkUserId = created.id;
        } else {
          clerkUserId = existing.data[0].id;
        }
        const tokenResult = await clerkClient.signInTokens.createSignInToken({
          userId: clerkUserId,
          expiresInSeconds: 120,
        });
        signInToken = tokenResult.token;
      } catch (clerkErr: any) {
        console.warn('[test-setup] Clerk sync warning:', clerkErr.message);
      }
    }

    // ── Issue fresh JWT ────────────────────────────────────────────────────────
    const token = jwt.sign(
      { id: userId, role: userRole, location_id: null },
      process.env.JWT_SECRET as string,
      { expiresIn: '7d' },
    );

    const user = {
      id: userId,
      role: userRole,
      location_id: null,
      email: config.email,
      fullName: config.fullName,
      requiresBusinessSetup: config.role === 'Business' && !hasBusiness,
      businessIsActive,
      businessLogoUrl: null,
    };

    res.json({ token, user, signInToken });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('[test-setup]', err);
    res.status(500).json({ message: err.message });
  } finally {
    client.release();
  }
};
