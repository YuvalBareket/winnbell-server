import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';
import maxmind, { CityResponse, Reader } from 'maxmind';

/**
 * Local GeoLite2-City database (MaxMind free tier) — the PRIMARY geolocation source.
 *
 * Replaces the per-request ipinfo.io HTTP call with an in-memory lookup: unlimited volume,
 * microseconds, no quota, no timeout, and no user IPs sent to a third party. ipinfo remains
 * the automatic fallback in auth.service.getRegionFromIp whenever this module has no answer
 * (no license key, download not finished yet, download failed, IP not in the database), so
 * the worst case of this system is exactly the pre-GeoLite behavior.
 *
 * Lifecycle: initGeoLite() at server boot downloads the ~60MB .mmdb (Render disk is
 * ephemeral, so every deploy re-fetches) and re-downloads when the file ages past
 * MAX_DB_AGE_MS (MaxMind publishes twice weekly; the EULA requires staying current).
 * maxmind's watchForUpdates hot-reloads the reader when the file is replaced.
 */

const DOWNLOAD_URL = (key: string) =>
  `https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${encodeURIComponent(key)}&suffix=tar.gz`;

const DB_PATH = process.env.GEOLITE_DB_PATH || path.join(os.tmpdir(), 'winnbell-GeoLite2-City.mmdb');
const MAX_DB_AGE_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const REFRESH_CHECK_MS = 24 * 60 * 60 * 1000;  // check age daily

let reader: Reader<CityResponse> | null = null;

/** Region shape mirroring auth.service's IpRegion (kept structural to avoid a cycle). */
export interface GeoRegion {
  country: string | null;
  stateCode: string | null;
  city: string | null;
  approxLocation: { latitude: number; longitude: number } | null;
}

/** Pure mapping from a GeoLite2 City record to the app's region shape. Exported for tests. */
export const mapCityResponse = (r: CityResponse | null): GeoRegion | null => {
  const country = r?.country?.iso_code;
  if (!country || country.length !== 2) return null;

  // Subdivision iso_code IS the USPS state code for US records ('FL', 'DC', ...).
  const sub = r?.subdivisions?.[0]?.iso_code;
  const stateCode = country === 'US' && typeof sub === 'string' && /^[A-Z]{2}$/.test(sub) ? sub : null;

  const rawCity = r?.city?.names?.en;
  const city = typeof rawCity === 'string' && rawCity.trim() ? rawCity.trim().slice(0, 120) : null;

  const latitude = r?.location?.latitude;
  const longitude = r?.location?.longitude;
  const approxLocation =
    typeof latitude === 'number' && typeof longitude === 'number' &&
    Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
      ? { latitude, longitude }
      : null;

  return { country, stateCode, city, approxLocation };
};

/**
 * Synchronous in-memory lookup. Returns null when the database is not (yet) loaded, the IP
 * is malformed, or GeoLite has no record — callers fall back to ipinfo in all those cases.
 */
export const lookupGeoLite = (ip: string): GeoRegion | null => {
  if (!reader) return null;
  try {
    return mapCityResponse(reader.get(ip));
  } catch {
    return null; // malformed IP string — let the fallback path decide
  }
};

const dbAgeMs = async (): Promise<number | null> => {
  try {
    const stat = await fsp.stat(DB_PATH);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null; // missing
  }
};

/** Strip the license key from anything that might echo the download URL (fetch network
 *  errors embed the full URL in err.message — the key must never reach the logs). */
const redactKey = (msg: string): string => msg.replace(/license_key=[^&\s]+/g, 'license_key=REDACTED');

