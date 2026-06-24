// ─── Rate-limit store (Redis-backed when available, in-memory otherwise) ──────
// Express-rate-limit defaults to an in-memory store, which means each server
// instance counts requests separately. With multiple instances behind a load
// balancer, a client hitting different instances gets N× the intended limit —
// weakening bot/abuse protection at scale.
//
// When REDIS_URL is set, every limiter shares one Redis-backed counter, so limits
// hold globally across all instances. When REDIS_URL is NOT set, makeRateLimitStore
// returns undefined and express-rate-limit uses its default in-memory store — i.e.
// exactly the current single-instance behavior. So this is zero-risk until you opt
// in by setting REDIS_URL.
import type { Store } from 'express-rate-limit';
import { Redis } from 'ioredis';
import { RedisStore } from 'rate-limit-redis';

let client: Redis | null = null;
let triedConnect = false;

function getClient(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (triedConnect) return client;
  triedConnect = true;
  client = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 3 });
  client.on('error', (err: Error) => console.error('[redis] rate-limit store error:', err.message));
  client.on('connect', () => console.log('[redis] rate-limit store connected'));
  return client;
}

/**
 * Returns a Redis-backed store for one limiter (the unique `prefix` keeps each
 * limiter's counters separate), or `undefined` to fall back to the in-memory
 * default. Call once per limiter.
 */
export function makeRateLimitStore(prefix: string): Store | undefined {
  const c = getClient();
  if (!c) return undefined;
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendCommand: (...args: string[]) => (c.call as any)(...args) as Promise<any>,
  });
}
