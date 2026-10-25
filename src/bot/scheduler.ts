import * as cron from 'node-cron';
import { logger } from '../utils/logger';
import { config } from '../config';
import { riskManager } from '../services/riskManager';
import { tradeMonitor } from '../services/tradeMonitor';
import { isAnySleeveInSession as isWithinTradingSession } from '../utils/time';
import { alerts } from '../services/alerts';
import { newsCalendar } from '../strategies/news';

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

    const ist = { timezone: 'Asia/Kolkata' };
    // 12:40 IST: today's Fib Sweep levels (or "no trading today" on major news days)
    this.add('fibLevels', '40 12 * * 1-5', ist, () => {
      void newsCalendar
        .majorNewsDay(new Date())
        .catch(() => null)
        .then((day) => alerts.fibLevels(config.newsFilter ? day : null));
    });
    // 23:30 IST: daily summary
    this.add('dailySummary', '30 23 * * 1-5', ist, () => alerts.dailySummary());

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
