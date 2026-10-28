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
  setTimeout(() => process.exit(0), 10000).unref();

  // Open positions are NOT closed on shutdown: they keep their SL/TP (paper trades are
  // persisted to data/open-trades.json, live ones stay on MT5) and are restored on start.
  try {
    scheduler.stopAll();
    bot.stop();
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
  logger.info(`Bot enabled: ${config.botEnabled} | Dry run: ${config.dryRun} | Data source: ${config.dataSource}`);
  logger.info(
    `Risk: ${config.riskPercent}% ($${config.riskPerTrade})/trade | Max ${config.maxTradesPerDay} trades/day | ` +
      `1:${config.profitRatio} RR | no hedging | exits SL/TP only | min hold ${config.minTradeDurationSeconds}s`
  );
  logger.info(
    `FundedNext Phase ${config.challengePhase}: target $${config.targetProfit} (${config.profitTargetPercent}%) | ` +
      `min ${config.minTradingDaysPerPhase} trading days | daily loss $${config.maxDailyLoss} (${config.dailyLossPercent}%) | ` +
      `max loss $${config.maxTotalLoss} (${config.maxLossPercent}%)`
  );

  riskManager.restore(tradeJournal.getTodayStats());
  scheduler.initialize();
  dashboardServer.start();

  if (!config.botEnabled) {
    logger.warn('⚠️ BOT_ENABLED=false — trading loop not started. Set BOT_ENABLED=true in .env and restart.');
    return; // scheduler keeps the process alive
  }

  if (!config.dryRun) {
    logger.warn(`⚠️ LIVE TRADING (DRY_RUN=false) — real orders on MT5 via ${config.mt5BridgeUrl}`);
  }

  await bot.start();
}

main().catch((error) => {
  logger.error('Fatal error in main', error);
  process.exit(1);
});
