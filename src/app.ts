import express from 'express';
import cors from 'cors';
import authRoutes from './features/auth/auth.routes.js';
import adminRoutes from './features/admin/admin.routes.js';
import ticketsRoutes from './features/tickets/tickets.routes.js';
import businessRoutes from './features/business/business.routes.js';
import drawsRoutes from './features/draws/draws.routes.js';
import stripeWebhookRoutes from './features/stripe/stripe.routes.js';

import { authenticateToken } from './shared/middleware/auth.middleware.js';

const app = express();

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

// Stripe webhook must receive raw body — register BEFORE express.json()
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);

app.use(express.json());

// Routes
app.use('/auth', authRoutes);

app.use(authenticateToken);

app.use('/admin', adminRoutes);
app.use('/tickets', ticketsRoutes);
app.use('/draws', drawsRoutes);
app.use('/business', businessRoutes);

export default app;
