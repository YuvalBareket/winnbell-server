/**
 * Tests — OTP send spacing (SMS abuse protection).
 *
 * The client's 60s resend cooldown is component state and resets when the verify sheet is
 * closed and reopened. The server-side minimum interval is the real gate: a second send
 * within 60s of the last one must throw RESEND_TOO_SOON, no matter how the client behaves.
 * The existing 3-per-hour caps (per phone AND per user) are asserted too.
 */

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClient = { query: mockClientQuery, release: jest.fn() };

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({
    query: mockPoolQuery,
    connect: jest.fn().mockResolvedValue(mockClient),
  }),
}));
jest.mock('../../../shared/cache/cache.js', () => ({ invalidateUserAuth: jest.fn() }));
jest.mock('../../referral/referral.service.js', () => ({ grantPendingReferralBonus: jest.fn() }));
jest.mock('twilio', () => jest.fn(() => ({ messages: { create: jest.fn() } })));

import { sendPhoneOtp } from '../phone.service';

const PHONE = '2025550123';

/**
 * Query order in sendPhoneOtp:
 *  1. user is_phone_verified check
 *  2. phone taken by another user
 *  3. per-phone hourly count
 *  4. per-user hourly count
 *  5. recent-send spacing check
 *  6. delete expired rows
 *  7. insert new OTP
 */
const setupQueries = (opts: { phoneHourCount?: number; userHourCount?: number; hasRecentSend?: boolean }) => {
  const responses = [
    { rows: [{ is_phone_verified: false }] },
    { rows: [] },
    { rows: [{ cnt: opts.phoneHourCount ?? 0 }] },
    { rows: [{ cnt: opts.userHourCount ?? 0 }] },
    { rows: opts.hasRecentSend ? [{ '?column?': 1 }] : [] },
    { rows: [] },
    { rows: [] },
  ];
  let i = 0;
  mockPoolQuery.mockImplementation(() => Promise.resolve(responses[i++] ?? { rows: [] }));
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('sendPhoneOtp — send spacing and hourly caps', () => {
  test('throws RESEND_TOO_SOON when a code was sent less than a minute ago', async () => {
    setupQueries({ hasRecentSend: true });
    await expect(sendPhoneOtp(1, PHONE)).rejects.toThrow('RESEND_TOO_SOON');
    // Nothing inserted: the still-valid code is reused instead of a new SMS
    const inserted = mockPoolQuery.mock.calls.some(([sql]: [string]) => /INSERT INTO phone_otp/i.test(sql));
    expect(inserted).toBe(false);
  });

  test('sends normally when the last code is older than the spacing window', async () => {
    setupQueries({ hasRecentSend: false });
    await expect(sendPhoneOtp(1, PHONE)).resolves.toBeUndefined();
    const inserted = mockPoolQuery.mock.calls.some(([sql]: [string]) => /INSERT INTO phone_otp/i.test(sql));
    expect(inserted).toBe(true);
  });

  test('per-phone hourly cap still throws TOO_MANY_SENDS', async () => {
    setupQueries({ phoneHourCount: 3 });
    await expect(sendPhoneOtp(1, PHONE)).rejects.toThrow('TOO_MANY_SENDS');
  });

  test('per-user hourly cap still throws TOO_MANY_SENDS', async () => {
    setupQueries({ userHourCount: 3 });
    await expect(sendPhoneOtp(1, PHONE)).rejects.toThrow('TOO_MANY_SENDS');
  });
});
