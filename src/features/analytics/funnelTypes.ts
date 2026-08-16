// Single source of truth for funnel event vocabulary. Mirrors the CHECK constraints
// in schema.sql (funnel_event) - keep the three lists in sync with the DB.

/** Events the CLIENT is allowed to send via POST /events. */
export const CLIENT_EVENT_TYPES = [
  'scan_landing_viewed',
  'join_landing_viewed',
  'registration_page_viewed',
  'registration_started',
  'registration_email_entered',
  'terms_accepted',
  'registration_submitted',
  'registration_failed',
  'email_verification_pending',
  'profile_setup_viewed',
  'submit_page_viewed',
  'submit_business_selected',
  'submit_amount_entered',
  'submit_receipt_id_entered',
  'receipt_scan_used',
  'submit_image_attached',
  'submit_attempted',
  'submission_confirmed_shown',
] as const;

/** Server-authoritative events. The ingest endpoint REJECTS these from clients -
 *  they are only ever emitted by server code (shadowban invariant depends on this). */
export const SERVER_EVENT_TYPES = [
  'account_created',
  'first_login',
  'returning_login',
  'profile_setup_completed',
  'profile_setup_failed',
  'otp_requested',
  'otp_send_failed',
  'otp_delivered',
  'otp_undelivered',
  'otp_verify_attempted',
  'otp_verified',
  'otp_verify_failed',
  'submission_accepted',
  'submission_rejected',
  'submission_ocr_cleared',
  'submission_ocr_rejected',
] as const;

export const REASON_CODES = [
  // submission
  'below_threshold', 'receipt_too_old', 'date_outside_campaign', 'duplicate_receipt',
  'receipt_contested', 'image_required', 'daily_limit_high_risk', 'sequential_pattern',
  'location_cap_reached', 'user_draw_cap_reached', 'weekly_limit_reached', 'email_unverified',
  'phone_unverified', 'no_active_campaign', 'invalid_code', 'out_of_region',
  'technical_error', 'unknown_error',
  // registration (client-reported)
  'email_taken', 'weak_password', 'provider_error',
  // profile setup
  'under_18', 'invalid_state', 'invalid_input',
  // otp
  'wrong_code', 'expired', 'too_many_attempts', 'send_error',
] as const;

/** Reason codes the client may attach (registration_failed only). */
export const CLIENT_REASON_CODES = ['email_taken', 'weak_password', 'provider_error'] as const;

export const DEVICE_CLASSES = ['ios_pwa', 'ios_safari', 'android_pwa', 'android_chrome', 'desktop', 'other'] as const;

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];
export type FunnelEventType = ClientEventType | ServerEventType;
export type ReasonCode = (typeof REASON_CODES)[number];
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

/** meta keys allowed on client events, per type. Anything else is dropped (PII guard). */
export const CLIENT_META_WHITELIST: Partial<Record<ClientEventType, readonly string[]>> = {
  submit_business_selected: ['preselected'],
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
