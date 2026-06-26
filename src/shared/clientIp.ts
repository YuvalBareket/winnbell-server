import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

/**
 * Resolve the real client IP behind the Cloudflare -> Render proxy chain.
 *
 * req.ip only strips one proxy hop (trust proxy = 1), which lands on Render's
 * internal address (10.x). The true client is provided by Cloudflare in the
 * `cf-connecting-ip` header (reliable, not client-spoofable when traffic only
 * reaches the origin through Cloudflare). We fall back to the left-most
 * X-Forwarded-For entry, then req.ip, so this still works off-Cloudflare.
 */
export const getClientIp = (req: Request): string => {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }

  return req.ip || '';
};

/**
 * Rate-limit key derived from the client IP, normalized for IPv6 via express-rate-limit's
 * `ipKeyGenerator` (groups IPv6 addresses by /64 so a user can't bypass limits by rotating
 * within their subnet). Use this in ANY rate-limiter keyGenerator that falls back to the IP —
 * a raw IP key throws ERR_ERL_KEY_GEN_IPV6 at startup in express-rate-limit v7+.
 */
export const getClientIpKey = (req: Request): string => ipKeyGenerator(getClientIp(req));
