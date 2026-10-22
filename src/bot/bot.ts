import { logger } from '../utils/logger';
import { config } from '../config';
import { marketClient, PriceData } from '../api/market';
import { groqClient } from '../api/groq';
import { EntrySignalGenerator, TradeSignal } from '../strategies/entrySignalGenerator';
import { tradeExecutor } from '../services/tradeExecutor';
import { tradeMonitor, OpenTrade, ExitReason } from '../services/tradeMonitor';
import { riskManager } from '../services/riskManager';
import { tradeJournal } from '../services/tradeJournal';
import { Calculator } from '../utils/calculator';
import { PAIR_LIST, TradingPair } from '../constants/pairs';
import { getZonedTime, formatClock, isWithinTradingSession } from '../utils/time';

const MIN_CANDLES = 26; // 24 for previous range + current + 1 spare

export interface PairSnapshot {
  pair: string;
  bid: number | null;
  ask: number | null;
  spreadPips: number | null;
  prevHigh: number | null;
  prevLow: number | null;
  atrPips: number | null;
  status: string;
  updatedAt: string | null;
}

export interface BotSnapshot {
  running: boolean;
  cycle: number;
  inSession: boolean;
  startedAt: string | null;
  lastCycleAt: string | null;
  pairs: PairSnapshot[];
}

export class TradingBot {
  private isRunning = false;
  private currentCycle = 0;
  private lastSessionState: boolean | null = null;
  private sleepTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private closing = false;
  private startedAt: Date | null = null;
  private lastCycleAt: Date | null = null;
  private pairStatus = new Map<string, PairSnapshot>(
    PAIR_LIST.map((pair) => [
      pair,
      { pair, bid: null, ask: null, spreadPips: null, prevHigh: null, prevLow: null, atrPips: null, status: 'Waiting', updatedAt: null },
    ])
  );

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startedAt = new Date();

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

  getSnapshot(): BotSnapshot {
    return {
      running: this.isRunning,
      cycle: this.currentCycle,
      inSession: isWithinTradingSession(),
      startedAt: this.startedAt?.toISOString() ?? null,
      lastCycleAt: this.lastCycleAt?.toISOString() ?? null,
      pairs: Array.from(this.pairStatus.values()).map((p) => ({ ...p })),
    };
  }

  private async validateSetup(): Promise<void> {
    await marketClient.validateConnection();
    await groqClient.validateConnection();
    if (config.aiReviewEnabled) {
      logger.info(groqClient.isConfigured() ? '🧠 AI signal review: ENABLED (Groq)' : '⚠️ AI signal review enabled but GROQ_API_KEY is missing');
    }
    logger.info(`Mode: ${tradeExecutor.isDryRun ? 'PAPER (DRY_RUN=true)' : 'LIVE'}`);
    logger.info(`Trading pairs: ${PAIR_LIST.join(', ')} (all other pairs disabled)`);
    logger.info(
      `Rules: max ${config.maxTradesPerDay}/day | risk ${config.riskPercent}% ($${config.riskPerTrade}) | ` +
        `1:2 RR | no hedging | min hold ${config.minTradeDurationSeconds}s`
    );
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
        } else {
          if (tradeMonitor.getOpenTrades().length > 0) {
            await this.closeAllPositions('Session ended');
          }
          await this.refreshQuotes('Session closed');
        }
        this.lastCycleAt = new Date();
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

  private updatePair(pair: string, patch: Partial<PairSnapshot>): void {
    const current = this.pairStatus.get(pair);
    if (!current) return;
    this.pairStatus.set(pair, { ...current, ...patch, updatedAt: new Date().toISOString() });
  }

  private quotePatch(price: PriceData): Partial<PairSnapshot> {
    return { bid: price.bid, ask: price.ask, spreadPips: price.spread };
  }

  /** Keep prices on the dashboard fresh while not trading */
  private async refreshQuotes(status: string): Promise<void> {
    for (const pair of PAIR_LIST) {
      try {
        const price = await marketClient.getCurrentPrice(pair);
        this.updatePair(pair, { ...this.quotePatch(price), status });
      } catch (error) {
        logger.debug(`Quote refresh failed for ${pair}`, error);
      }
    }
  }

  private async scanAllPairs(): Promise<void> {
    for (const pair of PAIR_LIST) {
      if (!this.isRunning) return;
      try {
        await this.scanPair(pair);
      } catch (error) {
        this.updatePair(pair, { status: 'Error while scanning' });
        logger.error(`Error scanning ${pair}`, error);
      }
    }
  }

