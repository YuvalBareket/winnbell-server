import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import authRoutes from './features/auth/auth.routes.js';
import adminRoutes from './features/admin/admin.routes.js';
import ticketsRoutes from './features/tickets/tickets.routes.js';
import businessRoutes from './features/business/business.routes.js';
import drawsRoutes from './features/draws/draws.routes.js';
import stripeWebhookRoutes from './features/stripe/stripe.routes.js';
import notificationRoutes from './features/notifications/notifications.routes.js';
import { Router } from 'express';
import {
  getNearby,
  getParticipating,
  searchParticipatingLocations,
  getEntryMode,
  getAddressController,
} from './features/business/business.controller.js';
import { handleClerkWebhook } from './features/auth/auth.controller.js';

import { authenticateToken } from './shared/middleware/auth.middleware.js';

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
      callback(new Error('Not allowed by CORS'));
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
  message: { message: 'Too many requests, please try again later.' },
});

const redeemLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many redemption attempts, please slow down.' },
});

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please slow down.' },
});

// Stripe webhook must receive raw body — register BEFORE express.json()
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);

// Clerk webhook must be raw and bypass the auth rate limiter — register BEFORE express.json()
app.post('/auth/webhooks', express.raw({ type: 'application/json' }), handleClerkWebhook);

app.use(express.json());

// ── Public routes (no auth required) ──
app.use('/auth', authLimiter, authRoutes);

// Public business discovery endpoints — accessible without login (e.g. browsing the map)
const publicBusinessRouter = Router();
publicBusinessRouter.get('/nearby', getNearby);
publicBusinessRouter.get('/participating', getParticipating);
publicBusinessRouter.get('/participating/locations/search', searchParticipatingLocations);
publicBusinessRouter.get('/mode', getEntryMode);
publicBusinessRouter.post('/address', publicLimiter, getAddressController);
app.use('/business', publicBusinessRouter);

// ── Authenticated routes ──
app.use(authenticateToken);

app.use('/admin', adminRoutes);
app.use('/tickets', redeemLimiter, ticketsRoutes);
app.use('/draws', drawsRoutes);
app.use('/business', businessRoutes);
app.use('/notifications', notificationRoutes);

export default app;
