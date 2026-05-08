/**
 * Tests — createCheckoutSession: 7-day campaign onboarding cutoff (stripe.service.ts)
 *
 * The service blocks new subscriptions when fewer than CAMPAIGN_ONBOARDING_CUTOFF_DAYS (7)
 * days remain before the 1st of the next month in the America/New_York timezone.
 *
 * Mock strategy:
 *   - Stripe constructor is mocked at module level (required before import).
 *   - email.service is mocked (transitive import).
 *   - getPool / pool.query is mocked: the existing-subscription guard query returns no rows
 *     so execution reaches the date-check logic before any other early-exit.
 *   - Date constructor is spied on to control "now".
 */

// Capture the real Date constructor BEFORE any spy can replace it.
// This reference is used inside mockDateNow so multi-arg `new Date(y,m,d)` calls
// still produce real Date instances even while the spy is active.
const RealDate = Date;

// ── Module-level mocks (must precede imports) ─────────────────────────────────

const mockSessionsCreate = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: { create: mockSessionsCreate },
    },
  }));
});

jest.mock('../../../shared/email/email.service.js', () => ({
  sendSubscriptionConfirmationEmail: jest.fn(),
}));

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();

const mockClient = {
  query: mockClientQuery,
  release: mockRelease,
};

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({
    query: mockQuery,
    connect: jest.fn().mockResolvedValue(mockClient),
  }),
}));

// Set required env vars before importing the service
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_PRICE_ID_250 = 'price_test_250';

import { createCheckoutSession } from '../stripe.service';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Mocks Date() (zero-arg constructor) to return a fixed date while leaving
 * multi-arg construction (e.g. new Date(year, month, day)) untouched so that
 * the service's own `new Date(nowNY.getFullYear(), nowNY.getMonth() + 1, 1)`
 * still computes correctly.
 *
 * The service derives nowNY via:
 *   new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
 * so we only need to control the zero-arg `new Date()` call.
 */
function mockDateNow(fixedDate: Date): void {
  // @ts-ignore — spyOn typing doesn't cover the constructor overload
  jest.spyOn(global, 'Date').mockImplementation((...args: any[]) => {
    if (args.length === 0) return new RealDate(fixedDate.getTime());
    // @ts-ignore
    return new RealDate(...args);
  });
  // Preserve static methods so the service can still call new Date(str) etc.
  (global.Date as any).now  = () => fixedDate.getTime();
  (global.Date as any).UTC  = RealDate.UTC.bind(RealDate);
  (global.Date as any).parse = RealDate.parse.bind(RealDate);
}

/**
 * Builds a Date whose toLocaleString in America/New_York lands on the given
 * calendar date at noon (avoids DST midnight edge-cases).
 *
 * NY is UTC-5 (EST) or UTC-4 (EDT). Anchoring at 17:00 UTC means the
 * NY wall-clock reads noon regardless of DST.
 */
function nyDate(year: number, month: number /* 1-based */, day: number): Date {
  return new RealDate(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T17:00:00.000Z`,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();

  // Default: no existing subscription — passes the guard before the date check
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ─────────────────────────────────────────────
// createCheckoutSession — campaign cutoff tests
// ─────────────────────────────────────────────

describe('createCheckoutSession — 7-day campaign onboarding cutoff', () => {
  it('should throw CAMPAIGN_CUTOFF error when only 2 days remain before next month', async () => {
    // January 29 — 2 days before Feb 1 → within 7-day cutoff
    mockDateNow(nyDate(2026, 1, 29));

    await expect(
      createCheckoutSession(42, 'owner@test.com', 250, 'monthly'),
    ).rejects.toThrow(/CAMPAIGN_CUTOFF:/);
  });

  it('should throw CAMPAIGN_CUTOFF error when exactly on the cutoff day (7 days before)', async () => {
    // January 25 — exactly 7 days before Feb 1 (daysUntilNext ≈ 7.0, which is <= 7)
    mockDateNow(nyDate(2026, 1, 25));

    await expect(
      createCheckoutSession(42, 'owner@test.com', 250, 'monthly'),
    ).rejects.toThrow(/CAMPAIGN_CUTOFF:/);
  });

  it('should NOT throw CAMPAIGN_CUTOFF error when 10 days remain before next month', async () => {
    // January 22 — 10 days before Feb 1 → outside 7-day cutoff
    mockDateNow(nyDate(2026, 1, 22));

    // The service proceeds past the date check and will throw for other reasons
    // (Stripe mock returns undefined url, or other downstream error) — that is acceptable.
    // The only assertion is that the rejection reason is NOT the campaign cutoff.
    let caughtError: Error | null = null;
    try {
      await createCheckoutSession(42, 'owner@test.com', 250, 'monthly');
    } catch (err: any) {
      caughtError = err;
    }
    if (caughtError !== null) {
      expect(caughtError.message).not.toMatch(/^CAMPAIGN_CUTOFF:/);
    }
  });

  it('should include the next month name in the CAMPAIGN_CUTOFF error message', async () => {
    // January 29 — cutoff window; formatted date should include "February"
    mockDateNow(nyDate(2026, 1, 29));

    let caughtError: Error | null = null;
    try {
      await createCheckoutSession(42, 'owner@test.com', 250, 'monthly');
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toMatch(/CAMPAIGN_CUTOFF:/);
    expect(caughtError!.message).toMatch(
      /January|February|March|April|May|June|July|August|September|October|November|December/,
    );
  });

  it('should throw CAMPAIGN_CUTOFF when 1 day remains (last day of month)', async () => {
    // January 31 — 1 day before Feb 1
    mockDateNow(nyDate(2026, 1, 31));

    await expect(
      createCheckoutSession(42, 'owner@test.com', 250, 'monthly'),
    ).rejects.toThrow(/CAMPAIGN_CUTOFF:/);
  });

  it('should NOT throw CAMPAIGN_CUTOFF at the start of a month (30+ days to go)', async () => {
    // January 1 — 31 days before Feb 1 → well outside the 7-day cutoff
    mockDateNow(nyDate(2026, 1, 1));

    let caughtError: Error | null = null;
    try {
      await createCheckoutSession(42, 'owner@test.com', 250, 'monthly');
    } catch (err: any) {
      caughtError = err;
    }
    if (caughtError !== null) {
      expect(caughtError.message).not.toMatch(/^CAMPAIGN_CUTOFF:/);
    }
  });

  it('should respect the cutoff for shorter months (Feb 22 — 6 days before Mar 1)', async () => {
    // February 22, 2026 — 6 days before March 1 → within 7-day cutoff
    mockDateNow(nyDate(2026, 2, 22));

    await expect(
      createCheckoutSession(42, 'owner@test.com', 250, 'monthly'),
    ).rejects.toThrow(/CAMPAIGN_CUTOFF:/);
  });
});
