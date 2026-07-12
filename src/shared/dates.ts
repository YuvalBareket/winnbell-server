// Campaign-calendar date helpers. Campaigns always end on the LAST DAY of a month at
// midnight America/New_York, so any code that needs "the next campaign's draw date"
// (draw creation in admin.service, the founding-to-regular transition window in
// stripe.service) must derive it from the exact same math or the two drift apart.

// Midnight America/New_York on the given UTC calendar day, as a UTC Date. Uses the actual
// NY offset for that date (EDT -4 in summer, EST -5 in winter) from the built-in Intl, so
// campaign boundaries are correct year-round instead of a hardcoded +4h offset (which was
// an hour early Nov-March under EST).
function nyMidnightUtc(year: number, monthIndex: number, day: number): Date {
  // Normalize first (monthIndex may be 12 = January next year, day may be 0 = last of prev month).
  const norm = new Date(Date.UTC(year, monthIndex, day));
  const y = norm.getUTCFullYear();
  const m = norm.getUTCMonth();
  const d = norm.getUTCDate();
  // Probe the NY offset at noon UTC on that day (well inside it; month boundaries are never DST switch days).
  const probe = new Date(Date.UTC(y, m, d, 12));
  const gmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const offsetHours = Math.abs(parseInt(gmt.replace('GMT', ''), 10)) || 5; // 4 (EDT) or 5 (EST)
  // Midnight NY on that day == offsetHours into UTC of the same calendar day.
  return new Date(Date.UTC(y, m, d, offsetHours, 0, 0));
}

// Convert a 1-indexed year/month to a UTC Date for midnight NY on the last day of that month.
export function lastDayOfMonthNyMidnightUtc(year: number, month: number): Date {
  // Day 0 of the NEXT 0-indexed month = the last day of the 1-indexed `month`.
  return nyMidnightUtc(year, month, 0);
}

// The moment the NEXT campaign opens: midnight NY on the 1st of next month. Campaigns are
// opened by the admin on the 1st; a founding member participates in EVERY campaign that
// opens before their prepaid year ends, so this boundary (not the next draw date) decides
// whether the next campaign is still covered by a founding membership.
export function nextCampaignOpensNy(now: Date = new Date()): Date {
  const nyDateStr = now.toLocaleDateString('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [month, , year] = nyDateStr.split('/').map(Number);
  // 1-based `month` used as a 0-based index = the following month; 12 normalizes to January.
  return nyMidnightUtc(year, month, 1);
}

// Parse a draw_date string and normalise it to midnight NY on the last day of its month.
// Encapsulates the 3-line parsing pattern duplicated across createDrawService and
// updateDrawService in admin.service.ts.
export function drawDateFromString(dateStr: string): Date {
  const nyDateStr = new Date(dateStr).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [month, , year] = nyDateStr.split('/').map(Number);
  return lastDayOfMonthNyMidnightUtc(year, month);
}

// ─── Charge day ────────────────────────────────────────────────────────────────
// Subscriptions bill on the 24th of every month (Stripe billing_cycle_anchor day 24, NY
// terms). Each charge pays for the NEXT month's campaign, leaving a buffer week between
// payment and campaign open for failed-card retries and a clean cancellation cutoff.
export const CHARGE_DAY_OF_MONTH = 24;

// The most recent charge moment at or before `now`: midnight NY on the 24th of this month
// if we've reached it, otherwise the 24th of the previous month.
export function lastChargeAtNy(now: Date = new Date()): Date {
  const nyDateStr = now.toLocaleDateString('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [month, day, year] = nyDateStr.split('/').map(Number);
  return day >= CHARGE_DAY_OF_MONTH
    ? nyMidnightUtc(year, month - 1, CHARGE_DAY_OF_MONTH)  // month is 1-based → index month-1 = this month
    : nyMidnightUtc(year, month - 2, CHARGE_DAY_OF_MONTH); // previous month (index may be -1 = last December)
}

// The next charge moment strictly after `now` (used e.g. to move an existing subscription
// onto the 24th anchor via a trial_end).
export function nextChargeAtNy(now: Date = new Date()): Date {
  const nyDateStr = now.toLocaleDateString('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [month, day, year] = nyDateStr.split('/').map(Number);
  return day >= CHARGE_DAY_OF_MONTH
    ? nyMidnightUtc(year, month, CHARGE_DAY_OF_MONTH)      // 24th of next month
    : nyMidnightUtc(year, month - 1, CHARGE_DAY_OF_MONTH); // 24th of this month
}