  private async scanPair(pair: TradingPair): Promise<void> {
    const price = await marketClient.getCurrentPrice(pair);
    this.updatePair(pair, this.quotePatch(price));

    if (tradeMonitor.getOpenTrades().length > 0) {
      this.updatePair(pair, { status: 'Position open (no hedging)' });
      return;
    }

    const risk = riskManager.canPlaceTrade(
      tradeMonitor.calculateTotalPnL(),
      tradeJournal.getSummary().totalPnL
    );
    if (!risk.allowed) {
      this.updatePair(pair, { status: `Blocked: ${risk.reason}` });
      return;
    }

    const candles = await marketClient.getCandles(pair, '1H', 50);
    if (candles.length < MIN_CANDLES) {
      this.updatePair(pair, { status: `Warming up (${candles.length}/${MIN_CANDLES} candles)` });
      return;
    }

    // Previous 24 completed 1H candles = "yesterday's" range
    const range = candles.slice(-25, -1);
    const prevHigh = Math.max(...range.map((c) => c.high));
    const prevLow = Math.min(...range.map((c) => c.low));
    const atrPips = await marketClient.calculateATR(pair, 14);
    this.updatePair(pair, { prevHigh, prevLow, atrPips });

    const signal = EntrySignalGenerator.generateTradeSignal(pair, price, prevHigh, prevLow, candles, atrPips);
    if (signal.signal === 'SKIP') {
      this.updatePair(pair, { status: signal.reasoning.replace(/^Skipped:\s*/, '') });
      return;
    }

    if (!(await this.reviewWithAI(signal, atrPips))) {
      this.updatePair(pair, { status: 'AI review rejected signal' });
      return;
    }

    const result = await tradeExecutor.executeTrade(signal);
    if (!result.success || !result.tradeId || !result.quantity || result.executedPrice === undefined) {
      const reason = result.error ?? result.message;
      this.updatePair(pair, { status: `Order rejected: ${reason}` });
      logger.warn(`Trade not opened for ${pair}: ${reason}`);
      return;
    }

    const trade: OpenTrade = {
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
    };
    tradeMonitor.registerTrade(trade);
    tradeJournal.recordOpen(trade);
    riskManager.recordTradeOpened();
    this.updatePair(pair, { status: `${trade.type} opened` });
  }

  /**
   * Optional LLM review of a strategy signal. Fails open: if AI review is
   * disabled, unconfigured, or errors, the deterministic signal is kept.
   */
  private async reviewWithAI(signal: TradeSignal, atrPips: number): Promise<boolean> {
    if (!config.aiReviewEnabled) return true;
    if (!groqClient.isConfigured()) return true;

    const prompt = [
      `Pair: ${signal.pair}`,
      `Proposed side: ${signal.signal}`,
      `Entry: ${signal.entryPrice}`,
      `Stop loss: ${signal.stopLoss}`,
      `Take profit: ${signal.takeProfit}`,
      `Risk/reward: 1:${signal.riskRewardRatio}`,
      `ATR(14): ${atrPips.toFixed(1)} pips`,
      `Breakout strength: ${signal.components.breakout.strength}/100`,
      `Price action: ${signal.components.priceAction.pattern} (${signal.components.priceAction.direction})`,
      `Nearest support: ${signal.components.supportResistance.support?.level ?? 'none'}`,
      `Nearest resistance: ${signal.components.supportResistance.resistance?.level ?? 'none'}`,
      'Fixed risk: $30 per trade. Reject setups that contradict the breakout or sit directly into a nearby level.',
    ].join('\n');

    try {
      const review = await groqClient.analyzeTradeOpportunity(prompt);
      logger.info(`🧠 AI review: ${review.decision} (${review.confidence}) — ${review.reasoning}`);
      if (review.decision === 'SKIP') return false;
      if (review.decision !== signal.signal) return false;
      return review.confidence >= config.aiMinConfidence;
    } catch (error) {
      logger.warn('AI review failed — continuing with strategy signal', error);
      return true;
    }
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
    tradeJournal.recordClose(trade.tradeId, closePrice, pnl, reason);
    riskManager.recordTradeClosed(pnl);
    this.updatePair(trade.pair, { status: `Closed (${reason})` });
  }

  /** Close every open position at the current market price */
  async closeAllPositions(reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      const open = tradeMonitor.getOpenTrades();
      if (open.length === 0) return;

      // FundedNext Quick Strike rule: do not close a trade under 30 seconds.
      const minAgeMs = config.minTradeDurationSeconds * 1000;
      const waitMs = Math.max(
        0,
        ...open.map((trade) => minAgeMs - (Date.now() - trade.openedAt.getTime()))
      );
      if (waitMs > 0) {
        logger.info(
          `⏳ Minimum trade duration ${config.minTradeDurationSeconds}s — waiting ${Math.ceil(waitMs / 1000)}s before closing`
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

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
