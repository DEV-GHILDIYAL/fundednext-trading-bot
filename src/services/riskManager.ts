import { logger } from '../utils/logger';
import { config } from '../config';

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
  dailyLossRemaining: number;
  tradesLeftToday: number;
}

export class RiskManager {
  private dailyLossAmount: number = 0;
  private tradesExecutedToday: number = 0;
  private dailyLossSafetyHit: boolean = false;

  /**
   * Check if new trade can be placed
   */
  canPlaceTrade(): RiskCheckResult {
    // Check 1: Daily loss limit
    if (this.dailyLossAmount <= -config.maxDailyLoss) {
      return {
        allowed: false,
        reason: `Daily loss limit reached ($${config.maxDailyLoss})`,
        dailyLossRemaining: 0,
        tradesLeftToday: 0,
      };
    }

    // Check 2: Safety buffer
    if (this.dailyLossAmount <= -config.safetyBuffer) {
      if (!this.dailyLossSafetyHit) {
        this.dailyLossSafetyHit = true;
        logger.warn(`⚠️ SAFETY BUFFER HIT! No more trades for rest of day.`);
      }
      return {
        allowed: false,
        reason: `Safety buffer reached ($${config.safetyBuffer}). No trades for rest of day.`,
        dailyLossRemaining: 0,
        tradesLeftToday: 0,
      };
    }

    // Check 3: Max trades per day
    if (this.tradesExecutedToday >= config.maxTradesPerDay) {
      return {
        allowed: false,
        reason: `Max ${config.maxTradesPerDay} trades per day reached`,
        dailyLossRemaining: config.maxDailyLoss + this.dailyLossAmount,
        tradesLeftToday: 0,
      };
    }

    return {
      allowed: true,
      reason: 'Risk checks passed',
      dailyLossRemaining: config.maxDailyLoss + this.dailyLossAmount,
      tradesLeftToday: config.maxTradesPerDay - this.tradesExecutedToday,
    };
  }

  /**
   * Validate trade parameters
   */
  validateTradeRisk(
    entryPrice: number,
    stopLossPrice: number,
    riskAmount: number = config.riskPerTrade
  ): {
    valid: boolean;
    reason: string;
  } {
    // Check 1: Risk per trade
    if (riskAmount > config.riskPerTrade) {
      return {
        valid: false,
        reason: `Risk per trade ($${riskAmount}) exceeds limit ($${config.riskPerTrade})`,
      };
    }

    // Check 2: Minimum profit potential
    const distance = Math.abs(entryPrice - stopLossPrice);
    const minProfit = distance * 2; // 1:2 ratio minimum

    if (minProfit < config.riskPerTrade) {
      return {
        valid: false,
        reason: `Minimum profit potential ($${minProfit.toFixed(2)}) below risk amount`,
      };
    }

    return {
      valid: true,
      reason: 'Trade risk parameters valid',
    };
  }

  /**
   * Record trade execution
   */
  recordTrade(pnl: number): void {
    this.tradesExecutedToday++;
    this.dailyLossAmount += pnl;

    const status = pnl > 0 ? '✅ WIN' : '❌ LOSS';
    logger.info(`${status} | Daily P&L: $${this.dailyLossAmount.toFixed(2)} | Trades: ${this.tradesExecutedToday}/${config.maxTradesPerDay}`);

    // Check if safety buffer should be hit after this trade
    if (this.dailyLossAmount <= -config.safetyBuffer && !this.dailyLossSafetyHit) {
      this.dailyLossSafetyHit = true;
      logger.warn(`⚠️ SAFETY BUFFER TRIGGERED! No more trades today.`);
    }
  }

  /**
   * Reset daily counters (at EOD or next day)
   */
  resetDaily(): void {
    logger.info(`📊 Daily Stats: P&L $${this.dailyLossAmount.toFixed(2)} | Trades: ${this.tradesExecutedToday}`);
    
    this.dailyLossAmount = 0;
    this.tradesExecutedToday = 0;
    this.dailyLossSafetyHit = false;

    logger.info('🔄 Daily counters reset');
  }

  /**
   * Get risk status
   */
  getStatus(): {
    dailyLossAmount: number;
    dailyLossRemaining: number;
    tradesExecuted: number;
    tradesRemaining: number;
    safetyBufferHit: boolean;
  } {
    return {
      dailyLossAmount: this.dailyLossAmount,
      dailyLossRemaining: config.maxDailyLoss + this.dailyLossAmount,
      tradesExecuted: this.tradesExecutedToday,
      tradesRemaining: Math.max(0, config.maxTradesPerDay - this.tradesExecutedToday),
      safetyBufferHit: this.dailyLossSafetyHit,
    };
  }
}

// Export singleton
export const riskManager = new RiskManager();
