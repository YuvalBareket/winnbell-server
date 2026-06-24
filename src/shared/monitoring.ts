// ─── Error monitoring (Sentry when configured, no-op otherwise) ───────────────
// Captures unhandled exceptions, server errors, and crashes so you SEE problems
// in real time instead of hearing about them from users. Inert until SENTRY_DSN is
// set, so it's zero-risk: add the DSN env var (from a free Sentry project) to turn
// it on, nothing to change in code.
import * as Sentry from '@sentry/node';

let enabled = false;

export function initMonitoring(): void {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    // Errors only — no performance tracing overhead. Raise later if you want traces.
    tracesSampleRate: 0,
  });
  enabled = true;
  console.log('[monitoring] Sentry error tracking enabled');
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}
