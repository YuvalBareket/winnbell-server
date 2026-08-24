/**
 * Tests — Official Rules legal snapshot (shared/legal/officialRulesSnapshot.ts)
 *
 * The PDF archived at draw close must carry the exact substituted rules text:
 *   - jurisdictions formatting mirrors the client (/rules page) for every list shape
 *   - draw substitutions fill every placeholder (none may leak into a legal archive)
 *   - the renderer produces a real PDF document
 */
import {
  formatJurisdictions,
  buildOfficialRulesText,
  renderOfficialRulesPdf,
  rulesArchiveNames,
} from '../officialRulesSnapshot';

const DRAW = {
  id: 20,
  name: 'August 2026',
  prize_amount: '250.00',
  start_date: '2026-08-01T04:00:00.000Z',
  draw_date: '2026-08-31T04:00:00.000Z',
};

describe('formatJurisdictions', () => {
  it('empty list = gate unrestricted = USA-wide wording (mirrors the client)', () => {
    expect(formatJurisdictions([])).toBe('United States (excluding where prohibited by applicable law)');
  });

  it('single state', () => {
    expect(formatJurisdictions(['FL'])).toBe('State of Florida, United States only');
  });

  it('two states, alphabetical', () => {
    expect(formatJurisdictions(['GA', 'FL'])).toBe('States of Florida and Georgia, United States only');
  });

  it('three states with Oxford comma', () => {
    expect(formatJurisdictions(['TX', 'FL', 'GA'])).toBe('States of Florida, Georgia, and Texas, United States only');
  });

  it('near-complete allowlist renders exclusion wording (state ban, e.g. Rhode Island)', () => {
    const ALL_50 = [
      'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
      'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
      'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
      'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
      'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
    ];
    const allButRI = ALL_50.filter((c) => c !== 'RI');
    expect(formatJurisdictions(allButRI)).toBe(
      'United States, excluding the State of Rhode Island (and excluding where prohibited by applicable law)',
    );
    // Two banned states pluralize and list alphabetically.
    const allButRIandNY = ALL_50.filter((c) => c !== 'RI' && c !== 'NY');
    expect(formatJurisdictions(allButRIandNY)).toBe(
      'United States, excluding the States of New York and Rhode Island (and excluding where prohibited by applicable law)',
    );
    // DC in the display map must NOT count as excluded (it is not a pickable state).
    expect(formatJurisdictions(ALL_50)).not.toContain('District of Columbia');
    // Threshold boundary: 5 excluded still uses exclusion wording; 6 falls back to
    // enumerating the (44) eligible states.
    const fiveBanned = ALL_50.slice(5);
    expect(formatJurisdictions(fiveBanned)).toMatch(/^United States, excluding the States of /);
    const sixBanned = ALL_50.slice(6);
    expect(formatJurisdictions(sixBanned)).toMatch(/^States of .*, United States only$/);
  });
});

describe('buildOfficialRulesText', () => {
  const text = buildOfficialRulesText(DRAW, ['FL']);

  it('fills the campaign-specific terms', () => {
    expect(text).toContain('Campaign Name: August 2026');
    expect(text).toContain('Draw Date: August 31, 2026');
    expect(text).toContain('August 1, 2026 at 12:00 AM Eastern Time (ET)');
    expect(text).toContain('Cash prize of $250.00');
    expect(text).toContain('Eligible Jurisdiction(s): State of Florida, United States only');
  });

  it('leaves NO unsubstituted placeholder anywhere (legal archive must be complete)', () => {
    expect(text).not.toMatch(/\[Campaign Name\]|\[Start Date & Time\]|\[End Date & Time\]|\[Draw Date\]/);
    expect(text).not.toMatch(/\[Prize Description\]|\[Prize Value\]|\[Entry Cap\]|\[Time Zone\]/);
    expect(text).not.toMatch(/\[List of Eligible Jurisdictions\]|\[If Applicable\]|<insert/);
  });

  it('hidden prize and missing start_date use the same fallbacks as the /rules page', () => {
    const t = buildOfficialRulesText({ ...DRAW, prize_amount: null, start_date: null }, []);
    expect(t).toContain('Cash prize of To be announced');
    expect(t).toContain('See Platform at 12:00 AM');
    expect(t).toContain('United States (excluding where prohibited by applicable law)');
  });
});

describe('rulesArchiveNames', () => {
  it('names files by campaign month-year (NY month of draw_date) for chronological sorting', () => {
    const { key, filename } = rulesArchiveNames(DRAW);
    expect(key).toBe('legal-snapshots/official-rules/2026-08-august-2026.pdf');
    expect(filename).toBe('winnbell-official-rules-2026-08-august-2026.pdf');
  });

  it('draw_date near month boundary uses the NY month, not UTC', () => {
    // 2026-09-01T03:00Z is still Aug 31 in New York.
    const { key } = rulesArchiveNames({ name: 'August 2026', draw_date: '2026-09-01T03:00:00.000Z' });
    expect(key).toContain('/2026-08-');
  });
});

describe('renderOfficialRulesPdf', () => {
  it('produces a real PDF document from the full rules text', async () => {
    const pdf = await renderOfficialRulesPdf(buildOfficialRulesText(DRAW, ['FL']), 'Archived for test.');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // The full rules are ~32KB of text; a truncated render would be far smaller.
    expect(pdf.length).toBeGreaterThan(20_000);
  });
});
