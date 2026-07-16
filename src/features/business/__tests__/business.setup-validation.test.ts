/**
 * Tests — business setup/update API validation (server-side wizard enforcement).
 *
 * The client wizard requires a name, a sector, and at least one full location, but the API
 * is the gate that counts: a direct caller must not be able to create a business with no
 * name/sector, an out-of-list sector (raw DB CHECK 500 before this), or an empty location.
 *
 * Covers: setupBusiness required fields + sector whitelist + per-location presence,
 *         updateBusiness sector whitelist, addLocation presence checks (no DB touched).
 */

import { Response } from 'express';

const mockCreateFull = jest.fn();
const mockUpdateProfile = jest.fn();

jest.mock('../business.service.js', () => ({
  createFullBusinessProfile: (...args: unknown[]) => mockCreateFull(...args),
  updateBusinessProfile: (...args: unknown[]) => mockUpdateProfile(...args),
}));
jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: jest.fn(), connect: jest.fn() }),
}));
jest.mock('../../../shared/s3.js', () => ({ getPresignedUploadUrl: jest.fn() }));
jest.mock('../../stripe/stripe.service.js', () => ({ syncSubscriptionQuantity: jest.fn() }));

import { setupBusiness, updateBusiness, addLocation } from '../business.controller';

const makeRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res as Response;
};

const makeReq = (body: Record<string, unknown>) =>
  ({ user: { id: 1, role: 'Business' }, body, params: {} }) as never;

const VALID_LOCATION = { name: 'Main', address: '1 Main St', lat: 25.7, lon: -80.1 };
const VALID_BODY = {
  businessName: 'Test Cafe',
  businessSector: 'Coffee',
  locations: [VALID_LOCATION],
};

const expect400 = (res: Response, message: string) => {
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ message });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateFull.mockResolvedValue({ businessId: 99 });
  mockUpdateProfile.mockResolvedValue(undefined);
});

describe('setupBusiness — required fields cannot be skipped', () => {
  test('rejects a missing business name', async () => {
    const res = makeRes();
    await setupBusiness(makeReq({ ...VALID_BODY, businessName: undefined }), res);
    expect400(res, 'Business name is required.');
    expect(mockCreateFull).not.toHaveBeenCalled();
  });

  test('rejects a whitespace-only business name', async () => {
    const res = makeRes();
    await setupBusiness(makeReq({ ...VALID_BODY, businessName: '   ' }), res);
    expect400(res, 'Business name is required.');
  });

  test('rejects a missing sector', async () => {
    const res = makeRes();
    await setupBusiness(makeReq({ ...VALID_BODY, businessSector: undefined }), res);
    expect400(res, 'Please select a valid business sector.');
    expect(mockCreateFull).not.toHaveBeenCalled();
  });

  test('rejects a sector outside the allowed list', async () => {
    const res = makeRes();
    await setupBusiness(makeReq({ ...VALID_BODY, businessSector: 'Hacking' }), res);
    expect400(res, 'Please select a valid business sector.');
  });

  test('rejects the admin-only Free sector for self-service setup', async () => {
    const res = makeRes();
    await setupBusiness(makeReq({ ...VALID_BODY, businessSector: 'Free' }), res);
    expect400(res, 'Please select a valid business sector.');
  });

  test('rejects an empty locations array', async () => {
    const res = makeRes();
    await setupBusiness(makeReq({ ...VALID_BODY, locations: [] }), res);
    expect400(res, 'At least one location is required.');
  });

  test('rejects a location without a name', async () => {
    const res = makeRes();
    await setupBusiness(makeReq({ ...VALID_BODY, locations: [{ ...VALID_LOCATION, name: '' }] }), res);
    expect400(res, 'Location name is required.');
    expect(mockCreateFull).not.toHaveBeenCalled();
  });

  test('rejects a location without an address', async () => {
    const res = makeRes();
    await setupBusiness(makeReq({ ...VALID_BODY, locations: [{ ...VALID_LOCATION, address: undefined }] }), res);
    expect400(res, 'Location address is required.');
  });

  test('rejects an empty location object (nothing sneaks past as a "location")', async () => {
    const res = makeRes();
    await setupBusiness(makeReq({ ...VALID_BODY, locations: [{}] }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockCreateFull).not.toHaveBeenCalled();
  });

  test('happy path: full valid payload reaches the service and returns 201', async () => {
    const res = makeRes();
    await setupBusiness(makeReq(VALID_BODY), res);
    expect(mockCreateFull).toHaveBeenCalledWith(1, VALID_BODY);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('updateBusiness — sector can change but never to garbage or empty', () => {
  test('rejects clearing the sector', async () => {
    const res = makeRes();
    await updateBusiness(makeReq({ businessName: 'Joe', businessSector: '', description: 'd', terms_text: 't' }), res);
    expect400(res, 'Please select a valid business sector.');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  test('rejects a sector outside the allowed list', async () => {
    const res = makeRes();
    await updateBusiness(makeReq({ businessName: 'Joe', businessSector: 'Casino', description: 'd', terms_text: 't' }), res);
    expect400(res, 'Please select a valid business sector.');
  });

  test('rejects clearing the business name', async () => {
    const res = makeRes();
    await updateBusiness(makeReq({ businessName: '  ', businessSector: 'Bakery', description: 'd', terms_text: 't' }), res);
    expect400(res, 'Business name is required.');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  test('accepts a valid sector + name change', async () => {
    const res = makeRes();
    await updateBusiness(makeReq({ businessName: 'Joe', businessSector: 'Bakery', description: 'd', terms_text: 't' }), res);
    expect(mockUpdateProfile).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
  });
});

describe('addLocation — presence checks run before any DB access', () => {
  test('rejects a location without a name', async () => {
    const res = makeRes();
    await addLocation(makeReq({ ...VALID_LOCATION, name: '  ' }), res);
    expect400(res, 'Location name is required.');
  });

  test('rejects a location without an address', async () => {
    const res = makeRes();
    await addLocation(makeReq({ ...VALID_LOCATION, address: undefined }), res);
    expect400(res, 'Location address is required.');
  });
});
