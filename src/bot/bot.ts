import { logger } from '../utils/logger';
import { config } from '../config';
import { marketClient } from '../api/market';
import { claudeClient } from '../api/claude';
import { EntrySignalGenerator } from '../strategies/entrySignalGenerator';
import { tradeExecutor } from '../services/tradeExecutor';
import { tradeMonitor, OpenTrade, ExitReason } from '../services/tradeMonitor';
import { riskManager } from '../services/riskManager';
import { Calculator } from '../utils/calculator';
import { PAIR_LIST, TradingPair } from '../constants/pairs';
import { getZonedTime, formatClock, isWithinTradingSession } from '../utils/time';

const MIN_CANDLES = 26; // 24 for previous range + current + 1 spare

export class TradingBot {
  private isRunning = false;
  private currentCycle = 0;
  private lastSessionState: boolean | null = null;
  private sleepTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private closing = false;

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('🤖 Trading bot starting...');
    try {
      await this.validateSetup();
      await this.mainLoop();
    } catch (error) {
      logger.error('Bot stopped due to fatal error', error);
      this.isRunning = false;
    }
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.wake?.();
    logger.info('🛑 Bot loop stopped');
  }

  get running(): boolean {
    return this.isRunning;
  }

  private async validateSetup(): Promise<void> {
    await marketClient.validateConnection();
    await claudeClient.validateConnection();
    logger.info(`Mode: ${tradeExecutor.isDryRun ? 'PAPER (DRY_RUN=true)' : 'LIVE'}`);
    logger.info(
      `Session: ${String(config.londonOpenHour).padStart(2, '0')}:${String(config.londonOpenMinute).padStart(2, '0')}–` +
        `${String(config.londonCloseHour).padStart(2, '0')}:${String(config.londonCloseMinute).padStart(2, '0')} ` +
        `${config.timezone}, Mon–Fri | Cycle every ${config.cycleIntervalSeconds}s`
    );
  }

  private async mainLoop(): Promise<void> {
    while (this.isRunning) {
      this.currentCycle++;
      const started = Date.now();

      try {
        const inSession = isWithinTradingSession();
        this.logSessionChange(inSession);

        if (inSession) {
          await this.monitorPositions();
          await this.scanAllPairs();
          this.logCycleStats(Date.now() - started);
        } else if (tradeMonitor.getOpenTrades().length > 0) {
          await this.closeAllPositions('Session ended');
        }
      } catch (error) {
        logger.error('Error in main loop', error);
      }

      await this.sleep(config.cycleIntervalSeconds * 1000);
    }
  }

  private logSessionChange(inSession: boolean): void {
    if (this.lastSessionState === inSession) return;
    this.lastSessionState = inSession;
    const now = formatClock(getZonedTime());
    if (inSession) {
      logger.info(`📈 London session OPEN (${now} ${config.timezone}) — scanning ${PAIR_LIST.join(', ')}`);
    } else {
      logger.info(`⏸️ Outside trading session (${now} ${config.timezone}) — waiting`);
    }
  }

  private async scanAllPairs(): Promise<void> {
    for (const pair of PAIR_LIST) {
      if (!this.isRunning) return;
      try {
        await this.scanPair(pair);
      } catch (error) {
        logger.error(`Error scanning ${pair}`, error);
      }
    }
  }

  private async scanPair(pair: TradingPair): Promise<void> {
    if (tradeMonitor.hasOpenTrade(pair)) return;

    const risk = riskManager.canPlaceTrade(tradeMonitor.calculateTotalPnL());
    if (!risk.allowed) {
      logger.debug(`Trade blocked: ${risk.reason}`);
      return;
    }

    const price = await marketClient.getCurrentPrice(pair);
    const candles = await marketClient.getCandles(pair, '1H', 50);
    if (candles.length < MIN_CANDLES) {
      logger.debug(`Not enough candles for ${pair} (${candles.length})`);
      return;
    }

    // Previous 24 completed 1H candles = "yesterday's" range
    const range = candles.slice(-25, -1);
    const prevHigh = Math.max(...range.map((c) => c.high));
    const prevLow = Math.min(...range.map((c) => c.low));
    const atrPips = await marketClient.calculateATR(pair, 14);

    const signal = EntrySignalGenerator.generateTradeSignal(pair, price, prevHigh, prevLow, candles, atrPips);
    if (signal.signal === 'SKIP') return;

    const result = await tradeExecutor.executeTrade(signal);
    if (!result.success || !result.tradeId || !result.quantity || result.executedPrice === undefined) {
      logger.warn(`Trade not opened for ${pair}: ${result.error ?? result.message}`);
      return;
    }

    tradeMonitor.registerTrade({
      tradeId: result.tradeId,
      pair,
      type: signal.signal === 'BUY' ? 'BUY' : 'SELL',
      entryPrice: result.executedPrice,
      currentPrice: result.executedPrice,
      quantity: result.quantity,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      pnl: 0,
      pnlPercent: 0,
      openedAt: result.executedAt ?? new Date(),
    });
    riskManager.recordTradeOpened();
  }

  private async monitorPositions(): Promise<void> {
    for (const trade of tradeMonitor.getOpenTrades()) {
      try {
        const quote = await marketClient.getCurrentPrice(trade.pair);
        const exit = tradeMonitor.updateTradePrice(trade.tradeId, quote);
        if (exit) {
          await this.closeAtLevel(trade, exit);
        }
      } catch (error) {
        logger.error(`Error monitoring ${trade.tradeId}`, error);
      }
    }

    const total = riskManager.getStatus().dailyLossAmount + tradeMonitor.calculateTotalPnL();
    if (total <= -config.maxDailyLoss && tradeMonitor.getOpenTrades().length > 0) {
      logger.error(`❌ DAILY LOSS LIMIT HIT ($${total.toFixed(2)}). Closing all positions.`);
      await this.closeAllPositions('Daily loss limit reached');
    }
  }

  /** Close at the SL/TP level that was hit */
  private async closeAtLevel(trade: OpenTrade, reason: ExitReason): Promise<void> {
    const closePrice = reason === 'STOP_LOSS' ? trade.stopLoss : trade.takeProfit;
    const pnl = Calculator.calculatePnL(trade.entryPrice, closePrice, trade.quantity, trade.type);
    logger.info(`${reason === 'TAKE_PROFIT' ? '🎉 TP' : '⛔ SL'} hit on ${trade.pair}`);
    await this.closePosition(trade, closePrice, pnl, reason);
  }

  private async closePosition(trade: OpenTrade, closePrice: number, pnl: number, reason: string): Promise<void> {
    const result = await tradeExecutor.closeTrade(trade.tradeId, closePrice, reason);
    if (!result.success) {
      logger.error(`Failed to close ${trade.tradeId}: ${result.message}`);
      return;
    }
    tradeMonitor.removeTrade(trade.tradeId);
    riskManager.recordTradeClosed(pnl);
  }

  /** Close every open position at the current market price */
  async closeAllPositions(reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      const open = tradeMonitor.getOpenTrades();
      if (open.length === 0) return;
      logger.warn(`🔴 Closing ${open.length} position(s): ${reason}`);

      for (const trade of open) {
        try {
          const quote = await marketClient.getCurrentPrice(trade.pair);
          tradeMonitor.updateTradePrice(trade.tradeId, quote);
          await this.closePosition(trade, trade.currentPrice, trade.pnl, reason);
        } catch (error) {
          logger.error(`Error closing ${trade.tradeId}`, error);
        }
      }
    } finally {
      this.closing = false;
    }
  }

  private logCycleStats(durationMs: number): void {
    if (this.currentCycle % 10 !== 0) return;
    const stats = tradeMonitor.getStatistics();
    const risk = riskManager.getStatus();
    logger.info(
      `📊 Cycle #${this.currentCycle} (${durationMs}ms) | Open ${stats.openTrades} | ` +
        `Unrealized $${stats.totalPnL.toFixed(2)} | Realized $${risk.dailyLossAmount.toFixed(2)} | ` +
        `Trades ${risk.tradesExecuted}/${config.maxTradesPerDay}`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = null;
        this.sleepTimer = null;
        resolve();
      };
      this.sleepTimer = setTimeout(() => this.wake?.(), ms);
    });
  }
}

export const bot = new TradingBot();
