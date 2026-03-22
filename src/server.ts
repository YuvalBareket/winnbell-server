import 'dotenv/config'; // 1. LOAD ENV VARS FIRST
import { connectDB } from './shared/db/db.js';
import app from './app.js';

const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    // 2. Connect to Database
    await connectDB();

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
