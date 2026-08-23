import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import authRoutes from './features/auth/auth.routes.js';
import adminRoutes from './features/admin/admin.routes.js';
import ticketsRoutes from './features/tickets/tickets.routes.js';
import businessRoutes from './features/business/business.routes.js';
import drawsRoutes from './features/draws/draws.routes.js';
import * as drawsController from './features/draws/draws.controller.js';
import stripeWebhookRoutes from './features/stripe/stripe.routes.js';
import notificationRoutes from './features/notifications/notifications.routes.js';
import phoneRouter from './features/phone/phone.routes.js';
import { twilioStatusWebhook } from './features/phone/phone.controller.js';
import referralRoutes from './features/referral/referral.routes.js';
import contactRoutes from './features/contact/contact.routes.js';
import analyticsRoutes from './features/analytics/analytics.routes.js';
import { resolveReferral } from './features/referral/referral.controller.js';
import { Router } from 'express';
import {
  getNearby,
  getLocationProfileById,
  getParticipatingLocationById,
  searchParticipatingLocations,
  getAddressController,
  getAddressCoordsController,
} from './features/business/business.controller.js';
import { getFoundingAvailability } from './features/stripe/stripe.controller.js';

import { authenticateToken, optionalAuth } from './shared/middleware/auth.middleware.js';
import { getClientIpKey } from './shared/clientIp.js';
import { makeRateLimitStore } from './shared/rateLimitStore.js';
import { captureError } from './shared/monitoring.js';

const app = express();

// Trust reverse proxy (nginx/Render) so req.ip reflects the real client IP
app.set('trust proxy', 1);

// Security headers (helmet first)
app.use(helmet());

const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:8081').split(',');
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(null, false);
    },
    credentials: true,
  }),
);

// Rate limiters
// Outside production (local dev; Render prod AND staging both set NODE_ENV=production) every
// cap is multiplied so E2E runs, seed scripts, and rapid manual testing never trip 429s.
// The windows and relative budgets stay identical to production, only the ceilings scale.
const RATE_LIMIT_MULTIPLIER = process.env.NODE_ENV === 'production' ? 1 : 5;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30 * RATE_LIMIT_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('auth'),
  message: { message: 'Too many requests, please try again later.' },
  // /auth/refresh and /auth/revoke-sessions have their own limiters below. Session
  // refreshes are routine (every access-token expiry, from every signed-in user) and
  // MUST NOT compete with login/sync attempts for the strict per-IP budget - on shared
  // IPs (offices, mobile CGNAT) a 429 here used to log users out mid-session.
  // revoke-sessions is the security-critical "kill other devices" step of a password
  // reset (audit P2-8): losing it to a burned shared bucket silently left an attacker's
  // sessions alive after the victim reset their password.
  skip: (req) => req.path === '/refresh' || req.path === '/revoke-sessions',
});

// Refresh-token endpoint limiter. Generous: it only needs to stop hammering, not guessing -
// tokens are 80 hex chars, so brute force via this endpoint is not a realistic threat.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300 * RATE_LIMIT_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('refresh'),
  message: { message: 'Too many requests, please try again later.' },
});

// /auth/revoke-sessions own bucket (audit P2-8): fired once per password reset, it must
// never lose to login/sync traffic on a shared IP. Small but roomy for an office NAT;
// the endpoint requires a valid Supabase token, so hammering it buys an attacker nothing.
const revokeSessionsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20 * RATE_LIMIT_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('revoke-sessions'),
  message: { message: 'Too many requests, please try again later.' },
});

// Stricter limiter applied only to account registration — prevents bot farms
// from mass-creating accounts from a single IP (5 new accounts per hour per IP)
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5 * RATE_LIMIT_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('registration'),
  message: { message: 'Too many registration attempts from this IP. Please try again later.' },
});

