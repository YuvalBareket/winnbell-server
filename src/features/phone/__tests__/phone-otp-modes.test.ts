/**
 * Tests — OTP environment gating (PHONE_VERIFY_ENABLED).
 *
 * Production (PHONE_VERIFY_ENABLED=true): Twilio VERIFY generates, texts, and checks the real code;
 * locally only the 'LIVE' sentinel is stored. Every other environment: NO SMS is ever
 * sent (the Twilio client is never even constructed) and the code is always 123456.
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

const mockVerificationsCreate = jest.fn();
const mockChecksCreate = jest.fn();
const mockTwilioFactory = jest.fn(() => ({
  verify: {
    v2: {
      services: jest.fn(() => ({
        verifications: { create: mockVerificationsCreate },
        verificationChecks: { create: mockChecksCreate },
      })),
    },
  },
}));
jest.mock('twilio', () => ({ __esModule: true, default: () => mockTwilioFactory() }));

import { sendPhoneOtp, verifyPhoneOtp } from '../phone.service';

const PHONE = '2025550123';

/** pool.query order in sendPhoneOtp: verified check, taken check, phone-hour, user-hour, spacing, delete-expired, insert (+ delete-on-send-failure in live mode). */
const setupSendQueries = () => {
  const responses = [
    { rows: [{ is_phone_verified: false }] },
    { rows: [] },
    { rows: [{ cnt: 0 }] },
    { rows: [{ cnt: 0 }] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
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

const OLD_ENV = { PHONE_VERIFY_ENABLED: process.env.PHONE_VERIFY_ENABLED, TWILIO_VERIFY_SERVICE_SID: process.env.TWILIO_VERIFY_SERVICE_SID };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PHONE_VERIFY_ENABLED;
  process.env.TWILIO_VERIFY_SERVICE_SID = 'VA_test_service';
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'token_test';
});

afterAll(() => {
  if (OLD_ENV.PHONE_VERIFY_ENABLED === undefined) delete process.env.PHONE_VERIFY_ENABLED;
  else process.env.PHONE_VERIFY_ENABLED = OLD_ENV.PHONE_VERIFY_ENABLED;
  if (OLD_ENV.TWILIO_VERIFY_SERVICE_SID === undefined) delete process.env.TWILIO_VERIFY_SERVICE_SID;
  else process.env.TWILIO_VERIFY_SERVICE_SID = OLD_ENV.TWILIO_VERIFY_SERVICE_SID;
});

describe('non-live environments (PHONE_VERIFY_ENABLED unset) - never send SMS, code is always 123456', () => {
  test('send stores the fixed dev code and never touches Twilio', async () => {
    setupSendQueries();
    await sendPhoneOtp(1, PHONE);
    expect(insertedCode()).toBe('123456');
    expect(mockTwilioFactory).not.toHaveBeenCalled();
    expect(mockVerificationsCreate).not.toHaveBeenCalled();
  });

  test('verify accepts 123456 locally without Twilio', async () => {
    setupVerifyQueries({ id: 9, phone_number: `+1${PHONE}`, attempts: 0, code: '123456', is_expired: false });
    await expect(verifyPhoneOtp(1, '123456')).resolves.toEqual({ referralBonusGranted: false });
    expect(mockChecksCreate).not.toHaveBeenCalled();
  });

  test('verify rejects a wrong code locally', async () => {
    setupVerifyQueries({ id: 9, phone_number: `+1${PHONE}`, attempts: 0, code: '123456', is_expired: false });
    await expect(verifyPhoneOtp(1, '999999')).rejects.toThrow('INVALID_CODE');
    expect(mockChecksCreate).not.toHaveBeenCalled();
  });
});

describe('production (PHONE_VERIFY_ENABLED=true) - Twilio Verify owns the real code', () => {
  beforeEach(() => {
    process.env.PHONE_VERIFY_ENABLED = 'true';
  });

  test('send stores the sentinel and asks Twilio Verify to text the code', async () => {
    setupSendQueries();
    mockVerificationsCreate.mockResolvedValueOnce({ status: 'pending' });
    await sendPhoneOtp(1, PHONE);
    expect(insertedCode()).toBe('LIVE');
    expect(mockVerificationsCreate).toHaveBeenCalledWith({ to: `+1${PHONE}`, channel: 'sms' });
  });

  test('a failed Twilio send removes the row and throws SMS_SEND_FAILED', async () => {
    setupSendQueries();
    mockVerificationsCreate.mockRejectedValueOnce(new Error('twilio down'));
    await expect(sendPhoneOtp(1, PHONE)).rejects.toThrow('SMS_SEND_FAILED');
    const cleanupDelete = mockPoolQuery.mock.calls.some(
      ([sql, params]: [string, unknown[]]) => /DELETE FROM phone_otp/i.test(sql) && Array.isArray(params) && params[1] === 'LIVE',
    );
    expect(cleanupDelete).toBe(true);
  });

  test('verify approves through Twilio Verify', async () => {
    setupVerifyQueries({ id: 9, phone_number: `+1${PHONE}`, attempts: 0, code: 'LIVE', is_expired: false });
    mockChecksCreate.mockResolvedValueOnce({ status: 'approved' });
    await expect(verifyPhoneOtp(1, '482913')).resolves.toEqual({ referralBonusGranted: false });
    expect(mockChecksCreate).toHaveBeenCalledWith({ to: `+1${PHONE}`, code: '482913' });
  });

  test('verify rejects when Twilio does not approve', async () => {
    setupVerifyQueries({ id: 9, phone_number: `+1${PHONE}`, attempts: 0, code: 'LIVE', is_expired: false });
    mockChecksCreate.mockResolvedValueOnce({ status: 'pending' });
    await expect(verifyPhoneOtp(1, '000000')).rejects.toThrow('INVALID_CODE');
  });

  test('verify rejects when the Twilio check call itself fails (dead verification)', async () => {
    setupVerifyQueries({ id: 9, phone_number: `+1${PHONE}`, attempts: 0, code: 'LIVE', is_expired: false });
    mockChecksCreate.mockRejectedValueOnce(new Error('404 not found'));
    await expect(verifyPhoneOtp(1, '482913')).rejects.toThrow('INVALID_CODE');
  });

  test('the dev code 123456 does NOT work in production (sentinel never matches, Twilio decides)', async () => {
    setupVerifyQueries({ id: 9, phone_number: `+1${PHONE}`, attempts: 0, code: 'LIVE', is_expired: false });
    mockChecksCreate.mockResolvedValueOnce({ status: 'pending' });
    await expect(verifyPhoneOtp(1, '123456')).rejects.toThrow('INVALID_CODE');
    // The decision went to Twilio, not a local string compare
    expect(mockChecksCreate).toHaveBeenCalledWith({ to: `+1${PHONE}`, code: '123456' });
  });
});
