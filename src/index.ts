import { config } from './config';
import { logger } from './utils/logger';
import { bot } from './bot/bot';
import { scheduler } from './bot/scheduler';
import { dashboardServer } from './server/dashboardServer';
import { riskManager } from './services/riskManager';
import { tradeJournal } from './services/tradeJournal';
import { getZonedTime, formatClock } from './utils/time';

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal} — shutting down gracefully`);

  // Hard stop if graceful shutdown hangs
  setTimeout(() => process.exit(0), 4000).unref();

  try {
    scheduler.stopAll();
    bot.stop();
    await bot.closeAllPositions('Process shutdown');
    await dashboardServer.stop();
  } catch (error) {
    logger.error('Error during shutdown', error);
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', reason));
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception — exiting', error);
  process.exit(1);
});

async function main(): Promise<void> {
  const now = getZonedTime();
  logger.info('════════════════════════════════════════');
  logger.info('  🚀 FundedNext Trading Bot');
  logger.info('════════════════════════════════════════');
  logger.info(`Environment: ${config.nodeEnv} | Node ${process.version}`);
  logger.info(`Time: ${now.dateKey} ${formatClock(now)} (${config.timezone})`);
  logger.info(`Bot enabled: ${config.botEnabled} | Dry run: ${config.dryRun}`);
  logger.info(
    `Risk: $${config.riskPerTrade}/trade | Safety buffer $${config.safetyBuffer} | ` +
      `Max daily loss $${config.maxDailyLoss} | Max ${config.maxTradesPerDay} trades/day`
  );

  riskManager.restore(tradeJournal.getTodayStats());
  scheduler.initialize();
  dashboardServer.start();

  if (!config.botEnabled) {
    logger.warn('⚠️ BOT_ENABLED=false — trading loop not started. Set BOT_ENABLED=true in .env and restart.');
    return; // scheduler keeps the process alive
  }

  if (!config.dryRun) {
    logger.warn('⚠️ DRY_RUN=false but live MT5 execution is not implemented — orders will be refused.');
  }

  await bot.start();
}

main().catch((error) => {
  logger.error('Fatal error in main', error);
  process.exit(1);
});
