import { logger } from '../utils/logger';

export interface OpenTrade {
  tradeId: string;
  pair: string;
  type: 'BUY' | 'SELL';
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  pnl: number;
  pnlPercent: number;
  openedAt: Date;
}

export interface TradeMonitorConfig {
  checkIntervalMs: number;
  alertOnPips: number;
}

export class TradeMonitor {
  private openTrades: Map<string, OpenTrade> = new Map();
  private config: TradeMonitorConfig;

  constructor(config: Partial<TradeMonitorConfig> = {}) {
    this.config = {
      checkIntervalMs: 1000, // Check every second
      alertOnPips: 10, // Alert every 10 pips move
      ...config,
    };
  }

  /**
   * Register open trade for monitoring
   */
  registerTrade(trade: OpenTrade): void {
    this.openTrades.set(trade.tradeId, trade);
    logger.info(`📌 Trade registered for monitoring: ${trade.tradeId}`);
  }

  /**
   * Update current price for a trade
   */
  updateTradePrice(tradeId: string, currentPrice: number): void {
    const trade = this.openTrades.get(tradeId);
    if (!trade) {
      logger.warn(`Trade not found: ${tradeId}`);
      return;
    }

    const oldPnL = trade.pnl;
    trade.currentPrice = currentPrice;

    // Calculate new P&L
    if (trade.type === 'BUY') {
      trade.pnl = (currentPrice - trade.entryPrice) * trade.quantity * 10000;
    } else {
      trade.pnl = (trade.entryPrice - currentPrice) * trade.quantity * 10000;
    }

    trade.pnlPercent = (trade.pnl / 30) * 100; // Risk was $30

    // Check for SL/TP hit
    this.checkExitConditions(trade);

    // Log significant moves
    const pnlChange = Math.abs(trade.pnl - oldPnL);
    if (pnlChange > 10) {
      logger.info(`💰 ${trade.tradeId}: P&L ${trade.pnl.toFixed(2)} | ${trade.pnlPercent.toFixed(1)}%`);
    }
  }

  /**
   * Check if trade should exit (SL/TP hit)
   */
  private checkExitConditions(trade: OpenTrade): void {
    const slHit = 
      trade.type === 'BUY'
        ? trade.currentPrice <= trade.stopLoss
        : trade.currentPrice >= trade.stopLoss;

    const tpHit =
      trade.type === 'BUY'
        ? trade.currentPrice >= trade.takeProfit
        : trade.currentPrice <= trade.takeProfit;

    if (slHit) {
      logger.warn(`⛔ SL HIT: ${trade.tradeId} - Loss: $${trade.pnl.toFixed(2)}`);
      // Signal to close at SL
    }

    if (tpHit) {
      logger.info(`✅ TP HIT: ${trade.tradeId} - Profit: $${trade.pnl.toFixed(2)}`);
      // Signal to close at TP
    }
  }

  /**
   * Get trade status
   */
  getTradeStatus(tradeId: string): OpenTrade | null {
    return this.openTrades.get(tradeId) || null;
  }

  /**
   * Get all open trades
   */
  getOpenTrades(): OpenTrade[] {
    return Array.from(this.openTrades.values());
  }

  /**
   * Remove trade (when closed)
   */
  removeTrade(tradeId: string): void {
    this.openTrades.delete(tradeId);
    logger.info(`🗑️ Trade removed: ${tradeId}`);
  }

  /**
   * Calculate total P&L
   */
  calculateTotalPnL(): number {
    let totalPnL = 0;
    for (const trade of this.openTrades.values()) {
      totalPnL += trade.pnl;
    }
    return totalPnL;
  }

  /**
   * Check if daily loss limit reached
   */
  isDailyLossLimitHit(maxDailyLoss: number = 100): boolean {
    const totalPnL = this.calculateTotalPnL();
    return totalPnL <= -maxDailyLoss;
  }

  /**
   * Get safety buffer status
   */
  getSafetyBufferStatus(safetyBuffer: number = 70): {
    hit: boolean;
    currentLoss: number;
    buffer: number;
  } {
    const totalPnL = this.calculateTotalPnL();
    return {
      hit: totalPnL <= -safetyBuffer,
      currentLoss: Math.abs(totalPnL),
      buffer: safetyBuffer,
    };
  }

  /**
   * Get trade statistics
   */
  getStatistics(): {
    openTrades: number;
    totalPnL: number;
    winningTrades: number;
    losingTrades: number;
    averagePnL: number;
  } {
    const trades = this.getOpenTrades();
    const winningTrades = trades.filter((t) => t.pnl > 0).length;
    const losingTrades = trades.filter((t) => t.pnl < 0).length;
    const totalPnL = this.calculateTotalPnL();
    const averagePnL = trades.length > 0 ? totalPnL / trades.length : 0;

    return {
      openTrades: trades.length,
      totalPnL,
      winningTrades,
      losingTrades,
      averagePnL,
    };
  }
}

// Export singleton
export const tradeMonitor = new TradeMonitor();
