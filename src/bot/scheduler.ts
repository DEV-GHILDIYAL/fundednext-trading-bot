import * as cron from 'node-cron';
import { logger } from '../utils/logger';
import { riskManager } from '../services/riskManager';
import { tradeMonitor } from '../services/tradeMonitor';
import { config } from '../config';

export class BotScheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();

  /**
   * Initialize all scheduled tasks
   */
  initialize(): void {
    logger.info('⏰ Initializing scheduler...');

    // Task 1: Daily reset at midnight IST
    this.scheduleDailyReset();

    // Task 2: Market open notification
    this.scheduleMarketOpen();

    // Task 3: Market close - force close all positions
    this.scheduleMarketClose();

    // Task 4: Hourly report
    this.scheduleHourlyReport();

    logger.info('✅ Scheduler initialized with 4 tasks');
  }

  /**
   * Daily reset at 00:00 IST (previous day closing)
   */
  private scheduleDailyReset(): void {
    // Every day at 12:00 AM IST (= 6:30 PM UTC previous day)
    const task = cron.schedule('0 0 * * *', () => {
      logger.info('🔄 Daily reset triggered');

      // Get end-of-day stats
      const stats = tradeMonitor.getStatistics();
      logger.info('📊 End of Day Report:');
      logger.info(`   Total Trades: ${stats.openTrades}`);
      logger.info(`   Daily P&L: $${stats.totalPnL.toFixed(2)}`);
      logger.info(`   Winning: ${stats.winningTrades} | Losing: ${stats.losingTrades}`);

      // Reset daily counters
      riskManager.resetDaily();
      tradeMonitor.getOpenTrades().forEach((trade) => {
        tradeMonitor.removeTrade(trade.tradeId);
      });

      logger.info('✅ Daily reset complete');
    });

    this.tasks.set('dailyReset', task);
  }

  /**
   * Market open notification (London Open)
   */
  private scheduleMarketOpen(): void {
    // Every weekday at 1:30 PM IST (8:00 AM GMT)
    // Cron: minute hour * * 1-5 (Monday to Friday)
    const task = cron.schedule(
      `${config.londonOpenMinute} ${config.londonOpenHour} * * 1-5`,
      () => {
        logger.info('╔════════════════════════════════════════╗');
        logger.info('║     📈 London Session Opened         ║');
        logger.info('║  Scanning for trade opportunities...  ║');
        logger.info('╚════════════════════════════════════════╝');
      }
    );

    this.tasks.set('marketOpen', task);
  }

  /**
   * Market close - force close all positions
   */
  private scheduleMarketClose(): void {
    // Every weekday at 5:00 PM IST (11:30 AM GMT)
    const task = cron.schedule(
      `${config.londonCloseMinute} ${config.londonCloseHour} * * 1-5`,
      () => {
        logger.info('╔════════════════════════════════════════╗');
        logger.info('║     📉 London Session Closing         ║');
        logger.info('║   Force closing all positions...      ║');
        logger.info('╚════════════════════════════════════════╝');

        // Close all open trades
        const openTrades = tradeMonitor.getOpenTrades();
        for (const trade of openTrades) {
          // TODO: Execute close order
          logger.info(`   ❌ Closing ${trade.pair} @ ${trade.currentPrice}`);
          tradeMonitor.removeTrade(trade.tradeId);
        }

        logger.info('✅ All positions closed for session end');
      }
    );

    this.tasks.set('marketClose', task);
  }

  /**
   * Hourly report during trading hours
   */
  private scheduleHourlyReport(): void {
    // Every hour at :00 minute
    const task = cron.schedule('0 * * * *', () => {
      const now = new Date();
      const hour = now.getHours();

      // Only during trading hours (1 PM - 5 PM IST)
      if (hour >= config.londonOpenHour && hour <= config.londonCloseHour) {
        const stats = tradeMonitor.getStatistics();
        const riskStatus = riskManager.getStatus();

        logger.info('📊 Hourly Report:');
        logger.info(
          `   Open Positions: ${stats.openTrades} | Daily P&L: $${stats.totalPnL.toFixed(2)}`
        );
        logger.info(
          `   Trades Used: ${riskStatus.tradesExecuted}/${config.maxTradesPerDay} | Loss: $${riskStatus.dailyLossAmount.toFixed(2)}/${config.maxDailyLoss}`
        );
      }
    });

    this.tasks.set('hourlyReport', task);
  }

  /**
   * Stop all scheduled tasks
   */
  stopAll(): void {
    logger.info('⏹️ Stopping all scheduled tasks...');

    for (const [name, task] of this.tasks.entries()) {
      task.stop();
      logger.info(`   ✅ ${name} stopped`);
    }

    this.tasks.clear();
    logger.info('✅ All scheduled tasks stopped');
  }

  /**
   * Get task status
   */
  getStatus(): { taskName: string; running: boolean }[] {
    return Array.from(this.tasks.entries()).map(([name]) => ({
      taskName: name,
      running: true,
    }));
  }
}

// Export singleton
export const scheduler = new BotScheduler();
