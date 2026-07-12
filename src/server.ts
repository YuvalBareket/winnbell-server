import 'dotenv/config'; // 1. LOAD ENV VARS FIRST
import { connectDB } from './shared/db/db.js';
import app from './app.js';
import { recoverStaleOcrJobs } from './features/ocr/ocr.service.js';
import { cleanupExpiredRefreshTokens } from './features/auth/auth.service.js';
import { cleanupOldWebhookEvents } from './features/stripe/stripe.service.js';
import { initMonitoring } from './shared/monitoring.js';

const PORT = process.env.PORT || 3000;

// Fail fast — these must be set before the server starts
const REQUIRED_ENV = ['JWT_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const startServer = async () => {
  try {
    // Error monitoring first, so any startup failure is captured (no-op without SENTRY_DSN)
    initMonitoring();

    // 2. Connect to Database
    await connectDB();

    // Re-queue any OCR jobs that were lost during a server restart
    await recoverStaleOcrJobs();

    // 3. Start Server
    app.listen(PORT, () => {
      console.log(`🚀 Winnbell server running on port ${PORT}`);
    });

    // Purge expired refresh tokens + old webhook idempotency claims every 6 hours
    setInterval(() => {
      cleanupExpiredRefreshTokens().catch(err => console.error('[cleanup] refresh token purge failed:', err));
      cleanupOldWebhookEvents().catch(err => console.error('[cleanup] webhook event purge failed:', err));
    }, 6 * 60 * 60 * 1000);

    // Retry lost / provider-errored OCR jobs every 30 minutes so a Google Vision blip never
    // permanently holds an honest entry (it self-heals well before the month-end draw).
    setInterval(() => {
      recoverStaleOcrJobs().catch(err => console.error('[OCR] periodic recovery failed:', err));
    }, 30 * 60 * 1000);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
