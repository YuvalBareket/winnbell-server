/**
 * Tests — sendSubscriptionConfirmationEmail (email.service.ts)
 *
 * Verifies:
 *   1. sendMail is NOT called when SMTP_HOST is not configured
 *   2. sendMail IS called when SMTP_HOST is set
 *   3. The email html body contains the business name
 *   4. Subject contains the business name; html contains entries per location
 *   5. The `to` field equals the email address passed in
 *
 * Mock strategy:
 *   nodemailer.createTransport() is mocked to return a fake transporter
 *   whose sendMail() we can spy on. The mock must be registered before the
 *   module is imported because nodemailer.createTransport() is called at
 *   module initialisation time (top-level code in email.service.ts).
 */

// ── Module-level mock (must precede import) ───────────────────────────────────

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-message-id' });

jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({ sendMail: mockSendMail }),
}));

import { sendSubscriptionConfirmationEmail } from '../email.service';
import { CHARGE_DAY_OF_MONTH } from '../../dates';

// ─────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────

const TEST_EMAIL = 'owner@coffeecorner.com';
const TEST_BUSINESS = 'Coffee Corner';
const TEST_PLAN = {
  planName: 'Growth',
  entriesPerLocation: 2500,
  monthlyFee: 900,
  locationCount: 2,
  chargedToday: false,
};

// ─────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  // Restore env to a clean state between tests
  delete process.env.SMTP_HOST;
});

// ─────────────────────────────────────────────
// sendSubscriptionConfirmationEmail
// ─────────────────────────────────────────────

describe('sendSubscriptionConfirmationEmail', () => {
  it('should NOT call sendMail when SMTP_HOST is not set', async () => {
    delete process.env.SMTP_HOST;

    await sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, TEST_PLAN);

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('should call sendMail exactly once when SMTP_HOST is configured', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';

    await sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, TEST_PLAN);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('should include the business name in the email html', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';

    await sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, TEST_PLAN);

    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.html).toContain(TEST_BUSINESS);
  });

  it('should include the business name in the email subject', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';

    await sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, TEST_PLAN);

    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.subject).toContain(TEST_BUSINESS);
  });

  it('should include entries per location in the email html', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';

    await sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, TEST_PLAN);

    const callArgs = mockSendMail.mock.calls[0][0];
    // The html contains the plan's entriesPerLocation value, locale-formatted ("2,500 entries per location")
    expect(callArgs.html).toContain(TEST_PLAN.entriesPerLocation.toLocaleString('en-US'));
  });

  it('should set the `to` field to the email address passed in', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';

    await sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, TEST_PLAN);

    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.to).toBe(TEST_EMAIL);
  });

  it('should resolve without error when SMTP_HOST is set and sendMail succeeds', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';

    await expect(
      sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, TEST_PLAN),
    ).resolves.toBeUndefined();
  });

  it('should propagate sendMail errors to the caller', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';
    mockSendMail.mockRejectedValueOnce(new Error('SMTP connection refused'));

    await expect(
      sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, TEST_PLAN),
    ).rejects.toThrow('SMTP connection refused');
  });

  it('should include the monthly fee amount in the email html', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';

    await sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, TEST_PLAN);

    const callArgs = mockSendMail.mock.calls[0][0];
    // The fee is rendered as e.g. "$900 / mo"
    expect(callArgs.html).toContain('$900');
  });

  it('should include the plan name in the email html', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';

    await sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, TEST_PLAN);

    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.html).toContain(TEST_PLAN.planName);
  });

  it('should say NO charge was made today when chargedToday is false (normal signup)', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';

    await sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, { ...TEST_PLAN, chargedToday: false });

    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.html).toContain('No charge was made today');
    expect(callArgs.html).toContain('not an invoice');
    // Derives from the configured charge day, WITH the ordinal suffix, so a bad ordinal
    // (e.g. "24st") would fail here too - not just a wrong day number.
    const ord = (n: number) => { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`; };
    expect(callArgs.html).toContain(`billed on the ${ord(CHARGE_DAY_OF_MONTH)}`);
  });

  it('should say the card WAS charged today when chargedToday is true (window signup)', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';

    await sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, { ...TEST_PLAN, chargedToday: true });

    const callArgs = mockSendMail.mock.calls[0][0];
    expect(callArgs.html).toContain('charged $900 today');
    expect(callArgs.html).not.toContain('No charge was made today');
  });

  it('should not call sendMail when SMTP_HOST is an empty string', async () => {
    process.env.SMTP_HOST = '';

    await sendSubscriptionConfirmationEmail(TEST_EMAIL, TEST_BUSINESS, TEST_PLAN);

    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
