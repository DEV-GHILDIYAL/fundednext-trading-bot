import * as cron from 'node-cron';
import { logger } from '../utils/logger';
import { config } from '../config';
import { riskManager } from '../services/riskManager';
import { tradeMonitor } from '../services/tradeMonitor';
import { isWithinTradingSession } from '../utils/time';

export class BotScheduler {
  private tasks: Map<string, cron.ScheduledTask> = new Map();

  initialize(): void {
    if (this.tasks.size > 0) return;

    const opts = { timezone: config.timezone };

    // Daily reset at midnight (bot timezone)
    this.add('dailyReset', '0 0 * * *', opts, () => {
      riskManager.resetDaily();
    });

    // Hourly report during the session
    this.add('hourlyReport', '0 * * * *', opts, () => {
      if (!isWithinTradingSession()) return;
      const stats = tradeMonitor.getStatistics();
      const risk = riskManager.getStatus();
      logger.info(
        `🕐 Hourly: Open ${stats.openTrades} | Unrealized $${stats.totalPnL.toFixed(2)} | ` +
          `Realized $${risk.dailyLossAmount.toFixed(2)} | Trades ${risk.tradesExecuted}/${config.maxTradesPerDay}`
      );
    });

    logger.info(`⏰ Scheduler ready (${this.tasks.size} tasks, timezone ${config.timezone})`);
  }

  private add(name: string, expression: string, options: { timezone: string }, job: () => void): void {
    if (!cron.validate(expression)) {
      logger.error(`Invalid cron expression for ${name}: "${expression}"`);
      return;
    }
    const task = cron.schedule(
      expression,
      () => {
        try {
          job();
        } catch (error) {
          logger.error(`Scheduled task ${name} failed`, error);
        }
      },
      options
    );
    this.tasks.set(name, task);
  }

  stopAll(): void {
    for (const task of this.tasks.values()) task.stop();
    this.tasks.clear();
    logger.info('⏹️ Scheduler stopped');
  }

  /** Tasks are removed from the map when stopped, so every listed task is running */
  getStatus(): { taskName: string; running: boolean }[] {
    return Array.from(this.tasks.keys()).map((taskName) => ({ taskName, running: true }));
  }
}

export const scheduler = new BotScheduler();
