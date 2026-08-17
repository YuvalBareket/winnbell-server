/**
 * Tests â€” entry-time region policy (ToS physical-presence-at-entry)
 *
 *   evaluateEntryRegionPolicy
 *     - Unrestricted platform (allowed_states empty) â†’ allowed, NO geo lookup at all
 *     - Non-US country â†’ blocked
 *     - US + allowed state â†’ allowed, state recorded, not out-of-region
 *     - US + non-allowed state â†’ allowed (soft), out-of-region flagged
 *     - US + unresolvable state â†’ allowed, fail open
 *     - Geo lookup failure â†’ allowed, fail open
 *     - Per-IP cache: repeat lookup for the same IP does not re-fetch
 *
 *   requireEntryRegion middleware
 *     - Blocked policy â†’ 403 { code: 'REGION_RESTRICTED' }, next NOT called
 *     - Allowed policy â†’ next called, res.locals.entryRegion populated
 *     - Policy throws â†’ fail open (next called, no locals)
 */

const mockPoolQuery = jest.fn();

jest.mock('../../../shared/db/db.js', () => ({
  getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }),
}));

// These tests exercise the ipinfo path (mocked global.fetch). Pin GeoLite to "not loaded"
// explicitly so no other test file that loads the local database can change which branch
// of getRegionFromIp runs here.
jest.mock('../../../shared/geo/geolite.js', () => ({
  lookupGeoLite: jest.fn().mockReturnValue(null),
}));

import { evaluateEntryRegionPolicy } from '../auth.service';
import { invalidatePlatformSettings, invalidateRegionIpCache } from '../../../shared/cache/cache.js';

/** Mock the ipinfo /json response used by getRegionFromIp. */
const mockIpinfo = (body: { country?: string; region?: string }) =>
  jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;

const setAllowedStates = (states: string[] | null) =>
  mockPoolQuery.mockResolvedValue({ rows: [{ allowed_states: states }] });

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  invalidatePlatformSettings();
  invalidateRegionIpCache();
});

