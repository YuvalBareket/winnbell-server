/**
 * Tests — geolite.ts (local GeoLite2 database module)
 *
 * Covers the pure mapping from GeoLite2 City records to the app's region shape, and the
 * not-loaded fallback contract (lookupGeoLite must return null so getRegionFromIp falls
 * through to ipinfo). Download/refresh lifecycle is exercised by the live verification
 * script, not unit tests — no network here.
 */

import { mapCityResponse, lookupGeoLite, __resetGeoLiteForTests } from '../geolite';
import type { CityResponse } from 'maxmind';

const usRecord = (overrides: Partial<CityResponse> = {}): CityResponse => ({
  country: { iso_code: 'US', geoname_id: 1, names: { en: 'United States' } },
  subdivisions: [{ iso_code: 'FL', geoname_id: 2, names: { en: 'Florida' } }],
  city: { geoname_id: 3, names: { en: 'Miami' } },
  location: { latitude: 25.77, longitude: -80.19, accuracy_radius: 20, time_zone: 'America/New_York' },
  ...overrides,
} as CityResponse);

describe('mapCityResponse', () => {
  it('maps a full US record to country/state/city/coords', () => {
    expect(mapCityResponse(usRecord())).toEqual({
      country: 'US',
      stateCode: 'FL',
      city: 'Miami',
      approxLocation: { latitude: 25.77, longitude: -80.19 },
    });
  });

  it('returns null when the record has no country (unknown IP)', () => {
    expect(mapCityResponse(null)).toBeNull();
    expect(mapCityResponse({} as CityResponse)).toBeNull();
  });

  it('never reports a state for non-US countries (subdivision codes are not USPS codes there)', () => {
    const ca = usRecord({
      country: { iso_code: 'CA', geoname_id: 1, names: { en: 'Canada' } },
      subdivisions: [{ iso_code: 'ON', geoname_id: 2, names: { en: 'Ontario' } }],
    } as Partial<CityResponse>);
    const mapped = mapCityResponse(ca);
    expect(mapped?.country).toBe('CA');
    expect(mapped?.stateCode).toBeNull();
  });

  it('drops malformed subdivision codes (numeric/long ISO forms fail the USPS shape)', () => {
    const weird = usRecord({ subdivisions: [{ iso_code: '12A', geoname_id: 2, names: { en: 'X' } }] } as Partial<CityResponse>);
    expect(mapCityResponse(weird)?.stateCode).toBeNull();
  });

  it('handles a country-only record (anycast IPs often have no city/state/location)', () => {
    const bare = { country: { iso_code: 'US', geoname_id: 1, names: { en: 'United States' } } } as CityResponse;
    expect(mapCityResponse(bare)).toEqual({ country: 'US', stateCode: null, city: null, approxLocation: null });
  });

  it('rejects out-of-range coordinates', () => {
    const bad = usRecord({ location: { latitude: 999, longitude: -80, accuracy_radius: 20, time_zone: 'X' } } as Partial<CityResponse>);
    expect(mapCityResponse(bad)?.approxLocation).toBeNull();
  });
});

describe('lookupGeoLite — fallback contract', () => {
  it('returns null when the database is not loaded (getRegionFromIp then falls back to ipinfo)', () => {
    __resetGeoLiteForTests();
    expect(lookupGeoLite('8.8.8.8')).toBeNull();
  });
});
