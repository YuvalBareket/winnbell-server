import 'dotenv/config'; // 1. LOAD ENV VARS FIRST
import { connectDB } from './shared/db/db.js';
import app from './app.js';
import { recoverStaleOcrJobs } from './features/ocr/ocr.service.js';

const PORT = process.env.PORT || 3000;

// Fail fast — these must be set before the server starts
const REQUIRED_ENV = ['JWT_SECRET', 'SUPABASE_JWT_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const startServer = async () => {
  try {
    // 2. Connect to Database
    await connectDB();

    // Re-queue any OCR jobs that were lost during a server restart
    await recoverStaleOcrJobs();

    // 3. Start Server
    app.listen(PORT, () => {
      console.log(`🚀 Winnbell server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
