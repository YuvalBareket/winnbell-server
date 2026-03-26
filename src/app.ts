import express from 'express';
import cors from 'cors';
import authRoutes from './features/auth/auth.routes.js';
import adminRoutes from './features/admin/admin.routes.js';
import ticketsRoutes from './features/tickets/tickets.routes.js';
import businessRoutes from './features/business/business.routes.js';
import drawsRoutes from './features/draws/draws.routes.js';

import { authenticateToken } from './shared/middleware/auth.middleware.js';
const app = express();

app.use(
  cors({
    origin: 'http://localhost:8081',
    credentials: true,
  }),
);

app.use(express.json());

// Routes
app.use('/auth', authRoutes);

app.use(authenticateToken);

app.use('/admin', adminRoutes);
app.use('/tickets', ticketsRoutes);
app.use('/draws', drawsRoutes);

app.use('/business', businessRoutes);

export default app;
