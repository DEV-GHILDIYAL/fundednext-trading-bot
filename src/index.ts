import dotenv from 'dotenv';
import { logger } from './utils/logger';

// Load environment variables
dotenv.config();

async function main(): Promise<void> {
  try {
    logger.info('🚀 FundedNext Trading Bot Starting...');
    logger.info(`Environment: ${process.env.NODE_ENV}`);
    logger.info(`Dry Run Mode: ${process.env.DRY_RUN}`);

    // Phase 1: Foundation setup
    logger.info('Phase 1: Foundation setup complete');
    logger.info('- ✅ TypeScript configured');
    logger.info('- ✅ Environment variables loaded');
    logger.info('- ✅ Logging system initialized');

    logger.info('Ready for Phase 2: API Integration');
  } catch (error) {
    logger.error('Fatal error in main:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Unhandled error:', error);
  process.exit(1);
});
