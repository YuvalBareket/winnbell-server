import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as authService from './auth.service.js';
import { RegisterRequest, AuthResponse } from './auth.types.js';
import { getPool } from '../../shared/db/db.js';
import { safeRollback } from '../../shared/db/txn.js';
import { getPlatformSettings, invalidateUserAuth } from '../../shared/cache/cache.js';
import { validateLengths } from '../../shared/validation.js';
import { getClientIp } from '../../shared/clientIp.js';

// F7: createRemoteJWKSet returns a CACHING key resolver. Instantiate it ONCE at module scope so
// Supabase's signing keys are fetched once and reused; instantiating per-request threw the cache
// away and hit Supabase's JWKS endpoint on every sync/revoke, so a Supabase JWKS blip failed all
// sign-ins. Lazy so SUPABASE_URL is read at first use (after env load), not at import time.
let jwksResolver: ReturnType<typeof createRemoteJWKSet> | null = null;
const getJWKS = (): ReturnType<typeof createRemoteJWKSet> => {
  if (!jwksResolver) {
    jwksResolver = createRemoteJWKSet(
      new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
    );
  }
  return jwksResolver;
};

// Minimum password length for the legacy direct-register endpoint (F18). The primary sign-up
// path is Supabase, which enforces its own policy; this guards /auth/register's own hashing path.
const MIN_PASSWORD_LENGTH = 8;

export const register = async (
  req: Request<{}, {}, RegisterRequest>,
  res: Response<AuthResponse>,
): Promise<void> => {
  try {
    const { fullName, email, password, role, inviteToken } = req.body;

    // Type guard: a truthy non-string (array/object) would pass a bare presence check and then
    // throw a 500 deep in registerUser (email.toLowerCase). Reject as a clean 400.
    if (typeof fullName !== 'string' || !fullName
      || typeof email !== 'string' || !email
      || typeof password !== 'string' || !password) {
      res.status(400).json({ message: 'All fields are required' });
      return;
    }

    const lenErr = validateLengths([
      ['Full name', fullName, 100],
      ['Email', email, 255],
      ['Password', password, 128],
    ]);
    if (lenErr) { res.status(400).json({ message: lenErr }); return; }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
      return;
    }

    const result = await authService.registerUser(fullName, email, password, role, inviteToken, getClientIp(req));
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
  // Must be a string: a truthy non-string (array/object) passes `!email` and validateLengths
  // (which skips non-strings), then email.toLowerCase() below would throw a 500 instead of a 400.
  if (typeof email !== 'string' || !email) { res.status(400).json({ message: 'Email required' }); return; }
  const lenErr = validateLengths([['Email', email, 255]]);
  if (lenErr) { res.status(400).json({ message: lenErr }); return; }
  try {
    // Signup-email policy runs here FIRST so the register form can explain the
    // rejection before the user ever reaches Supabase signup / email verification.
    const blockReason = authService.signupEmailBlockReason(email.toLowerCase().trim());
    if (blockReason) { res.json({ exists: false, blocked: true, message: blockReason }); return; }
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

    // Type guard: a truthy non-string (array/object) would pass a bare presence check and then
    // throw a 500 deep in loginUser (email.split/.toLowerCase). Reject as a clean 400.
    if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
      res.status(400).json({ message: 'Email and password are required' });
      return;
    }

    const lenErr = validateLengths([['Email', email, 255], ['Password', password, 128]]);
    if (lenErr) { res.status(400).json({ message: lenErr }); return; }

    const result = await authService.loginUser(email, password, inviteToken);
    res.status(200).json(result);
  } catch {
    // loginUser tolerates invite-token problems internally (it never throws them),
    // so any error here is a genuine credential failure.
    res.status(401).json({ message: 'Invalid email or password' });
  }
};

// POST /auth/profile-setup  body: { dateOfBirth: 'YYYY-MM-DD', gender, state }
// Step-2 profile setup for consumers and location managers (authenticated).
export const profileSetup = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  const { dateOfBirth, gender, state } = req.body ?? {};
  if (!dateOfBirth || !gender || !state) {
    res.status(400).json({ message: 'Date of birth, gender, and state are required' });
    return;
  }
  const lenErr = validateLengths([['Date of birth', dateOfBirth, 10], ['Gender', gender, 20], ['State', state, 2]]);
  if (lenErr) { res.status(400).json({ message: lenErr }); return; }

  try {
    const result = await authService.completeProfileSetup(userId, dateOfBirth, gender, state);
    res.json({ message: 'Profile updated', ...result });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'User not found') {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    if (error instanceof Error && (error.message.startsWith('Please') || error.message.startsWith('You must'))) {
      // Validation errors from the service carry user-facing messages
      res.status(400).json({ message: error.message });
      return;
    }
    res.status(500).json({ message: 'Server error' });
  }
};

