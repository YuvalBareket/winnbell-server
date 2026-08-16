import crypto from 'crypto';
import { getPool } from '../../shared/db/db.js';
import {
  CLIENT_META_WHITELIST,
  UUID_RE,
  type ClientEventType,
  type DeviceClass,
  type FunnelEventType,
  type ReasonCode,
} from './funnelTypes.js';

// ── Server-authoritative emitter ─────────────────────────────────────────────
//
// Fire-and-forget by contract (same pattern as validateReceiptAsync): callers invoke
// it AFTER their transaction has committed / response is on the wire, never await it,
// and a failure here can never fail a user-facing request. Analytics losing an event
// is accepted; analytics slowing down or breaking the app is not.

export interface ServerFunnelEvent {
  eventType: FunnelEventType;
  userId?: number | null;
  /** Journey UUID from the x-wb-fsid request header; omit in worker contexts. */
  sessionId?: string | null;
  reasonCode?: ReasonCode | null;
  locationId?: number | null;
  /** Small whitelisted facts only - never PII. Quarantine fields are INTERNAL:
   *  nothing written here is ever returned to a client. */
  meta?: Record<string, string | number | boolean> | null;
}

export function recordFunnelEvent(e: ServerFunnelEvent): void {
  void (async () => {
    const sessionId = e.sessionId && UUID_RE.test(e.sessionId) ? e.sessionId : null;
    await getPool().query(
      `INSERT INTO funnel_event (event_id, session_id, user_id, event_type, reason_code, location_id, meta)
       VALUES ($1, $2, $3, $4, $5,
               (SELECT id FROM business_location WHERE id = $6),
               $7)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        crypto.randomUUID(),
        sessionId,
        e.userId ?? null,
        e.eventType,
        e.reasonCode ?? null,
        e.locationId ?? null,
        e.meta ? JSON.stringify(e.meta) : null,
      ],
    );
  })().catch((err) => {
    console.error('[funnel] record failed:', err instanceof Error ? err.message : err);
  });
}

// ── Client batch ingestion ───────────────────────────────────────────────────

export interface ValidatedClientEvent {
  eventId: string;
  eventType: ClientEventType;
  clientTs: Date | null;
  reasonCode: ReasonCode | null;
  locationId: number | null;
  meta: Record<string, string | number | boolean> | null;
}

/** Sanitize a client event's meta down to the per-type whitelist. */
export function sanitizeClientMeta(
  eventType: ClientEventType,
  meta: unknown,
): Record<string, string | number | boolean> | null {
  const allowed = CLIENT_META_WHITELIST[eventType];
  if (!allowed || typeof meta !== 'object' || meta === null) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const key of allowed) {
    const v = (meta as Record<string, unknown>)[key];
    if (typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 40)) {
      out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Client clocks drift and lie: accept timestamps up to 24h old / 5min ahead, else NULL
 *  (occurred_at, the server clock, remains the fallback for every query). */
export function sanitizeClientTs(ts: unknown, now: Date = new Date()): Date | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  const d = new Date(ts);
  const ageMs = now.getTime() - d.getTime();
  if (ageMs > 24 * 60 * 60 * 1000 || ageMs < -5 * 60 * 1000) return null;
  return d;
}

/** One multi-row insert for the whole batch; event_id dedup makes client retries safe.
 *  location_id goes through a scalar subquery so an unknown id becomes NULL instead of
 *  an FK violation killing the batch. */
export async function insertClientEventBatch(
  events: ValidatedClientEvent[],
  ctx: { sessionId: string; userId: number | null; deviceClass: DeviceClass },
): Promise<void> {
  if (events.length === 0) return;
  await getPool().query(
    `INSERT INTO funnel_event (event_id, session_id, user_id, event_type, reason_code, location_id, device_class, client_ts, meta)
     SELECT u.event_id::uuid, $1::uuid, $2::int, u.event_type, u.reason_code,
            (SELECT bl.id FROM business_location bl WHERE bl.id = u.location_id),
            $3::text, u.client_ts, u.meta::jsonb
     FROM unnest($4::text[], $5::text[], $6::text[], $7::int[], $8::timestamp[], $9::text[])
       AS u(event_id, event_type, reason_code, location_id, client_ts, meta)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      ctx.sessionId,
      ctx.userId,
      ctx.deviceClass,
      events.map((e) => e.eventId),
      events.map((e) => e.eventType),
      events.map((e) => e.reasonCode),
      events.map((e) => e.locationId),
      events.map((e) => e.clientTs),
      events.map((e) => (e.meta ? JSON.stringify(e.meta) : null)),
    ],
  );
}
