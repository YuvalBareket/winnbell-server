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
import { Router } from 'express';
import {
  getNearby,
  getParticipating,
  getParticipatingLocationById,
  searchParticipatingLocations,
  getEntryMode,
  getAddressController,
  getAddressCoordsController,
} from './features/business/business.controller.js';
import { getFoundingAvailability } from './features/stripe/stripe.controller.js';

import { authenticateToken } from './shared/middleware/auth.middleware.js';
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
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('auth'),
  message: { message: 'Too many requests, please try again later.' },
});

// Stricter limiter applied only to account registration — prevents bot farms
// from mass-creating accounts from a single IP (5 new accounts per hour per IP)
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('registration'),
  message: { message: 'Too many registration attempts from this IP. Please try again later.' },
});

const ticketsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: express.Request) => req.user?.id?.toString() ?? getClientIpKey(req),
  store: makeRateLimitStore('tickets'),
  message: { message: 'Too many requests, please slow down.' },
});

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('public'),
  message: { message: 'Too many requests, please slow down.' },
});

// OTP limiter — 50 per IP per hour. Handles shared networks (universities, offices)
// while still blocking bot farms. Per-user + per-phone limits are the primary defense.
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIpKey,
  store: makeRateLimitStore('otp'),
  message: { message: 'Too many verification requests from this device. Please try again later.' },
});

// Stripe webhook must receive raw body — register BEFORE express.json()
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);

app.use(express.json());

// ── Public routes (no auth required) ──
// NOTE: the dev/test-only /auth/test-setup route (test-setup.controller.ts) is
// intentionally NOT registered — re-add it here (guarded by NODE_ENV) when running
// e2e tests locally:
//   if (process.env.NODE_ENV !== 'production') app.post('/auth/test-setup', testSetup);
// Registration gets its own tighter limiter stacked on top of the general auth limiter
app.use('/auth/register', registrationLimiter);
app.use('/auth', authLimiter, authRoutes);

// Public business discovery endpoints — accessible without login (e.g. browsing the map)
const publicBusinessRouter = Router();
publicBusinessRouter.use(publicLimiter);
publicBusinessRouter.get('/nearby', getNearby);
publicBusinessRouter.get('/participating', getParticipating);
publicBusinessRouter.get('/participating/locations/search', searchParticipatingLocations);
publicBusinessRouter.get('/participating/locations/:locationId', getParticipatingLocationById);
publicBusinessRouter.get('/mode', getEntryMode);
publicBusinessRouter.post('/address', getAddressController);
publicBusinessRouter.get('/address-coords', getAddressCoordsController);
publicBusinessRouter.get('/subscription/founding-availability', getFoundingAvailability);
app.use('/business', publicBusinessRouter);

// Public draws endpoint — campaign info is public
const publicDrawsRouter = Router();
publicDrawsRouter.get('/active', drawsController.getActiveDraws);
publicDrawsRouter.get('/history', drawsController.getDrawHistory);
publicDrawsRouter.get('/:drawId', drawsController.getDrawById);
app.use('/draws', publicDrawsRouter);

// ── Authenticated routes ──
app.use(authenticateToken);

app.use('/admin', adminRoutes);
app.use('/tickets', ticketsLimiter, ticketsRoutes);
app.use('/draws', drawsRoutes);
app.use('/business', businessRoutes);
app.use('/notifications', notificationRoutes);
app.use('/phone/send-otp', otpLimiter);
app.use('/phone', phoneRouter);

// Global error handler — prevents stack traces and file paths from leaking to clients
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  // Report to Sentry with request context (no-op unless SENTRY_DSN is set)
  captureError(err, { method: req.method, url: req.originalUrl, userId: req.user?.id });
  res.status(500).json({ message: 'Internal server error' });
});

export default app;
