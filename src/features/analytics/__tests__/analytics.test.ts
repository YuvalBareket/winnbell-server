/**
 * QA Tests — funnel analytics (reasonCodes, deviceClass, sanitizers, ingestEvents)
 *
 * Covers:
 *   reason mapping     — every KNOWN service error message maps to a real code (never
 *                        unknown_error); this test is the tripwire when services grow
 *                        new error strings without a mapping
 *   device classing    — coarse buckets only, pwa flag honored
 *   sanitizers         — client timestamps clamped, meta reduced to the whitelist
 *   ingest controller  — session validation, server-event rejection, identity from
 *                        req.user only, truncation, and the always-204 contract
 */

const mockInsert = jest.fn();

jest.mock('../analytics.service.js', () => {
  const actual = jest.requireActual('../analytics.service.js');
  return { ...actual, insertClientEventBatch: (...args: unknown[]) => mockInsert(...args) };
});

import { mapErrorToReasonCode } from '../reasonCodes';
import { classifyDevice } from '../deviceClass';
import { sanitizeClientMeta, sanitizeClientTs } from '../analytics.service';
import { ingestEvents } from '../analytics.controller';
import type { Request, Response } from 'express';

const SESSION = 'b0000000-0000-4000-8000-000000000000';
const EV_ID = 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d';

const run = async (body: Record<string, unknown>, user?: { id: number }) => {
  const end = jest.fn();
  const status = jest.fn().mockReturnValue({ end });
  const res = { status } as unknown as Response;
  const req = { body, user, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' } } as unknown as Request;
  await ingestEvents(req, res);
  return { status, end };
};

beforeEach(() => jest.clearAllMocks());

describe('mapErrorToReasonCode', () => {
  // The literal messages tickets.service throws today. If a mapping breaks (message
  // reworded, pattern shadowed by an earlier one), this fails loudly.
  test.each([
    ['RECEIPT_CONTEST_IMAGE_REQUIRED', 'receipt_contested'],
    ['This receipt is already being reviewed. Please try again later.', 'receipt_contested'],
    ['This receipt has already been entered.', 'duplicate_receipt'],
    ['Weekly limit reached. Come back next week!', 'weekly_limit_reached'],
    ['Please verify your email before entering.', 'email_unverified'],
    ['PHONE_NOT_VERIFIED', 'phone_unverified'],
    ['No active campaign for this business.', 'no_active_campaign'],
    ['This receipt is older than 7 days.', 'receipt_too_old'],
    ['Purchase date must be within campaign dates.', 'date_outside_campaign'],
    ['This business requires a purchase of $20 or more.', 'below_threshold'],
    ['Daily entry limit reached. Try again tomorrow.', 'daily_limit_high_risk'],
    ['A receipt image is required for this entry.', 'image_required'],
    ['Suspicious sequential pattern detected.', 'sequential_pattern'],
    ['This location has run out of entries for this draw.', 'location_cap_reached'],
    ['You have reached the maximum number of entries for this draw.', 'user_draw_cap_reached'],
    ['Invalid code.', 'invalid_code'],
  ])('%s -> %s', (message, expected) => {
    expect(mapErrorToReasonCode(message)).toBe(expected);
  });

  test('unrecognized and empty messages fall back to unknown_error', () => {
    expect(mapErrorToReasonCode('Something exploded')).toBe('unknown_error');
    expect(mapErrorToReasonCode('')).toBe('unknown_error');
    expect(mapErrorToReasonCode(undefined)).toBe('unknown_error');
  });
});

describe('classifyDevice', () => {
  test.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', false, 'ios_safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', true, 'ios_pwa'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8)', false, 'android_chrome'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8)', true, 'android_pwa'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', false, 'desktop'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', false, 'desktop'],
    ['', false, 'other'],
  ])('%s (pwa=%s) -> %s', (ua, pwa, expected) => {
    expect(classifyDevice(ua, pwa as boolean)).toBe(expected);
  });
});

describe('sanitizeClientTs', () => {
  const now = new Date('2026-08-15T12:00:00Z');
  test('recent timestamp is kept', () => {
    const t = now.getTime() - 5_000;
    expect(sanitizeClientTs(t, now)?.getTime()).toBe(t);
  });
  test('older than 24h -> null', () => {
    expect(sanitizeClientTs(now.getTime() - 25 * 60 * 60 * 1000, now)).toBeNull();
  });
  test('more than 5min in the future -> null', () => {
    expect(sanitizeClientTs(now.getTime() + 10 * 60 * 1000, now)).toBeNull();
  });
  test('non-numeric -> null', () => {
    expect(sanitizeClientTs('yesterday', now)).toBeNull();
    expect(sanitizeClientTs(NaN, now)).toBeNull();
  });
});

describe('sanitizeClientMeta', () => {
  test('keeps only whitelisted keys for the event type', () => {
    expect(sanitizeClientMeta('submit_business_selected', { preselected: true, email: 'x@y.z' }))
      .toEqual({ preselected: true });
  });
  test('event types with no whitelist get null meta', () => {
    expect(sanitizeClientMeta('submit_page_viewed', { anything: 1 })).toBeNull();
  });
});

describe('ingestEvents', () => {
  const validEvent = { id: EV_ID, type: 'submit_page_viewed', ts: Date.now() };

  test('valid batch inserts with identity from req.user, answers 204', async () => {
    const { status } = await run({ sessionId: SESSION, events: [validEvent] }, { id: 42 });
    expect(status).toHaveBeenCalledWith(204);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const [events, ctx] = mockInsert.mock.calls[0];
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('submit_page_viewed');
    expect(ctx.userId).toBe(42);
    expect(ctx.sessionId).toBe(SESSION);
  });

  test('missing/invalid session -> 204, nothing inserted', async () => {
    const { status } = await run({ sessionId: 'not-a-uuid', events: [validEvent] });
    expect(status).toHaveBeenCalledWith(204);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('server-authoritative event types are rejected per-event (shadowban guard)', async () => {
    const { status } = await run({
      sessionId: SESSION,
      events: [
        { id: EV_ID, type: 'submission_accepted', ts: Date.now() },
        { id: EV_ID.replace('a1', 'b1'), type: 'account_created', ts: Date.now() },
      ],
    });
    expect(status).toHaveBeenCalledWith(204);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('batch is truncated to 25 events', async () => {
    const events = Array.from({ length: 40 }, (_, i) => ({
      id: EV_ID.replace('c3d4', `${String(i).padStart(4, '0')}`),
      type: 'submit_page_viewed',
      ts: Date.now(),
    }));
    await run({ sessionId: SESSION, events });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0].length).toBeLessThanOrEqual(25);
  });

  test('insert failure still answers 204 (analytics never surfaces errors)', async () => {
    mockInsert.mockRejectedValueOnce(new Error('db down'));
    const { status } = await run({ sessionId: SESSION, events: [validEvent] }, { id: 1 });
    expect(status).toHaveBeenCalledWith(204);
  });
});
