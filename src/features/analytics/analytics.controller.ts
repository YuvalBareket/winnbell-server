import { Response } from 'express';
import { AuthRequest } from '../../shared/middleware/auth.middleware.js';
import {
  CLIENT_EVENT_TYPES,
  CLIENT_REASON_CODES,
  UUID_RE,
  type ClientEventType,
  type ReasonCode,
} from './funnelTypes.js';
import { classifyDevice, } from './deviceClass.js';
import {
  insertClientEventBatch,
  sanitizeClientMeta,
  sanitizeClientTs,
  type ValidatedClientEvent,
} from './analytics.service.js';

const MAX_EVENTS_PER_BATCH = 25;

// POST /events - public batch ingestion for CLIENT funnel events.
//
// Contract: this endpoint never breaks the app. Invalid input is silently dropped
// (not 400) and unexpected failures still answer 204 - a broken analytics pipe must
// be invisible to users. Server-authoritative event types are rejected per-event by
// the whitelist below; user identity comes ONLY from optionalAuth (never the body).
export const ingestEvents = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === 'string' && UUID_RE.test(body.sessionId) ? body.sessionId : null;
    const rawEvents = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_BATCH) : [];
    if (!sessionId || rawEvents.length === 0) {
      res.status(204).end();
      return;
    }

    const deviceClass = classifyDevice(req.headers['user-agent'], body.pwa === true);
    // Identity ONLY from optionalAuth's JWT (typed AuthRequest) - never from the body.
    const userId = req.user?.id ?? null;

    const valid: ValidatedClientEvent[] = [];
    for (const raw of rawEvents) {
      if (typeof raw !== 'object' || raw === null) continue;
      const e = raw as Record<string, unknown>;
      if (typeof e.id !== 'string' || !UUID_RE.test(e.id)) continue;
      if (typeof e.type !== 'string' || !(CLIENT_EVENT_TYPES as readonly string[]).includes(e.type)) continue;
      const eventType = e.type as ClientEventType;

      const reasonCode =
        eventType === 'registration_failed'
        && typeof e.reason === 'string'
        && (CLIENT_REASON_CODES as readonly string[]).includes(e.reason)
          ? (e.reason as ReasonCode)
          : null;

      const locationId =
        eventType === 'scan_landing_viewed'
        && typeof e.locationId === 'number'
        && Number.isInteger(e.locationId)
        && e.locationId > 0
          ? e.locationId
          : null;

      valid.push({
        eventId: e.id.toLowerCase(),
        eventType,
        clientTs: sanitizeClientTs(e.ts),
        reasonCode,
        locationId,
        meta: sanitizeClientMeta(eventType, e.meta),
      });
    }

    if (valid.length > 0) {
      await insertClientEventBatch(valid, { sessionId, userId, deviceClass });
    }
    res.status(204).end();
  } catch (err) {
    // Analytics must never surface an error to the app.
    console.error('[funnel] ingest failed:', err instanceof Error ? err.message : err);
    res.status(204).end();
  }
};
