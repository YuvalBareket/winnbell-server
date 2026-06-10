/**
 * Validates that a string field does not exceed maxLen characters.
 * Returns a user-friendly error message, or null if valid.
 */
export const validateLength = (
  fieldLabel: string,
  value: unknown,
  maxLen: number,
): string | null => {
  if (typeof value !== 'string') return null; // skip non-strings (separate required checks handle missing)
  if (value.length > maxLen) {
    return `${fieldLabel} must be under ${maxLen} characters.`;
  }
  return null;
};

/**
 * Validates multiple fields at once. Returns the first error message found, or null if all pass.
 */
export const validateLengths = (
  checks: Array<[fieldLabel: string, value: unknown, maxLen: number]>,
): string | null => {
  for (const [label, value, max] of checks) {
    const err = validateLength(label, value, max);
    if (err) return err;
  }
  return null;
};
