/**
 * Tests — OTP environment gating (PHONE_VERIFY_ENABLED).
 *
 * Production (PHONE_VERIFY_ENABLED=true): WE generate a random 6-digit code, store it,
 * and text it via Programmable Messaging from TWILIO_FROM_NUMBER (approved A2P campaign).
 * Every other environment: NO SMS is ever sent (the Twilio client is never even
 * constructed) and the code is always 123456. The compare is local in both modes.
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
jest.mock('../../referral/referral.service.js', () => ({ grantPendingReferralBonus: jest.fn().mockResolvedValue(false) }));

const mockMessagesCreate = jest.fn();
const mockTwilioFactory = jest.fn(() => ({
  messages: { create: mockMessagesCreate },
}));
jest.mock('twilio', () => ({ __esModule: true, default: () => mockTwilioFactory() }));

import { sendPhoneOtp, verifyPhoneOtp } from '../phone.service';

const PHONE = '2025550123';
const FROM = '+15550001111';

/** pool.query order in sendPhoneOtp: verified check, taken check, phone-hour, user-hour,
    spacing, delete-expired, insert RETURNING id (+ delete-by-id on send failure in live mode). */
const setupSendQueries = () => {
  const responses = [
    { rows: [{ is_phone_verified: false }] },
    { rows: [] },
    { rows: [{ cnt: 0 }] },
    { rows: [{ cnt: 0 }] },
    { rows: [] },
    { rows: [] },
    { rows: [{ id: 55 }] }, // INSERT ... RETURNING id
    { rows: [] },
  ];
  let i = 0;
  mockPoolQuery.mockImplementation(() => Promise.resolve(responses[i++] ?? { rows: [] }));
};

/** client.query order in verifyPhoneOtp: BEGIN, SELECT otp, UPDATE attempts, [SELECT conflict, UPDATE user, DELETE otp], COMMIT. */
const setupVerifyQueries = (otpRow: Record<string, unknown>) => {
  mockClientQuery.mockImplementation((sql: string) => {
    if (/SELECT id, phone_number/i.test(sql)) return Promise.resolve({ rows: [otpRow] });
    if (/SELECT id FROM "user" WHERE phone_number/i.test(sql)) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
};

const insertedCode = (): string | undefined => {
  const call = mockPoolQuery.mock.calls.find(([sql]: [string]) => /INSERT INTO phone_otp/i.test(sql));
  return call?.[1]?.[2];
};

const OLD_ENV = { PHONE_VERIFY_ENABLED: process.env.PHONE_VERIFY_ENABLED, TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PHONE_VERIFY_ENABLED;
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'token_test';
  process.env.TWILIO_FROM_NUMBER = FROM;
});

afterAll(() => {
  if (OLD_ENV.PHONE_VERIFY_ENABLED === undefined) delete process.env.PHONE_VERIFY_ENABLED;
  else process.env.PHONE_VERIFY_ENABLED = OLD_ENV.PHONE_VERIFY_ENABLED;
  if (OLD_ENV.TWILIO_FROM_NUMBER === undefined) delete process.env.TWILIO_FROM_NUMBER;
  else process.env.TWILIO_FROM_NUMBER = OLD_ENV.TWILIO_FROM_NUMBER;
});

describe('non-live environments (PHONE_VERIFY_ENABLED unset) - never send SMS, code is always 123456', () => {
  test('send stores the fixed dev code and never touches Twilio', async () => {
    setupSendQueries();
    await sendPhoneOtp(1, PHONE);
    expect(insertedCode()).toBe('123456');
    expect(mockTwilioFactory).not.toHaveBeenCalled();
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  test('verify accepts 123456 locally without Twilio', async () => {
    setupVerifyQueries({ id: 9, phone_number: `+1${PHONE}`, attempts: 0, code: '123456', is_expired: false });
    await expect(verifyPhoneOtp(1, '123456')).resolves.toEqual({ referralBonusGranted: false });
    expect(mockTwilioFactory).not.toHaveBeenCalled();
  });

  test('verify rejects a wrong code locally', async () => {
    setupVerifyQueries({ id: 9, phone_number: `+1${PHONE}`, attempts: 0, code: '123456', is_expired: false });
    await expect(verifyPhoneOtp(1, '999999')).rejects.toThrow('INVALID_CODE');
    expect(mockTwilioFactory).not.toHaveBeenCalled();
  });
});

describe('production (PHONE_VERIFY_ENABLED=true) - random code texted from our own number', () => {
  beforeEach(() => {
    process.env.PHONE_VERIFY_ENABLED = 'true';
  });

  test('send stores a random 6-digit code and texts it via Programmable Messaging', async () => {
    setupSendQueries();
    mockMessagesCreate.mockResolvedValueOnce({ sid: 'SM_test' });
    await sendPhoneOtp(1, PHONE);
    const code = insertedCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(mockMessagesCreate).toHaveBeenCalledWith({
      to: `+1${PHONE}`,
      from: FROM,
      body: expect.stringContaining(code!),
    });
  });

  test('a failed Twilio send removes the row by id and throws SMS_SEND_FAILED', async () => {
    setupSendQueries();
    mockMessagesCreate.mockRejectedValueOnce(new Error('twilio down'));
    await expect(sendPhoneOtp(1, PHONE)).rejects.toThrow('SMS_SEND_FAILED');
    const cleanupDelete = mockPoolQuery.mock.calls.some(
      ([sql, params]: [string, unknown[]]) => /DELETE FROM phone_otp WHERE id/i.test(sql) && Array.isArray(params) && params[0] === 55,
    );
    expect(cleanupDelete).toBe(true);
  });

  test('verify compares against the stored random code locally', async () => {
    setupVerifyQueries({ id: 9, phone_number: `+1${PHONE}`, attempts: 0, code: '482913', is_expired: false });
    await expect(verifyPhoneOtp(1, '482913')).resolves.toEqual({ referralBonusGranted: false });
    expect(mockTwilioFactory).not.toHaveBeenCalled(); // check needs no Twilio round-trip
  });

  test('verify rejects a wrong code', async () => {
    setupVerifyQueries({ id: 9, phone_number: `+1${PHONE}`, attempts: 0, code: '482913', is_expired: false });
    await expect(verifyPhoneOtp(1, '000000')).rejects.toThrow('INVALID_CODE');
  });

  test('the dev code 123456 does NOT work in production (live codes are random)', async () => {
    setupVerifyQueries({ id: 9, phone_number: `+1${PHONE}`, attempts: 0, code: '482913', is_expired: false });
    await expect(verifyPhoneOtp(1, '123456')).rejects.toThrow('INVALID_CODE');
  });
});