// /auth/check-email tells the register form whether an email is taken — inherently an existence
// oracle. It can't be removed without hurting the "email already registered" UX, so cap it tightly
// on its OWN per-IP bucket (F15): enough for a wired office NAT where several people register in
// the same window (one call per form submit), far too slow to enumerate a user base. Stacked on
// top of the general authLimiter.
const checkEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30 * RATE_LIMIT_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('check-email'),
  message: { message: 'Too many requests, please try again later.' },
});

const ticketsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30 * RATE_LIMIT_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: express.Request) => req.user?.id?.toString() ?? getClientIpKey(req),
  store: makeRateLimitStore('tickets'),
  message: { message: 'You\'re moving fast! Give it a minute and try again.' },
});

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20 * RATE_LIMIT_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('public'),
  message: { message: 'You\'re moving fast! Give it a minute and try again.' },
});

// OTP limiter — 50 per IP per hour. Handles shared networks (universities, offices)
// while still blocking bot farms. Per-user + per-phone limits are the primary defense.
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50 * RATE_LIMIT_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('otp'),
  message: { message: 'Too many verification requests from this device. Please try again later.' },
});

// Authenticated business-area limiter. A single dashboard load fans out several reads
// (my-business, subscription, campaign header/kpis/entries, analytics), so this is keyed
// PER USER with a generous cap. It replaces the anonymous per-IP publicLimiter that the
// authed /business routes used to inherit (publicBusinessRouter's router-level middleware
// ran on every /business request before falling through), which made an owner — or several
// staff behind one office IP — trip the 20/min public cap just by opening the dashboard.
const businessLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120 * RATE_LIMIT_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: express.Request) => req.user?.id?.toString() ?? getClientIpKey(req),
  store: makeRateLimitStore('business'),
  message: { message: 'You\'re moving fast! Give it a minute and try again.' },
});

// Admin-area limiter. Every /admin request already needs a valid Admin JWT (global
// authenticateToken + router-wide requireRole), so this is defense-in-depth: it caps how
// fast a leaked admin token could be scripted against the API. Keyed per user (falls back
// to IP for the pre-auth 401 path); generous enough for heavy dashboard use.
const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120 * RATE_LIMIT_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: express.Request) => req.user?.id?.toString() ?? getClientIpKey(req),
  store: makeRateLimitStore('admin'),
  message: { message: 'You\'re moving fast! Give it a minute and try again.' },
});

// Push-notification subscribe/unsubscribe. Called on page load / permission grant, so a
// modest per-user cap is plenty; pairs with a per-user row cap in saveSubscription to stop
// unbounded push_subscription growth from a scripted authenticated client.
const notificationsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60 * RATE_LIMIT_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: express.Request) => req.user?.id?.toString() ?? getClientIpKey(req),
  store: makeRateLimitStore('notifications'),
  message: { message: 'You\'re moving fast! Give it a minute and try again.' },
});

// Stripe webhook must receive raw body — register BEFORE express.json()
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);

// Twilio delivery-status callback (urlencoded, signature-validated in the handler).
app.post('/webhooks/twilio-status', express.urlencoded({ extended: false, limit: '5kb' }), twilioStatusWebhook);

// Funnel analytics ingestion - registered BEFORE the global express.json() so it gets
// its own tight 10kb body cap (a batch of 25 tiny events fits in ~4kb). Public: the
// registration funnel starts before an account exists; optionalAuth binds user_id
// when a JWT is present. The endpoint itself always answers 204 (see controller).
const funnelLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 120 * RATE_LIMIT_MULTIPLIER, // a real journey sends ~5-8 batches; 120 is abuse headroom
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('funnel'),
  message: { message: 'Too many requests.' },
});
app.use('/events', funnelLimiter, express.json({ limit: '10kb' }), optionalAuth, analyticsRoutes);

app.use(express.json());

