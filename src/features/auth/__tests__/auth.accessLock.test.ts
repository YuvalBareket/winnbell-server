/**
 * Tests — pre-launch access lock middleware (auth.routes.ts)
 *
 * ACCESS_LOCKED=true closes the session-creating routes (/login, /register, /sync)
 * with 403 while the production client shows the AccessGate. Any other value
 * (unset, 'false', garbage) must leave the routes open — the lock fails OPEN so a
 * missing env var can never lock users out of a launched app.
 */

// Controllers pull in db/services; mock the module chain the routes file imports.
// Every handler referenced in auth.routes.ts must be a function or the Router throws.
jest.mock('../auth.controller.js', () => ({
  getRegionConfig: jest.fn(),
  checkRegion: jest.fn(),
  register: jest.fn(),
  checkEmail: jest.fn(),
  login: jest.fn(),
  syncUser: jest.fn(),
  refreshTokenController: jest.fn(),
  logoutController: jest.fn(),
  revokeAllSessions: jest.fn(),
  profileSetup: jest.fn(),
  updateName: jest.fn(),
  deleteAccount: jest.fn(),
}));
jest.mock('../test-setup.controller.js', () => ({ testSetup: jest.fn() }));
jest.mock('../../../shared/middleware/auth.middleware.js', () => ({ authenticateToken: jest.fn() }));

import { accessLock } from '../auth.routes';
import type { Request, Response, NextFunction } from 'express';

const makeRes = () => {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  } as unknown as Response;
  (res.status as jest.Mock).mockReturnValue(res);
  return res;
};

const ORIGINAL = process.env.ACCESS_LOCKED;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ACCESS_LOCKED;
  else process.env.ACCESS_LOCKED = ORIGINAL;
});

describe('accessLock', () => {
  it('returns 403 and does not call next() when ACCESS_LOCKED=true', () => {
    process.env.ACCESS_LOCKED = 'true';
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    accessLock({} as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Winnbell is not open yet.' });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['unset', undefined],
    ['false', 'false'],
    ['empty string', ''],
    ['garbage', 'TRUE '], // exact-match only: anything but the string "true" stays open
  ])('calls next() when ACCESS_LOCKED is %s', (_label, value) => {
    if (value === undefined) delete process.env.ACCESS_LOCKED;
    else process.env.ACCESS_LOCKED = value;
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    accessLock({} as Request, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