/** Download the tar.gz from MaxMind and place the contained .mmdb at DB_PATH. */
const downloadDb = async (key: string): Promise<boolean> => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'geolite-dl-'));
  const controller = new AbortController();
  // Generous ceiling for a ~60MB file on a slow link; a stalled connection must not hold
  // a socket forever (the ipinfo fallback keeps serving lookups regardless).
  const downloadTimeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  try {
    const res = await fetch(DOWNLOAD_URL(key), { signal: controller.signal });
    if (!res.ok || !res.body) {
      console.error(`[geolite] download failed: HTTP ${res.status}${res.status === 401 ? ' (check MAXMIND_LICENSE_KEY)' : ''}`);
      return false;
    }
    // tar auto-detects the gzip layer; only the .mmdb entry is extracted. noMtime: the
    // archive stamps files with MaxMind's BUILD date - preserving it would make a fresh
    // download look days old to the mtime-based staleness check and could re-download in
    // a loop; with noMtime the file's mtime is the extraction (= download) time.
    await pipeline(
      Readable.fromWeb(res.body as import('stream/web').ReadableStream),
      tar.extract({ cwd: tmpDir, filter: (p) => p.endsWith('.mmdb'), noMtime: true }),
    );

    // The archive nests the file as GeoLite2-City_YYYYMMDD/GeoLite2-City.mmdb — locate it.
    const entries = await fsp.readdir(tmpDir, { recursive: true });
    const mmdbRel = entries.find((e) => String(e).endsWith('.mmdb'));
    if (!mmdbRel) {
      console.error('[geolite] archive contained no .mmdb file');
      return false;
    }
    // Containment check: don't rely solely on tar's internal traversal defenses — the
    // extracted path must resolve inside tmpDir or the archive is treated as hostile.
    const resolved = path.resolve(tmpDir, String(mmdbRel));
    if (!resolved.startsWith(tmpDir + path.sep)) {
      console.error('[geolite] archive contained a suspicious path — aborting');
      return false;
    }
    // copy+rename via a sibling temp file so a reader watching DB_PATH never sees a partial write
    const staging = `${DB_PATH}.tmp`;
    await fsp.copyFile(resolved, staging);
    await fsp.rename(staging, DB_PATH);
    return true;
  } catch (err) {
    console.error('[geolite] download failed:', err instanceof Error ? redactKey(err.message) : err);
    return false;
  } finally {
    clearTimeout(downloadTimeout);
    // Awaited: leaked 60MB scratch dirs would accumulate on Render's small ephemeral disk.
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
  }
};

const ensureImpl = async (): Promise<boolean> => {
  const key = process.env.MAXMIND_LICENSE_KEY;
  if (!key) return false;

  const age = await dbAgeMs();
  if (age === null || age > MAX_DB_AGE_MS) {
    const ok = await downloadDb(key);
    if (!ok && age === null) return false; // nothing on disk and download failed
    if (!ok) console.warn('[geolite] refresh failed — continuing on the existing (stale) database');
  }

  if (!reader) {
    try {
      // NonPersistent: the file watcher must never keep the event loop alive past SIGTERM
      // (Render would otherwise SIGKILL instead of a graceful shutdown).
      reader = await maxmind.open<CityResponse>(DB_PATH, { watchForUpdates: true, watchForUpdatesNonPersistent: true });
      const stat = await fsp.stat(DB_PATH);
      console.log(`[geolite] local GeoLite2-City loaded (${(stat.size / 1e6).toFixed(0)}MB, downloaded ${stat.mtime.toISOString().slice(0, 10)})`);
    } catch (err) {
      console.error('[geolite] failed to open database:', err instanceof Error ? redactKey(err.message) : err);
      return false;
    }
  }
  return true;
};

let inFlightEnsure: Promise<boolean> | null = null;

/**
 * Ensure the database exists, is fresh, and is loaded into the reader.
 * Returns true when lookups are being served locally. Safe to call repeatedly —
 * concurrent calls (boot + daily interval) share one in-flight run, so two 60MB
 * downloads can never race each other on the staging file.
 */
export const ensureGeoLiteReady = async (): Promise<boolean> => {
  if (inFlightEnsure) return inFlightEnsure;
  inFlightEnsure = ensureImpl().finally(() => { inFlightEnsure = null; });
  return inFlightEnsure;
};

/**
 * Boot hook: load (downloading if needed) in the background and keep the file fresh.
 * Never blocks startup and never throws — until ready, getRegionFromIp uses ipinfo.
 */
export const initGeoLite = (): void => {
  if (process.env.NODE_ENV === 'test') return;
  if (!process.env.MAXMIND_LICENSE_KEY) {
    console.warn('[geolite] MAXMIND_LICENSE_KEY not set — geolocation will use ipinfo only');
    return;
  }
  ensureGeoLiteReady().then((ok) => {
    if (!ok) console.warn('[geolite] not ready — falling back to ipinfo until the next refresh attempt');
  }).catch((err) => console.error('[geolite] init failed:', err));

  const interval = setInterval(() => {
    ensureGeoLiteReady().catch((err) => console.error('[geolite] refresh failed:', err));
  }, REFRESH_CHECK_MS);
  interval.unref(); // never keep the process alive for this
};

/** Test hook: reset module state so unit tests can exercise the not-loaded path.
 *  No-op outside the test environment so nothing can silently unload the reader in prod. */
export const __resetGeoLiteForTests = (): void => {
  if (process.env.NODE_ENV !== 'test') return;
  reader = null;
};

// Re-exported for the verification script; not used by app code.
export const __geoLitePaths = { DB_PATH, exists: () => fs.existsSync(DB_PATH) };