// ── Public routes (no auth required) ──
// NOTE: the dev/test-only /auth/test-setup route (test-setup.controller.ts) is
// intentionally NOT registered — re-add it here (guarded by NODE_ENV) when running
// e2e tests locally:
//   if (process.env.NODE_ENV !== 'production') app.post('/auth/test-setup', testSetup);
// Registration gets its own tighter limiter stacked on top of the general auth limiter
app.use('/auth/register', registrationLimiter);
app.use('/auth/check-email', checkEmailLimiter); // F15: tighter, dedicated bucket for the email oracle
app.use('/auth/refresh', refreshLimiter); // authLimiter skips /refresh (see limiter defs)
app.use('/auth/revoke-sessions', revokeSessionsLimiter); // authLimiter skips it too (P2-8)
app.use('/auth', authLimiter, authRoutes);

// Public business discovery endpoints — accessible without login (e.g. browsing the map).
// publicLimiter is attached PER ROUTE (not via router.use) on purpose: an authenticated
// /business/* request first enters this router and, finding no matching public route, falls
// through to the authed businessRouter below. Router-level middleware would have metered that
// fall-through against the anonymous 20/min public bucket. Per-route keeps the public map/
// discovery budget intact while letting authed dashboard traffic use businessLimiter instead.
const publicBusinessRouter = Router();
publicBusinessRouter.get('/nearby', publicLimiter, getNearby);
publicBusinessRouter.get('/participating/locations/search', publicLimiter, searchParticipatingLocations);
publicBusinessRouter.get('/locations/:locationId/profile', publicLimiter, optionalAuth, getLocationProfileById);
publicBusinessRouter.get('/participating/locations/:locationId', publicLimiter, getParticipatingLocationById);
publicBusinessRouter.post('/address', publicLimiter, getAddressController);
publicBusinessRouter.get('/address-coords', publicLimiter, getAddressCoordsController);
publicBusinessRouter.get('/subscription/founding-availability', publicLimiter, getFoundingAvailability);
app.use('/business', publicBusinessRouter);

// Public draws endpoint — campaign info is public
const publicDrawsRouter = Router();
publicDrawsRouter.use(publicLimiter);
publicDrawsRouter.get('/active', drawsController.getActiveDraws);
publicDrawsRouter.get('/history', drawsController.getDrawHistory);
publicDrawsRouter.get('/:drawId', drawsController.getDrawById);
app.use('/draws', publicDrawsRouter);

// Public referral resolve — the /join landing fetches the referrer's first name before login.
app.get('/referral/resolve', publicLimiter, resolveReferral);

// Public contact form — logged-out visitors can reach us too. Tight per-IP budget: each
// submission sends a real email to the support inbox, so this only needs a handful per
// person, ever, and any more is abuse.
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5 * RATE_LIMIT_MULTIPLIER,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('contact'),
  message: { message: 'Too many messages from this device. Please try again later.' },
});
app.use('/contact', contactLimiter, contactRoutes);

// ── Authenticated routes ──
app.use(authenticateToken);

app.use('/admin', adminLimiter, adminRoutes);
app.use('/tickets', ticketsLimiter, ticketsRoutes);
app.use('/draws', drawsRoutes);
app.use('/business', businessLimiter, businessRoutes);
app.use('/notifications', notificationsLimiter, notificationRoutes);
app.use('/phone/send-otp', otpLimiter);
app.use('/phone', phoneRouter);
app.use('/referral', referralRoutes);

// Global error handler — prevents stack traces and file paths from leaking to clients
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Malformed request bodies (express.json SyntaxError, oversized payloads) are client errors,
  // not server faults - answer 400 and skip Sentry.
  const status = (err as { status?: number; type?: string }).status;
  if ((err as { type?: string }).type === 'entity.parse.failed' || err instanceof SyntaxError
      || (typeof status === 'number' && status >= 400 && status < 500)) {
    res.status(typeof status === 'number' ? status : 400).json({ message: 'Invalid request body.' });
    return;
  }
  console.error(err);
  // Report to Sentry with request context (no-op unless SENTRY_DSN is set)
  captureError(err, { method: req.method, url: req.originalUrl, userId: req.user?.id });
  res.status(500).json({ message: 'Internal server error' });
});

export default app;
