import { logger } from '../utils/logger';
import { config } from '../config';
import { Calculator } from '../utils/calculator';

export interface OpenTrade {
  tradeId: string;
  pair: string;
  type: 'BUY' | 'SELL';
  entryPrice: number;
  /** Price the position would close at right now (bid for BUY, ask for SELL) */
  currentPrice: number;
  /** Position size in units */
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  /** Unrealized P&L in USD */
  pnl: number;
  /** P&L as % of the risked amount */
  pnlPercent: number;
  openedAt: Date;
}

export type ExitReason = 'STOP_LOSS' | 'TAKE_PROFIT';

export class TradeMonitor {
  private openTrades: Map<string, OpenTrade> = new Map();

  registerTrade(trade: OpenTrade): void {
    this.openTrades.set(trade.tradeId, trade);
    logger.info(`📌 Monitoring ${trade.type} ${trade.pair} (${trade.tradeId})`);
  }

  /**
   * Update a trade with the latest quote. Returns the exit reason if SL/TP was hit.
   */
  updateTradePrice(tradeId: string, quote: { bid: number; ask: number }): ExitReason | null {
    const trade = this.openTrades.get(tradeId);
    if (!trade) {
      logger.warn(`Trade not found: ${tradeId}`);
      return null;
    }

    trade.currentPrice = trade.type === 'BUY' ? quote.bid : quote.ask;
    trade.pnl = Calculator.calculatePnL(trade.entryPrice, trade.currentPrice, trade.quantity, trade.type);
    trade.pnlPercent = parseFloat(((trade.pnl / config.riskPerTrade) * 100).toFixed(1));

    return this.checkExit(trade);
  }

  checkExit(trade: OpenTrade): ExitReason | null {
    const slHit = trade.type === 'BUY' ? trade.currentPrice <= trade.stopLoss : trade.currentPrice >= trade.stopLoss;
    if (slHit) return 'STOP_LOSS';

    const tpHit = trade.type === 'BUY' ? trade.currentPrice >= trade.takeProfit : trade.currentPrice <= trade.takeProfit;
    if (tpHit) return 'TAKE_PROFIT';

    return null;
  }

  getTradeStatus(tradeId: string): OpenTrade | null {
    return this.openTrades.get(tradeId) ?? null;
  }

  getOpenTrades(): OpenTrade[] {
    return Array.from(this.openTrades.values());
  }

  hasOpenTrade(pair: string): boolean {
    return this.getOpenTrades().some((t) => t.pair === pair);
  }

  removeTrade(tradeId: string): void {
    this.openTrades.delete(tradeId);
  }

  /** Total unrealized P&L of open trades */
  calculateTotalPnL(): number {
    let total = 0;
    for (const trade of this.openTrades.values()) total += trade.pnl;
    return parseFloat(total.toFixed(2));
  }

  getStatistics(): {
    openTrades: number;
    totalPnL: number;
    winningTrades: number;
    losingTrades: number;
    averagePnL: number;
  } {
    const trades = this.getOpenTrades();
    const totalPnL = this.calculateTotalPnL();
    return {
      openTrades: trades.length,
      totalPnL,
      winningTrades: trades.filter((t) => t.pnl > 0).length,
      losingTrades: trades.filter((t) => t.pnl < 0).length,
      averagePnL: trades.length > 0 ? totalPnL / trades.length : 0,
    };
  }
}

export const tradeMonitor = new TradeMonitor();
