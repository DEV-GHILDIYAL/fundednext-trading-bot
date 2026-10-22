import { logger } from '../utils/logger';
import { config } from '../config';

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
  dailyLossRemaining: number;
  tradesLeftToday: number;
}

export class RiskManager {
  /** Realized P&L for today (negative = loss) */
  private dailyLossAmount = 0;
  private tradesExecutedToday = 0;
  private wins = 0;
  private losses = 0;
  private safetyBufferHit = false;

  /**
   * Can a new trade be opened? Uses realized + unrealized P&L.
   */
  canPlaceTrade(unrealizedPnL: number = 0): RiskCheckResult {
    const total = this.dailyLossAmount + unrealizedPnL;
    const remaining = Math.max(0, config.maxDailyLoss + total);

    if (total <= -config.maxDailyLoss) {
      return { allowed: false, reason: `Daily loss limit reached ($${config.maxDailyLoss})`, dailyLossRemaining: 0, tradesLeftToday: 0 };
    }

    if (this.safetyBufferHit || total <= -config.safetyBuffer) {
      if (!this.safetyBufferHit) {
        this.safetyBufferHit = true;
        logger.warn(`⚠️ SAFETY BUFFER HIT ($${config.safetyBuffer}). No new trades for rest of day.`);
      }
      return { allowed: false, reason: `Safety buffer reached ($${config.safetyBuffer})`, dailyLossRemaining: remaining, tradesLeftToday: 0 };
    }

    if (this.tradesExecutedToday >= config.maxTradesPerDay) {
      return { allowed: false, reason: `Max ${config.maxTradesPerDay} trades per day reached`, dailyLossRemaining: remaining, tradesLeftToday: 0 };
    }

    return {
      allowed: true,
      reason: 'Risk checks passed',
      dailyLossRemaining: remaining,
      tradesLeftToday: config.maxTradesPerDay - this.tradesExecutedToday,
    };
  }

  /** Restore today's counters after a restart (from the trade journal) */
  restore(stats: { trades: number; realizedPnL: number; wins: number; losses: number }): void {
    this.tradesExecutedToday = stats.trades;
    this.dailyLossAmount = parseFloat(stats.realizedPnL.toFixed(2));
    this.wins = stats.wins;
    this.losses = stats.losses;
    this.safetyBufferHit = this.dailyLossAmount <= -config.safetyBuffer;
    if (stats.trades > 0) {
      logger.info(
        `♻️ Restored today's risk state: ${stats.trades} trade(s), realized $${this.dailyLossAmount.toFixed(2)}`
      );
    }
  }

  recordTradeOpened(): void {
    this.tradesExecutedToday++;
    logger.info(`🧮 Trades today: ${this.tradesExecutedToday}/${config.maxTradesPerDay}`);
  }

  recordTradeClosed(pnl: number): void {
    this.dailyLossAmount = parseFloat((this.dailyLossAmount + pnl).toFixed(2));
    if (pnl > 0) this.wins++;
    else if (pnl < 0) this.losses++;

    logger.info(`${pnl >= 0 ? '✅ WIN' : '❌ LOSS'} $${pnl.toFixed(2)} | Daily P&L: $${this.dailyLossAmount.toFixed(2)}`);

    if (this.dailyLossAmount <= -config.safetyBuffer && !this.safetyBufferHit) {
      this.safetyBufferHit = true;
      logger.warn(`⚠️ SAFETY BUFFER TRIGGERED. No more trades today.`);
    }
  }

  resetDaily(): void {
    logger.info(
      `📊 Day closed: P&L $${this.dailyLossAmount.toFixed(2)} | Trades ${this.tradesExecutedToday} | W ${this.wins} / L ${this.losses}`
    );
    this.dailyLossAmount = 0;
    this.tradesExecutedToday = 0;
    this.wins = 0;
    this.losses = 0;
    this.safetyBufferHit = false;
    logger.info('🔄 Daily risk counters reset');
  }

  getStatus(): {
    dailyLossAmount: number;
    dailyLossRemaining: number;
    tradesExecuted: number;
    tradesRemaining: number;
    safetyBufferHit: boolean;
    wins: number;
    losses: number;
  } {
    return {
      dailyLossAmount: this.dailyLossAmount,
      dailyLossRemaining: Math.max(0, config.maxDailyLoss + this.dailyLossAmount),
      tradesExecuted: this.tradesExecutedToday,
      tradesRemaining: Math.max(0, config.maxTradesPerDay - this.tradesExecutedToday),
      safetyBufferHit: this.safetyBufferHit,
      wins: this.wins,
      losses: this.losses,
    };
  }
}

export const riskManager = new RiskManager();
