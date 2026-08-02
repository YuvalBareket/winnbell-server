// Single source of truth for the tobacco/liquor 21+ entry restriction (lawyer-mandated).
// The client mirrors AGE_RESTRICTED_SECTOR in client/src/shared/constants/entries.ts.

/** Business sector whose entries are restricted to participants aged 21+ (tobacco & liquor). */
export const AGE_RESTRICTED_SECTOR = 'Liquor';

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
