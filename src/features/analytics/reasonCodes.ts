import type { ReasonCode } from './funnelTypes.js';

// Maps the error messages thrown by tickets.service (and friends) to the structured
// reason_code taxonomy. Services deliberately keep throwing plain strings (refactoring
// every throw site to coded errors was rejected as too invasive) - this boundary layer
// is the single place that knows both vocabularies.
//
// ORDER MATTERS: first match wins; patterns are tested with String.includes on the
// lowercased message. The completeness jest test pins every known throw site to a
// non-unknown code - add new mappings there when services grow new errors.
const MESSAGE_PATTERNS: ReadonlyArray<readonly [pattern: string, code: ReasonCode]> = [
  ['receipt_contest_image_required', 'receipt_contested'],
  ['already being reviewed', 'receipt_contested'],
  ['already been entered', 'duplicate_receipt'],
  ['weekly limit', 'weekly_limit_reached'],
  ['verify your email', 'email_unverified'],
  ['phone_not_verified', 'phone_unverified'],
  ['no active campaign', 'no_active_campaign'],
  ['older than 7 days', 'receipt_too_old'],
  ['within campaign', 'date_outside_campaign'],
  ['or more', 'below_threshold'],           // "requires a purchase of $X or more"
  ['daily entry limit', 'daily_limit_high_risk'],
  ['image is required', 'image_required'],
  ['sequential pattern', 'sequential_pattern'],
  ['run out of entries', 'location_cap_reached'],
  ['maximum', 'user_draw_cap_reached'],     // "reached the maximum ... entries"
  ['invalid code', 'invalid_code'],
  ['not available in your', 'out_of_region'],
] as const;

export function mapErrorToReasonCode(message: string | undefined | null): ReasonCode {
  if (!message) return 'unknown_error';
  const m = message.toLowerCase();
  for (const [pattern, code] of MESSAGE_PATTERNS) {
    if (m.includes(pattern)) return code;
  }
  return 'unknown_error';
}
