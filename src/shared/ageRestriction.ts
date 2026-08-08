// Single source of truth for the 21+ entry restriction. Applies to alcohol/tobacco
// venues: liquor/tobacco shops, pubs, and smoke/vape shops.
// The client mirrors AGE_RESTRICTED_SECTORS in client/src/shared/constants/entries.ts.

/** Business sectors whose entries are restricted to participants aged 21+.
 *  Liquor/Pub gating is lawyer-mandated. Vape added because federal Tobacco 21
 *  (Dec 2019) sets 21 as the minimum purchase age for ALL tobacco and vaping
 *  products nationwide - same gate as liquor. */
export const AGE_RESTRICTED_SECTORS = ['Liquor', 'Pub', 'Vape'] as const;

/** True when a business sector requires the 21+ gate. */
export const isAgeRestrictedSector = (sector: string | null | undefined): boolean =>
  !!sector && (AGE_RESTRICTED_SECTORS as readonly string[]).includes(sector);

/** Minimum age required to earn entries at an age-restricted business. */
export const AGE_RESTRICTED_MIN_AGE = 21;

/**
 * True when the date of birth makes the user at least AGE_RESTRICTED_MIN_AGE today.
 * A missing/invalid DOB returns false: callers run behind requireProfileComplete, so
 * absence means something is wrong and the age-restricted path must fail closed.
 * Compares calendar components, not timestamps: a date-only string parses as UTC midnight
 * while pg DATE columns hydrate as local midnight - timestamp math is off by hours at the
 * birthday boundary depending on server timezone.
 */
export const isAtLeast21 = (dateOfBirth: string | Date | null | undefined): boolean => {
  if (!dateOfBirth) return false;
  let y: number, m: number, d: number;
  const isoMatch = typeof dateOfBirth === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth) : null;
  if (isoMatch) {
    y = Number(isoMatch[1]); m = Number(isoMatch[2]); d = Number(isoMatch[3]);
  } else {
    const parsed = new Date(dateOfBirth);
    if (Number.isNaN(parsed.getTime())) return false;
    y = parsed.getFullYear(); m = parsed.getMonth() + 1; d = parsed.getDate();
  }
  const now = new Date();
  const beforeBirthdayThisYear = (now.getMonth() + 1) < m || ((now.getMonth() + 1) === m && now.getDate() < d);
  const age = now.getFullYear() - y - (beforeBirthdayThisYear ? 1 : 0);
  return age >= AGE_RESTRICTED_MIN_AGE;
};