// POST /auth/update-name  body: { fullName }  - edit display name from Settings (authenticated).
export const updateName = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  const { fullName } = req.body ?? {};
  const lenErr = validateLengths([['Name', fullName, 100]]);
  if (lenErr) { res.status(400).json({ message: lenErr }); return; }

  try {
    const result = await authService.updateFullName(userId, fullName);
    res.json({ message: 'Name updated', ...result });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'User not found') {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    if (error instanceof Error && (error.message.startsWith('Please') || error.message.startsWith('Name'))) {
      res.status(400).json({ message: error.message });
      return;
    }
    res.status(500).json({ message: 'Server error' });
  }
};

// Called by the reset-password flow after a successful password change to log the
// user out of every other existing session. Authenticated by the user's Supabase
// access token (same verification as syncUser). Deleting all internal refresh tokens
// stops any stale session from renewing; the short-lived (1h) access tokens then
// expire on their own. The client also revokes other Supabase sessions separately.
export const revokeAllSessions = async (req: Request, res: Response): Promise<void> => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    res.status(401).json({ message: 'No token provided' });
    return;
  }

  let email = '';
  try {
    const { payload } = await jwtVerify(token, getJWKS());
    email = (((payload as Record<string, unknown>)['email'] as string) ?? '').toLowerCase().trim();
  } catch (err: unknown) {
    console.error('Revoke sessions: token verify failed:', err instanceof Error ? err.message : err);
    res.status(401).json({ message: 'Invalid or expired token' });
    return;
  }

  if (!email) {
    res.status(400).json({ message: 'Token missing email' });
    return;
  }

  try {
    const pool = getPool();
    const userRes = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [email]);
    const userId = userRes.rows[0]?.id as number | undefined;
    if (userId) {
      // INSTANT revocation: bump the session epoch so every already-issued internal JWT for
      // this user (including a compromised one) is rejected on its next request, then delete
      // the refresh tokens so none can be rotated, then clear the auth cache so the new epoch
      // is read immediately (not up to 60s later). One transaction + the per-user advisory
      // lock shared with /auth/refresh: a refresh racing this revoke either completes fully
      // BEFORE it (its new token is then visible to our DELETE and wiped; its access token
      // carries the pre-bump epoch and dies on next request) or waits and finds its refresh
      // token already deleted. No token can slip through the wipe.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT pg_advisory_xact_lock(11, $1)`, [userId]);
        await client.query(`UPDATE "user" SET token_epoch = token_epoch + 1 WHERE id = $1`, [userId]);
        await client.query(`DELETE FROM refresh_token WHERE user_id = $1`, [userId]);
        await client.query('COMMIT');
      } catch (txErr) {
        await safeRollback(client);
        throw txErr;
      } finally {
        client.release();
      }
      invalidateUserAuth(userId);
    }
    // Always 200 - never reveal whether the email maps to an account.
    res.json({ success: true });
  } catch (err: unknown) {
    console.error('Revoke sessions failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ message: 'Server error' });
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
    const { payload: verified } = await jwtVerify(token, getJWKS());
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
    const { inviteToken, role: bodyRole, referralCode, acquisitionSource, acquiredViaLocationId, promoCode } = req.body;
    // Role comes from JWT user_metadata (set at signUp time) — atomic, no race condition.
    // For OAuth sign-ins user_metadata.role is absent; fall back to req.body.role (set
    // from pendingRole localStorage by useSupabaseSync before calling syncUser).
    const roleFromToken = (meta['role'] as string | undefined) ?? (bodyRole as string | undefined);
    const ip = getClientIp(req);

    const result = await authService.syncExternalUser(payload['sub'] as string, email, fullName, {
      role: roleFromToken,
      inviteToken: inviteToken || (meta['invite_token'] as string) || null,
      ip,
      referralCode: (referralCode as string) || (meta['referral_code'] as string) || null,
      acquisitionSource: (acquisitionSource as string) || null,
      acquiredViaLocationId: typeof acquiredViaLocationId === 'number' ? acquiredViaLocationId : (Number(acquiredViaLocationId) || null),
      promoCode: (promoCode as string) || null,
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
    if (err instanceof Error && err.message === 'EMAIL_NOT_ALLOWED') {
      res.status(403).json({ message: 'EMAIL_NOT_ALLOWED' });
      return;
    }
    // syncExternalUser tolerates invite-token problems internally (it never
    // re-throws them), so there is no invite-error branch to map here.
    console.error('Sync service error:', err instanceof Error ? err.message : err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getRegionConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    const settings = await getPlatformSettings();
    const allowed_states: string[] = settings.allowed_states ?? [];
    res.json({ allowed_states });
  } catch {
    res.json({ allowed_states: [] });
  }
};

export const checkRegion = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await authService.evaluateRegionRestriction(getClientIp(req));
    res.json({ blocked: result.blocked, country: result.country, state: result.state, approx_location: result.approxLocation });
  } catch {
    res.json({ blocked: false, country: null, state: null, approx_location: null });
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

    // Revoke refresh tokens AND anonymize PII atomically, so we can never end up with the tokens
    // deleted but the account still active (or vice versa). Tickets/entries are preserved for
    // draw integrity.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Same per-user advisory lock as /auth/refresh and revokeAllSessions: a refresh racing
      // this deletion cannot commit a new token that our DELETE would miss (MVCC snapshot).
      await client.query(`SELECT pg_advisory_xact_lock(11, $1)`, [userId]);
      await client.query(`DELETE FROM refresh_token WHERE user_id = $1`, [userId]);
      // A self-deleting location manager must release their location: the user row is
      // UPDATEd (not deleted), so the FK's ON DELETE SET NULL never fires on its own.
      await client.query(`UPDATE business_location SET manager_user_id = NULL WHERE manager_user_id = $1`, [userId]);
      await client.query(
        `UPDATE "user" SET
           full_name    = 'Deleted User',
           email        = 'deleted_' || id::text || '@winnbell.invalid',
           phone_number = NULL,
           is_active    = FALSE,
           role         = 'User',
           token_epoch  = token_epoch + 1
         WHERE id = $1`,
        [userId],
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await safeRollback(client);
      throw txErr;
    } finally {
      client.release();
    }
    invalidateUserAuth(userId);

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

// POST /auth/logout  body: { refreshToken }
// Server-side revocation of THIS device's session: deletes the one matching refresh token
// so a logged-out (or compromised) token can never be refreshed again. Possessing the
// refresh token is proof enough to invalidate it, so no auth middleware — same trust model
// as /auth/refresh. Idempotent and never hard-fails: the client calls this fire-and-forget
// while clearing local state, and a server hiccup must never block a logout.
export const logoutController = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken || typeof refreshToken !== 'string') {
      res.json({ revoked: false });
      return;
    }
    const pool = getPool();
    const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const result = await pool.query(
      'DELETE FROM refresh_token WHERE token_hash = $1 RETURNING id',
      [hash],
    );
    res.json({ revoked: (result.rowCount ?? 0) > 0 });
  } catch (err: unknown) {
    console.error('[logout]', err instanceof Error ? err.message : err);
    res.json({ revoked: false });
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

    // Rotation is transactional (F3): consuming the old token and inserting the new one must be
    // all-or-nothing on ONE connection. Previously each step ran on the pool (autocommit), so a
    // crash / connection drop / restart AFTER the consume committed but BEFORE the new token was
    // saved left the client holding only the now-consumed old token -> dead session past the grace
    // window -> kicked. Wrapping in BEGIN/COMMIT means a failure ROLLs the consume back, leaving
    // the old token fully valid for a clean retry. The UPDATE's row lock is now held until COMMIT,
    // so concurrent racers on the same token serialize cleanly.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Serialize against revocation (revokeAllSessions / deleteAccount) with a per-user
      // advisory lock. Without it, a refresh in flight at the exact moment of a password reset
      // could commit a NEW refresh token after the revoke's DELETE took its snapshot (READ
      // COMMITTED MVCC) - the fresh token would survive the wipe. Lock ordering everywhere is
      // advisory(user) FIRST, then refresh_token rows, so no deadlock. The user_id is read with
      // a plain SELECT (no consume) purely to know which lock to take; the consuming UPDATE
      // below re-checks its full predicate after the lock is acquired.
      const who = await client.query(
        `SELECT user_id FROM refresh_token WHERE token_hash = $1`,
        [hash],
      );
      if (who.rows.length === 0) {
        await safeRollback(client);
        res.status(401).json({ message: 'Invalid or expired refresh token' });
        return;
      }
      await client.query(`SELECT pg_advisory_xact_lock(11, $1)`, [who.rows[0].user_id]);

      // Consume with a grace window instead of hard-deleting. Rotation is single-use in
      // spirit, but multiple app contexts (second tab, installed PWA window, restored mobile
      // webview) share ONE persisted refresh token and race to refresh at access-token expiry.
      // Hard delete made every racer after the first fail with 401 -> client dropped the
      // account -> user kicked mid-session. Accepting a consumed token again within a short
      // grace period lets every racer walk away with its own fresh pair, while a stolen token
      // replayed later than the grace window is still rejected. COALESCE keeps the FIRST
      // consume time so the window cannot be extended by repeated reuse; the UPDATE re-checks
      // its predicate on the locked row, so concurrent consumers serialize safely.
      const result = await client.query(
        `UPDATE refresh_token
         SET consumed_at = COALESCE(consumed_at, NOW())
         WHERE token_hash = $1 AND expires_at > NOW()
           AND (consumed_at IS NULL OR consumed_at > NOW() - interval '60 seconds')
         RETURNING id, user_id, family_id`,
        [hash],
      );
      const row = result.rows[0];
      if (!row) {
        // REUSE / THEFT DETECTION (audit P2-6). Legit racers land inside the 60s grace
        // and never reach this branch. A token that still EXISTS here but was consumed
        // beyond grace can only be presented by someone holding an out-of-chain copy -
        // the client that consumed it walked away with the rotated pair. Revoke the
        // entire token family (every session descended from that login) and COMMIT so
        // the revocation persists; the victim re-logs in, the thief holds nothing.
        // Same 401 body as every other failure - no oracle for the attacker.
        // (Consumed rows are retained 24h as tripwires; an expired-but-unconsumed token
        // is just a stale client and is NOT treated as theft.)
        const reused = await client.query(
          `SELECT user_id, family_id FROM refresh_token
           WHERE token_hash = $1 AND consumed_at IS NOT NULL
             AND consumed_at <= NOW() - interval '60 seconds'`,
          [hash],
        );
        if (reused.rows.length > 0) {
          const { user_id: victimId, family_id: familyId } = reused.rows[0];
          await client.query(`DELETE FROM refresh_token WHERE family_id = $1`, [familyId]);
          await client.query('COMMIT');
          console.error(`[SECURITY] Refresh token REUSE detected for user ${victimId} - token family ${familyId} revoked`);
          res.status(401).json({ message: 'Invalid or expired refresh token' });
          return;
        }
        await safeRollback(client);
        res.status(401).json({ message: 'Invalid or expired refresh token' });
        return;
      }

      const userResult = await client.query(
        `SELECT id, role, is_active, token_epoch FROM "user" WHERE id = $1`,
        [row.user_id],
      );
      const user = userResult.rows[0];
      if (!user || !user.is_active) {
        // Deactivated: revoke every session. COMMIT so the deletion (and the consume) persist.
        await client.query('DELETE FROM refresh_token WHERE user_id = $1', [row.user_id]);
        await client.query('COMMIT');
        res.status(401).json({ message: 'Account deactivated' });
        return;
      }

      const locResult = await client.query(
        `SELECT bl.id AS location_id FROM business_location bl WHERE bl.manager_user_id = $1 AND bl.is_active = TRUE LIMIT 1`,
        [user.id],
      );
      const locationId = locResult.rows[0]?.location_id ?? null;

      const newToken = jwt.sign(
        { id: user.id, role: user.role, location_id: locationId, se: user.token_epoch ?? 0 },
        process.env.JWT_SECRET as string,
        { expiresIn: '1h' },
      );

      const newRefreshToken = crypto.randomBytes(40).toString('hex');
      const newRefreshHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
      const newRefreshExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      // The rotated token INHERITS the consumed token's family - the lineage is what
      // makes reuse detection able to kill every descendant of a compromised login.
      await authService.insertRefreshTokenCapped(client, user.id, newRefreshHash, newRefreshExpiry, user.role, row.family_id);

      await client.query('COMMIT');
      res.json({ token: newToken, refreshToken: newRefreshToken });
    } catch (txErr) {
      await safeRollback(client); // undo the consume -> old token stays valid for a clean retry
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err: unknown) {
    console.error('[refreshToken]', err instanceof Error ? err.message : err);
    res.status(500).json({ message: 'Token refresh failed' });
  }
};

