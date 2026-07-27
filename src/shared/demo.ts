// ─── Staging-only demo reset ──────────────────────────────────────────────────
// Staging-wide gate for the self-service "Reset demo data" control: ANY account on staging
// may wipe and reseed its OWN activity (mirrors the client, which shows the button whenever
// VITE_APP_ENV !== 'production'). Single-gated by DEMO_USER_ENABLED, which is only ever set on
// the staging service, so this is byte-for-byte inert in production and dev. Remove together
// with the rest of the demo scaffolding after the demo.
export const isDemoResetEnabled = (): boolean =>
  process.env.DEMO_USER_ENABLED === 'true';
