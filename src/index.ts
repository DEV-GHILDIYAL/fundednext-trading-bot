import dotenv from 'dotenv';
import { logger } from './utils/logger';
import { bot } from './bot/bot';
import { scheduler } from './bot/scheduler';
import { config } from './config';

// Load environment variables
dotenv.config();

async function main(): Promise<void> {
  try {
    logger.info('╔════════════════════════════════════════╗');
    logger.info('║  🚀 FundedNext Trading Bot - Phase 5  ║');
    logger.info('║     Bot Loop & Scheduling Ready       ║');
    logger.info('╚════════════════════════════════════════╝');
    logger.info('');

    logger.info(`Environment: ${config.nodeEnv}`);
    logger.info(`Dry Run Mode: ${config.dryRun}`);
    logger.info(`Account Balance: $${config.accountBalance}`);
    logger.info(`Bot Enabled: ${config.botEnabled}`);
    logger.info('');

    // Initialize scheduler
    logger.info('Step 1: Initializing scheduler...');
    scheduler.initialize();
    logger.info('');

    // Start bot
    logger.info('Step 2: Starting bot loop...');
    if (config.botEnabled) {
      await bot.start();
    } else {
      logger.warn(
        '⚠️ Bot is disabled (BOT_ENABLED=false). Set to true to start trading.'
      );
      logger.info('');
      logger.info('To enable the bot:');
      logger.info('1. Open .env file');
      logger.info('2. Change: BOT_ENABLED=true');
      logger.info('3. Change: DRY_RUN=false (to trade with real money)');
      logger.info('4. Restart bot');
    }
  } catch (error) {
    logger.error('Fatal error in main:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Unhandled error:', error);
  process.exit(1);
});
