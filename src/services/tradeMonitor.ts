import fs from 'fs';
import path from 'path';
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
  /** MT5 position ticket (live trades only) */
  ticket?: number;
  lots?: number;
  /** $ at risk if the stop is hit */
  riskAmount?: number;
  /** Portfolio strategy that opened it (e.g. asianBreakout:M30) */
  sleeve?: string;
}

export type ExitReason = 'STOP_LOSS' | 'TAKE_PROFIT';

export class TradeMonitor {
  private openTrades: Map<string, OpenTrade> = new Map();
  /** SL/TP hit during the 30s Quick Strike lockout, to close once the lockout ends. */
  private pendingExits: Map<string, ExitReason> = new Map();
  private readonly file: string | null;

  /** @param dataDir where open trades are persisted (null = memory only, for tests) */
  constructor(dataDir: string | null = config.dataDir) {
    this.file = dataDir ? path.join(dataDir, 'open-trades.json') : null;
  }

  registerTrade(trade: OpenTrade): void {
    this.openTrades.set(trade.tradeId, trade);
    this.save();
    logger.info(`📌 Monitoring ${trade.type} ${trade.pair} (${trade.tradeId})`);
  }

  /**
   * Re-load trades that were open when the process stopped (restart / deploy),
   * so positions keep running until SL/TP instead of being closed on shutdown.
   */
  restore(): OpenTrade[] {
    if (!this.file || !fs.existsSync(this.file)) return [];
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Array<OpenTrade & { openedAt: string }>;
      for (const row of rows) {
        this.openTrades.set(row.tradeId, { ...row, openedAt: new Date(row.openedAt) });
      }
      if (rows.length > 0) logger.info(`♻️ Restored ${rows.length} open trade(s) from ${this.file}`);
      return this.getOpenTrades();
    } catch (error) {
      logger.warn('Could not restore open trades', error);
      return [];
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.getOpenTrades(), null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      logger.warn('Could not persist open trades', error);
    }
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
    trade.pnlPercent = parseFloat(((trade.pnl / (trade.riskAmount || config.riskPerTrade)) * 100).toFixed(1));

    const ageMs = Date.now() - trade.openedAt.getTime();
    const minHoldMs = config.minTradeDurationSeconds * 1000;
    const exit = this.checkExit(trade);

    if (exit) {
      if (ageMs < minHoldMs) {
        if (!this.pendingExits.has(tradeId)) {
          this.pendingExits.set(tradeId, exit);
          logger.debug(
            `⏳ ${trade.pair} ${exit} hit after ${(ageMs / 1000).toFixed(1)}s — ` +
              `holding until the ${config.minTradeDurationSeconds}s minimum`
          );
        }
        return null;
      }
      return exit;
    }

    // Price recovered during the lockout, but the original SL/TP was already hit.
    // Honour that exit once the minimum hold has elapsed.
    if (ageMs >= minHoldMs) {
      const pending = this.pendingExits.get(tradeId);
      if (pending) {
        this.pendingExits.delete(tradeId);
        logger.info(
          `⏳ Minimum hold reached — closing ${trade.pair} at pending ${pending}`
        );
        return pending;
      }
    }

    return null;
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
    this.pendingExits.delete(tradeId);
    this.save();
  }

  /** Live mode: take P&L / price straight from the broker position */
  /** Manual SL/TP change from the dashboard */
  setLevels(tradeId: string, sl: number, tp: number): void {
    const trade = this.openTrades.get(tradeId);
    if (!trade) return;
    trade.stopLoss = sl;
    trade.takeProfit = tp;
    this.save();
  }

  applyBrokerUpdate(tradeId: string, update: { priceCurrent: number; profit: number; sl: number; tp: number }): void {
    const trade = this.openTrades.get(tradeId);
    if (!trade) return;
    trade.currentPrice = update.priceCurrent;
    trade.pnl = parseFloat(update.profit.toFixed(2));
    trade.pnlPercent = parseFloat(((trade.pnl / (trade.riskAmount || config.riskPerTrade)) * 100).toFixed(1));
    trade.stopLoss = update.sl || trade.stopLoss;
    trade.takeProfit = update.tp || trade.takeProfit;
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