afterEach(() => {
  global.fetch = originalFetch;
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// evaluateEntryRegionPolicy
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('evaluateEntryRegionPolicy', () => {
  it('PROD (NODE_ENV=production): hard-blocks non-US entries even with no states configured', async () => {
    // Tripwire for the 2026-08-17 contract: in production an empty allowed_states means
    // "every US state", never "no region policy".
    const prevEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    try {
      setAllowedStates([]);
      global.fetch = mockIpinfo({ country: 'IL' });

      const policy = await evaluateEntryRegionPolicy('203.0.113.50');
      expect(policy).toEqual({ blocked: true, state: null, outOfRegion: false });
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it('PROD (NODE_ENV=production): allows any US state with no out-of-region signal when no states configured', async () => {
    const prevEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    try {
      setAllowedStates([]);
      global.fetch = mockIpinfo({ country: 'US', region: 'Montana' });

      const policy = await evaluateEntryRegionPolicy('203.0.113.55');
      expect(policy).toEqual({ blocked: false, state: 'MT', outOfRegion: false });
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  it('DEV/STAGING (flag off): skips the geo lookup entirely when no states are configured', async () => {
    setAllowedStates([]);
    const fetchSpy = mockIpinfo({ country: 'IL' });
    global.fetch = fetchSpy;

    const policy = await evaluateEntryRegionPolicy('203.0.113.50');
    expect(policy).toEqual({ blocked: false, state: null, outOfRegion: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('hard-blocks a non-US country (outOfRegion stays false â€” it is a soft signal, never set alongside blocked)', async () => {
    setAllowedStates(['FL']);
    global.fetch = mockIpinfo({ country: 'IL', region: 'Tel Aviv' });

    const policy = await evaluateEntryRegionPolicy('203.0.113.51');
    expect(policy).toEqual({ blocked: true, state: null, outOfRegion: false });
  });

  it('allows a US user in an allowed state and records the state code', async () => {
    setAllowedStates(['FL']);
    global.fetch = mockIpinfo({ country: 'US', region: 'Florida' });

    const policy = await evaluateEntryRegionPolicy('203.0.113.52');
    expect(policy).toEqual({ blocked: false, state: 'FL', outOfRegion: false });
  });

  it('soft-flags (never blocks) a US user in a non-allowed state', async () => {
    setAllowedStates(['FL']);
    global.fetch = mockIpinfo({ country: 'US', region: 'Georgia' });

    const policy = await evaluateEntryRegionPolicy('203.0.113.53');
    expect(policy).toEqual({ blocked: false, state: 'GA', outOfRegion: true });
  });

  it('fails open when the US state cannot be resolved', async () => {
    setAllowedStates(['FL']);
    global.fetch = mockIpinfo({ country: 'US' }); // no region field

    const policy = await evaluateEntryRegionPolicy('203.0.113.54');
    expect(policy).toEqual({ blocked: false, state: null, outOfRegion: false });
  });

  it('fails open when the geo lookup errors', async () => {
    setAllowedStates(['FL']);
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const policy = await evaluateEntryRegionPolicy('203.0.113.55');
    expect(policy).toEqual({ blocked: false, state: null, outOfRegion: false });
  });

  it('caches the geo result per IP â€” the second call does not re-fetch', async () => {
    setAllowedStates(['FL']);
    const fetchSpy = mockIpinfo({ country: 'US', region: 'Florida' });
    global.fetch = fetchSpy;

    await evaluateEntryRegionPolicy('203.0.113.56');
    const second = await evaluateEntryRegionPolicy('203.0.113.56');

    expect(second).toEqual({ blocked: false, state: 'FL', outOfRegion: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache failed lookups â€” a transient error is retried on the next call', async () => {
    setAllowedStates(['FL']);
    global.fetch = jest.fn().mockRejectedValue(new Error('hiccup')) as unknown as typeof fetch;
    await evaluateEntryRegionPolicy('203.0.113.57');

    const fetchSpy = mockIpinfo({ country: 'US', region: 'Georgia' });
    global.fetch = fetchSpy;
    const policy = await evaluateEntryRegionPolicy('203.0.113.57');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(policy.outOfRegion).toBe(true);
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// requireEntryRegion middleware
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('requireEntryRegion middleware', () => {
  // Isolated mock of the policy so middleware behavior is tested independently
  // of the geo/caching stack above.
  const mockPolicy = jest.fn();
  let requireEntryRegion: typeof import('../region.middleware.js').requireEntryRegion;

  beforeAll(async () => {
    jest.resetModules();
    jest.doMock('../auth.service.js', () => ({
      evaluateEntryRegionPolicy: (...args: unknown[]) => mockPolicy(...args),
    }));
    ({ requireEntryRegion } = await import('../region.middleware.js'));
  });

  afterAll(() => {
    jest.dontMock('../auth.service.js');
  });

  const makeReqRes = () => {
    const req = { headers: { 'cf-connecting-ip': '198.51.100.7' }, ip: '198.51.100.7' };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      locals: {} as Record<string, unknown>,
    };
    const next = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { req: req as any, res: res as any, next };
  };

  it('responds 403 REGION_RESTRICTED when the policy blocks', async () => {
    // outOfRegion is always false alongside blocked (the real policy can never produce both).
    mockPolicy.mockResolvedValue({ blocked: true, state: null, outOfRegion: false });
    const { req, res, next } = makeReqRes();

    await requireEntryRegion(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REGION_RESTRICTED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through and stashes the region result when allowed', async () => {
    mockPolicy.mockResolvedValue({ blocked: false, state: 'GA', outOfRegion: true });
    const { req, res, next } = makeReqRes();

    await requireEntryRegion(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.locals.entryRegion).toEqual({ state: 'GA', outOfRegion: true });
  });

  it('fails open (next, no locals) when the policy itself throws', async () => {
    mockPolicy.mockRejectedValue(new Error('geo stack exploded'));
    const { req, res, next } = makeReqRes();

    await requireEntryRegion(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.locals.entryRegion).toBeUndefined();
  });
});
