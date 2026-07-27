// ─── Staging-only demo user ───────────────────────────────────────────────────
// A single account used to show potential businesses the flow in STAGING without
// hitting the anti-fraud limits. It is double-gated so it can NEVER affect production:
//   1) the DEMO_USER_ENABLED env var must be 'true' (set ONLY on the staging service), and
//   2) the email must match this exact demo alias.
// Every consumer applies it as `if (!isDemoUser(email)) <normal limit>`, so when the flag is
// off (production, dev) the behaviour is byte-for-byte identical to today for every user.
export const DEMO_USER_EMAIL = 'idobareker41+400@gmail.com';

export const isDemoUser = (email?: string | null): boolean =>
  process.env.DEMO_USER_ENABLED === 'true'
  && !!email
  && email.trim().toLowerCase() === DEMO_USER_EMAIL;
