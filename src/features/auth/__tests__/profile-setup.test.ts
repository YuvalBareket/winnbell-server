/**
 * Tests — step-2 profile setup (date_of_birth + gender)
 *
 * Covers:
 *   completeProfileSetup — happy path, invalid date format, under-18 rejection,
 *                          age boundary, invalid gender, user not found
 *   loginUser            — requiresProfileSetup flag: true for consumer without profile,
 *                          false once both fields are set, false for business owner
 *
 * Mock pattern mirrors auth.service.test.ts: pool.query for non-transactional paths.
 */

import bcrypt from 'bcryptjs';

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();

const mockClient = { query: mockClientQuery, release: mockRelease };

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({
    query: mockPoolQuery,
    connect: jest.fn().mockResolvedValue(mockClient),
  }),
}));

import { completeProfileSetup, loginUser } from '../auth.service';

process.env.JWT_SECRET = 'test-secret';

/** ISO date string N years ago (UTC), with an optional day offset. */
const yearsAgo = (years: number, dayOffset = 0): string => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().slice(0, 10);
};

const setupPoolQueries = (...responses: Array<{ rows: unknown[]; rowCount?: number | null }>) => {
  let i = 0;
  mockPoolQuery.mockImplementation(() => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return Promise.resolve(res);
  });
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// completeProfileSetup
// ─────────────────────────────────────────────────────────────────────────────
describe('completeProfileSetup', () => {
  test('saves a valid DOB + gender and returns them', async () => {
    const dob = yearsAgo(25);
    setupPoolQueries({ rows: [{ date_of_birth: dob, gender: 'Female' }], rowCount: 1 });

    const res = await completeProfileSetup(1, dob, 'Female');
    expect(res).toEqual({ dateOfBirth: dob, gender: 'Female' });
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql).toContain('UPDATE "user"');
    expect(params).toEqual([dob, 'Female', 1]);
  });

  test('rejects a malformed date without touching the DB', async () => {
    await expect(completeProfileSetup(1, '14/03/1996', 'Male')).rejects.toThrow(
      'Please enter a valid date of birth.',
    );
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('rejects impossible calendar dates that JS rolls over (Feb 29 non-leap, Apr 31)', async () => {
    await expect(completeProfileSetup(1, '2006-02-29', 'Male')).rejects.toThrow(
      'Please enter a valid date of birth.',
    );
    await expect(completeProfileSetup(1, '1990-04-31', 'Male')).rejects.toThrow(
      'Please enter a valid date of birth.',
    );
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('rejects under-18 users', async () => {
    await expect(completeProfileSetup(1, yearsAgo(17), 'Male')).rejects.toThrow(
      'You must be 18 or older to use Winnbell.',
    );
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('18th birthday today is accepted, tomorrow is not', async () => {
    setupPoolQueries({ rows: [{ date_of_birth: yearsAgo(18), gender: 'Male' }], rowCount: 1 });
    await expect(completeProfileSetup(1, yearsAgo(18), 'Male')).resolves.toBeDefined();

    // Born 18 years ago tomorrow: still 17 today
    await expect(completeProfileSetup(1, yearsAgo(18, 1), 'Male')).rejects.toThrow(
      'You must be 18 or older to use Winnbell.',
    );
  });

  test('rejects impossible ages (older than 120)', async () => {
    await expect(completeProfileSetup(1, '1890-01-01', 'Male')).rejects.toThrow(
      'Please enter a valid date of birth.',
    );
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('rejects a gender outside the allowed set', async () => {
    await expect(completeProfileSetup(1, yearsAgo(30), 'Other')).rejects.toThrow(
      'Please select a valid option.',
    );
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('throws "User not found" when no active row is updated', async () => {
    setupPoolQueries({ rows: [], rowCount: 0 });
    await expect(completeProfileSetup(999, yearsAgo(30), 'Female')).rejects.toThrow(
      'User not found',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requiresProfileSetup in the login payload
// ─────────────────────────────────────────────────────────────────────────────
describe('loginUser requiresProfileSetup', () => {
  const passwordHash = bcrypt.hashSync('password123', 4);

  const userRow = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    email: 'alice@test.com',
    password_hash: passwordHash,
    full_name: 'Alice',
    role: 'User',
    is_phone_verified: false,
    token_epoch: 0,
    date_of_birth: null,
    gender: null,
    ...overrides,
  });

  test('true for a consumer who has not completed the profile step', async () => {
    setupPoolQueries(
      { rows: [userRow()] },  // user lookup
      { rows: [] },           // location manager lookup
      { rows: [] },           // refresh token insert path
    );
    const res = await loginUser('alice@test.com', 'password123');
    expect(res.user.requiresProfileSetup).toBe(true);
  });

  test('false once both DOB and gender are set', async () => {
    setupPoolQueries(
      { rows: [userRow({ date_of_birth: '1996-03-14', gender: 'Female' })] },
      { rows: [] },
      { rows: [] },
    );
    const res = await loginUser('alice@test.com', 'password123');
    expect(res.user.requiresProfileSetup).toBe(false);
    expect(res.user.dateOfBirth).toBe('1996-03-14');
    expect(res.user.gender).toBe('Female');
  });

  test('true when only one of the two fields is set', async () => {
    setupPoolQueries(
      { rows: [userRow({ date_of_birth: '1996-03-14' })] },
      { rows: [] },
      { rows: [] },
    );
    const res = await loginUser('alice@test.com', 'password123');
    expect(res.user.requiresProfileSetup).toBe(true);
  });

  test('true for a location manager (Business role WITH location) without profile', async () => {
    setupPoolQueries(
      { rows: [userRow({ role: 'Business' })] },  // user lookup
      { rows: [{ id: 7 }] },                      // manager location lookup - manages location 7
      { rows: [] },                               // refresh token insert
    );
    const res = await loginUser('alice@test.com', 'password123');
    expect(res.user.location_id).toBe(7);
    expect(res.user.requiresProfileSetup).toBe(true);
    expect(res.user.requiresBusinessSetup).toBe(false);
  });

  test('false for a business owner (they get the business setup wizard instead)', async () => {
    setupPoolQueries(
      { rows: [userRow({ role: 'Business' })] },  // user lookup
      { rows: [] },                               // manager location lookup - none
      { rows: [] },                               // business lookup - none
      { rows: [] },                               // refresh token insert
    );
    const res = await loginUser('alice@test.com', 'password123');
    expect(res.user.requiresProfileSetup).toBe(false);
    expect(res.user.requiresBusinessSetup).toBe(true);
  });
});
