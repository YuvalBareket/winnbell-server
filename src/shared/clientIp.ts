import type { Request } from 'express';

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
