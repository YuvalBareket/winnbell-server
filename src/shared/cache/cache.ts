import NodeCache from 'node-cache';
import { getPool } from '../db/db.js';

// ── Cache instances ──────────────────────────────────────────────────────────
// Separate instances so flushes and TTLs are independent.

/** Per-user auth data (is_active, role). High key count, short TTL. */
export const userCache = new NodeCache({ stdTTL: 60, checkperiod: 120, maxKeys: 200_000 });

/** Public endpoint data (nearby, participating, draws, founding). */
export const publicCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });

/** Platform settings (single row, rarely changes). */
export const platformCache = new NodeCache({ stdTTL: 300, checkperiod: 600 });

// ── Platform settings helper ─────────────────────────────────────────────────
// Replaces all direct `SELECT ... FROM platform_settings WHERE id = 1` calls.

export interface PlatformSettings {
  allowed_states: string[];
  entries_per_location: number;
  founding_member_cap: number;
  founding_member_price_cents: number;
  founding_phase_active?: boolean;
  [key: string]: unknown;
}

const PLATFORM_KEY = 'platform:settings';

export const getPlatformSettings = async (): Promise<PlatformSettings> => {
  const cached = platformCache.get<PlatformSettings>(PLATFORM_KEY);
  if (cached) return cached;

  const pool = getPool();
  const result = await pool.query('SELECT * FROM platform_settings WHERE id = 1');
  const settings = result.rows[0] ?? {} as PlatformSettings;
  platformCache.set(PLATFORM_KEY, settings);
  return settings;
};

export const invalidatePlatformSettings = (): void => {
  platformCache.del(PLATFORM_KEY);
};

// ── Invalidation helpers ─────────────────────────────────────────────────────

/** Flush all public-facing caches (nearby, participating, draws, etc.). Use only for
 *  changes that affect public data broadly — a draw opening/closing, a business
 *  subscribing/cancelling, a location being added/removed. NOT for ticket activations:
 *  those only affect one location's cap_reached flag (see invalidatePublicLocation). */
export const invalidatePublicBusinessData = (): void => {
  const keys = publicCache.keys().filter(k =>
    k.startsWith('business:') || k.startsWith('draws:') || k.startsWith('founding:'),
  );
  if (keys.length) publicCache.del(keys);
};

/** Invalidate the cached location-profile payload for ONE location. A ticket write only
 *  changes that location's `cap_reached` count, so scope the flush to its keys instead of
 *  wiping every public business/draws/founding cache (which kept the public cache from ever
 *  warming on a busy draw). The profile is cached under two variants (unconditional `:any`
 *  and gated `:participating`), so both must be cleared. This function is the single source
 *  of truth for that key scheme — do not hand-roll these keys elsewhere. */
export const invalidatePublicLocation = (locationId: number): void => {
  publicCache.del([`business:location:${locationId}:any`, `business:location:${locationId}:participating`]);
};

/** Invalidate a user's cached auth state (is_active/is_phone_verified guard AND
 *  the role/manager-status used to detect stale elevated sessions). Called on
 *  role changes (manager removal), password reset, deletion, etc. */
export const invalidateUserAuth = (userId: number): void => {
  userCache.del(`user:guard:${userId}`);
  userCache.del(`user:role:${userId}`);
};
