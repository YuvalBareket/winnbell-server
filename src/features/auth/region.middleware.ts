import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import { getClientIp } from '../../shared/clientIp.js';
import { evaluateEntryRegionPolicy } from './auth.service.js';

/** Region result stashed on res.locals for the entry controllers (record + risk signal). */
export interface EntryRegionLocals {
  state: string | null;
  outOfRegion: boolean;
}

/**
 * Entry-time region gate (ToS physical-presence-at-entry). Hard-blocks only confidently
 * NON-US traffic; a wrong US state is passed through on res.locals.entryRegion as a soft
 * signal (carrier IPs often resolve to the wrong state, so it must never block).
 *
 * Mounted AFTER the per-user entry limiter so a caller cannot burn external geo-lookup
 * quota faster than the limiter allows. IP lookups are cached (regionIpCache), so repeat
 * submissions from the same IP cost nothing. Any internal failure fails open — a geo
 * hiccup must never stop a legitimate entry.
 */
export const requireEntryRegion = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const policy = await evaluateEntryRegionPolicy(getClientIp(req));
    if (policy.blocked) {
      res.status(403).json({
        code: 'REGION_RESTRICTED',
        message: 'Entries can only be submitted from within the United States.',
      });
      return;
    }
    res.locals.entryRegion = { state: policy.state, outOfRegion: policy.outOfRegion } satisfies EntryRegionLocals;
  } catch {
    // fail open — no entryRegion recorded
  }
  next();
};
