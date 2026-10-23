import { logger } from '../utils/logger';
import { config, TIMEFRAME_MINUTES } from '../config';
import { marketClient, PriceData, CandleData, computeAtrPips } from '../api/market';
import { mt5Bridge } from '../api/mt5Bridge';
import { groqClient, GroqUnavailableError } from '../api/groq';
import { EntrySignalGenerator, TradeSignal, StrategyParams, defaultStrategyParams, minClosedCandles } from '../strategies/entrySignalGenerator';
import { computeIndicators, INDICATOR_WARMUP } from '../strategies/indicators';
import { evaluateStrategy, isSignal } from '../strategies/library';
import { tradeExecutor } from '../services/tradeExecutor';
import { tradeMonitor, OpenTrade, ExitReason } from '../services/tradeMonitor';
import { riskManager } from '../services/riskManager';
import { tradeJournal } from '../services/tradeJournal';
import { notifier } from '../services/notifier';
import { Calculator } from '../utils/calculator';
import { PAIR_LIST, TradingPair, getPairSpec } from '../constants/pairs';
import { getZonedTime, formatClock, isWithinTradingSession, isWeekend } from '../utils/time';

const HOUR_MS = 60 * 60 * 1000;
const TF_MS = TIMEFRAME_MINUTES[config.entryTimeframe] * 60 * 1000;
/** A breakout candle is only traded within this many minutes after it closes (max half a candle) */
export const ENTRY_WINDOW_MINUTES = Math.min(15, TIMEFRAME_MINUTES[config.entryTimeframe] / 2);

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
  dataFeedOk: boolean;
  pairs: PairSnapshot[];
}

type AiVerdict = 'approved' | 'rejected' | 'unavailable';

export class TradingBot {
  private isRunning = false;
  private currentCycle = 0;
  private lastSessionState: boolean | null = null;
  private sleepTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;
  private closing = false;
  private startedAt: Date | null = null;
  private lastCycleAt: Date | null = null;
  private feedOk = true;
  /** Last closed candle already evaluated per pair (one decision per 1H candle) */
  private evaluatedCandle = new Map<string, string>();
  private lastRiskReason = '';
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
      void notifier.notify('error', `Bot stopped: ${(error as Error).message}`);
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
      dataFeedOk: this.feedOk,
      pairs: Array.from(this.pairStatus.values()).map((p) => ({ ...p })),
    };
  }

  private async validateSetup(): Promise<void> {
    const feedOk = await marketClient.validateConnection();
    if (!feedOk) {
      void notifier.notify('error', `MT5 bridge not reachable at startup (${config.mt5BridgeUrl}). Will keep retrying.`, 'feed-down');
      this.feedOk = false;
    }

    if (config.aiReviewEnabled) {
      const groqOk = await groqClient.validateConnection();
      if (!groqOk) {
        void notifier.notify(
          'error',
          groqClient.isConfigured()
            ? 'Groq not reachable at startup — signals will be skipped until it answers.'
            : 'No Groq API key configured — every signal will be skipped (AI review is fail-closed).',
          'groq-down'
        );
      }
    } else {
      logger.warn('⚠️ AI_REVIEW_ENABLED=false — trading on strategy rules only');
    }

    const blocked = tradeExecutor.liveBlockedReason;
    if (blocked) {
      logger.error(`❌ ${blocked}`);
      void notifier.notify('error', blocked);
    }

    // Positions survive restarts: paper trades from disk, live trades from the broker
    tradeMonitor.restore();
    if (!tradeExecutor.isDryRun && !marketClient.isSimulated) {
      await this.syncLivePositions(true).catch((error) => logger.error('Initial MT5 position sync failed', error));
    }

    logger.info(
      `Mode: ${tradeExecutor.isDryRun ? 'PAPER (DRY_RUN=true)' : 'LIVE'} | Data: ${marketClient.name} | ` +
        `AI review: ${config.aiReviewEnabled ? `ON (${groqClient.keyCount} key(s), fail-${config.aiFailOpen ? 'open' : 'closed'})` : 'OFF'}`
    );
    logger.info(`Trading pairs: ${PAIR_LIST.join(', ')}`);
    logger.info(
      `Rules: max ${config.maxTradesPerDay}/day | risk ${config.riskPercent}% ($${config.riskPerTrade}) | ` +
        `1:${config.profitRatio} RR | exits: SL/TP only | min hold ${config.minTradeDurationSeconds}s`
    );
    logger.info(
      `Challenge: Phase ${config.challengePhase} | target ${config.profitTargetPercent}% ($${config.targetProfit}) | ` +
        `min ${config.minTradingDaysPerPhase} trading days/phase` +
        (config.phaseStartDate ? ` since ${config.phaseStartDate}` : '')
    );
    void notifier.notify(
      'info',
      `Started — ${tradeExecutor.isDryRun ? 'PAPER' : 'LIVE'} on ${marketClient.name} data, ` +
        `${PAIR_LIST.join(', ')}, risk $${config.riskPerTrade}/trade, open trades: ${tradeMonitor.getOpenTrades().length}`
    );
  }

  private async mainLoop(): Promise<void> {
    while (this.isRunning) {
      this.currentCycle++;
      const started = Date.now();

      try {
        const inSession = isWithinTradingSession();
        this.logSessionChange(inSession);

        if (tradeMonitor.getOpenTrades().length > 0 && !isWeekend()) {
          await this.monitorPositions();
        }

        if (inSession) {
          await this.scanAllPairs();
          this.logCycleStats(Date.now() - started);
        } else {
          await this.refreshQuotes(isWeekend() ? 'Weekend — market closed' : 'Outside session');
        }
        this.lastCycleAt = new Date();
        this.markFeed(true);
      } catch (error) {
        logger.error('Error in main loop', error);
        this.markFeed(false, error);
      }

      await this.sleep(config.cycleIntervalSeconds * 1000);
    }
  }

  /** Alert once when the data feed (MT5 bridge) goes down, and once when it recovers */
  private markFeed(ok: boolean, error?: unknown): void {
    if (ok && !this.feedOk) {
      this.feedOk = true;
      notifier.reset('feed-down');
      void notifier.notify('success', `${marketClient.name} data feed recovered`);
    } else if (!ok && marketClient.name === 'MT5') {
      this.feedOk = false;
      void notifier.notify('error', `MT5 bridge error: ${(error as Error)?.message ?? error}`, 'feed-down', 30 * 60 * 1000);
    }
  }

  private logSessionChange(inSession: boolean): void {
    if (this.lastSessionState === inSession) return;
    this.lastSessionState = inSession;
    const now = formatClock(getZonedTime());
    if (inSession) {
      logger.info(`📈 London session OPEN (${now} ${config.timezone}) — scanning ${PAIR_LIST.join(', ')}`);
    } else {
      logger.info(`⏸️ Outside trading session (${now} ${config.timezone}) — open trades stay on SL/TP`);
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

  private async refreshQuotes(status: string): Promise<void> {
    for (const pair of PAIR_LIST) {
      const price = await marketClient.getCurrentPrice(pair);
      const open = tradeMonitor.getOpenTrades().length > 0;
      this.updatePair(pair, { ...this.quotePatch(price), status: open ? `${status} — position open (SL/TP)` : status });
    }
  }

  private async scanAllPairs(): Promise<void> {
    for (const pair of PAIR_LIST) {
      if (!this.isRunning) return;
      await this.scanPair(pair);
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
      tradeJournal.getPhaseSummary().totalPnL,
      tradeJournal.getTradingDays()
    );
    if (!risk.allowed) {
      this.updatePair(pair, { status: `Blocked: ${risk.reason}` });
      if (risk.reason !== this.lastRiskReason) {
        this.lastRiskReason = risk.reason;
        if (!/^Max \d+ trades/.test(risk.reason)) {
          void notifier.notify('warn', `Trading paused: ${risk.reason}`, `risk-${risk.reason}`, 12 * HOUR_MS);
        }
      }
      return;
    }
    this.lastRiskReason = '';

    const params = defaultStrategyParams();
    const useLibrary = config.strategy !== 'breakout';
    const needed = useLibrary ? INDICATOR_WARMUP + 5 : minClosedCandles(params.rangeBars);
    const candles = await marketClient.getCandles(pair, config.entryTimeframe, needed + 40);
    const closed = candles.filter((c) => c.closed !== false);
    if (closed.length < needed) {
      this.updatePair(pair, { status: `Warming up (${closed.length}/${needed} candles)` });
      return;
    }

    const spec = getPairSpec(pair);
    const atrPips = computeAtrPips(closed, spec.pipSize, 14);
    const range = config.rangeMode === 'prevDay' ? await this.previousDayRange(pair) : undefined;
    const rangeBars = closed.slice(-(params.rangeBars + 1), -1);
    const prevHigh = range?.high ?? Math.max(...rangeBars.map((c) => c.high));
    const prevLow = range?.low ?? Math.min(...rangeBars.map((c) => c.low));
    this.updatePair(pair, { prevHigh, prevLow, atrPips });

    const last = closed[closed.length - 1];
    const candleKey = last.timestamp.toISOString();
    if (this.evaluatedCandle.get(pair) === candleKey) {
      this.updatePair(pair, { status: `Waiting for next ${config.entryTimeframe} candle close` });
      return;
    }

    // Only act on a candle that closed in the last few minutes (e.g. not one from before a restart)
    const ageMin = this.candleCloseAgeMinutes(last, price);
    if (ageMin > ENTRY_WINDOW_MINUTES) {
      this.evaluatedCandle.set(pair, candleKey);
      this.updatePair(pair, { status: `Last candle closed ${ageMin.toFixed(0)} min ago — waiting for next close` });
      return;
    }

    const signal = useLibrary
      ? this.librarySignal(pair, price, closed, params)
      : EntrySignalGenerator.generateTradeSignal({ pair, quote: price, candles: closed, atrPips, range }, params);
    if (signal.signal === 'SKIP') {
      // A wide spread can be temporary: allow a re-check within the entry window
      if (!/^Skipped: Spread/.test(signal.reasoning)) this.evaluatedCandle.set(pair, candleKey);
      this.updatePair(pair, { status: signal.reasoning.replace(/^Skipped:\s*/, '') });
      return;
    }

    const verdict = await this.reviewWithAI(signal, atrPips);
    if (verdict === 'unavailable') {
      // Fail-closed: no trade now; retried next cycle while still inside the entry window
      this.updatePair(pair, { status: 'AI review unavailable — trade skipped (retrying)' });
      return;
    }
    this.evaluatedCandle.set(pair, candleKey);
    if (verdict === 'rejected') {
      this.updatePair(pair, { status: 'AI review rejected signal' });
      return;
    }

    const result = await tradeExecutor.executeTrade(signal);
    if (!result.success || !result.tradeId || !result.quantity || result.executedPrice === undefined) {
      const reason = result.error ?? result.message;
      this.updatePair(pair, { status: `Order rejected: ${reason}` });
      logger.warn(`Trade not opened for ${pair}: ${reason}`);
      void notifier.notify('error', `Order for ${signal.signal} ${pair} rejected: ${reason}`, `order-reject-${reason}`, 30 * 60 * 1000);
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
      ticket: result.ticket,
      lots: result.lots,
      riskAmount: result.riskAmount,
    };
    tradeMonitor.registerTrade(trade);
    tradeJournal.recordOpen(trade);
    riskManager.recordTradeOpened();
    this.updatePair(pair, { status: `${trade.type} opened` });
    void notifier.notify(
      'info',
      `${tradeExecutor.isDryRun ? '[PAPER] ' : ''}${trade.type} ${result.lots} lot ${pair} @ ${trade.entryPrice}\n` +
        `SL ${trade.stopLoss} | TP ${trade.takeProfit} | risk $${result.riskAmount}`
    );
  }

  /** Minutes since the given closed candle closed (handles the MT5 server-time offset) */
  /** MT5 bar/tick times are broker server time written as UTC; estimate the offset from the tick */
  private serverOffsetMs(quote: PriceData): number {
    if (marketClient.isSimulated) return 0;
    const raw = quote.timestamp.getTime() - Date.now();
    return Math.round(raw / (30 * 60 * 1000)) * 30 * 60 * 1000;
  }

  /** Minutes since the given closed candle closed */
  private candleCloseAgeMinutes(candle: CandleData, quote: PriceData): number {
    const closeAt = candle.timestamp.getTime() + TF_MS - this.serverOffsetMs(quote);
    return (Date.now() - closeAt) / 60000;
  }

  /** Signal from the strategy library (STRATEGY other than breakout), as a TradeSignal */
  private librarySignal(pair: string, quote: PriceData, closed: CandleData[], params: StrategyParams): TradeSignal {
    const i = closed.length - 1;
    const offset = this.serverOffsetMs(quote);
    const candleTime = closed[i].timestamp.toISOString();
    const r = evaluateStrategy(config.strategy, {
      pair,
      candles: closed,
      i,
      ind: computeIndicators(closed),
      quote,
      tfMinutes: TIMEFRAME_MINUTES[config.entryTimeframe],
      rewardRatio: config.profitRatio,
      slMinAtr: config.slMinAtr,
      slMaxAtr: config.slMaxAtr,
      // MIN_ATR_PIPS is the H1 value; scale by √time like the backtest (M30 ≈ 0.71×, M15 = 0.5×)
      minAtrPips: config.minAtrPips * Math.sqrt(TIMEFRAME_MINUTES[config.entryTimeframe] / 60),
      maxSpreadPips: config.maxSpreadPips,
      breakout: params,
      toUtc: (d) => new Date(d.getTime() - offset),
    });
    if (!isSignal(r)) return EntrySignalGenerator.skipSignal(pair, r.skip, candleTime);
    if (r.exit === 'supertrend') {
      // trailing / flip exits are backtest-only for now — never open a trade without its exit logic
      return EntrySignalGenerator.skipSignal(pair, 'Supertrend trailing exit not available in the live bot yet (backtest only)', candleTime);
    }

    const base = EntrySignalGenerator.skipSignal(pair, '', candleTime);
    const dir = r.side === 'BUY' ? 'UP' : 'DOWN';
    logger.info(`🎯 Signal ${r.side} ${pair} [${config.strategy}]`, { entry: r.entryPrice, sl: r.stopLoss, tp: r.takeProfit, candle: candleTime });
    return {
      ...base,
      signal: r.side,
      entryPrice: r.entryPrice,
      stopLoss: r.stopLoss,
      takeProfit: r.takeProfit,
      riskRewardRatio: config.profitRatio,
      confidence: 0.6,
      reasoning: `[${config.strategy}] ${r.reason}`,
      meta: {
        rangeHigh: Math.max(...closed.slice(-25, -1).map((c) => c.high)),
        rangeLow: Math.min(...closed.slice(-25, -1).map((c) => c.low)),
        atrPips: computeAtrPips(closed, getPairSpec(pair).pipSize, 14),
        spreadPips: quote.spread,
        slDistance: Math.abs(r.entryPrice - r.stopLoss),
      },
      components: { ...base.components, priceAction: { ...base.components.priceAction, pattern: config.strategy, direction: dir, description: r.reason } },
    };
  }

  private async previousDayRange(pair: string): Promise<{ high: number; low: number } | undefined> {
    const days = (await marketClient.getCandles(pair, 'D1', 3)).filter((d) => d.closed !== false);
    const prev = days[days.length - 1];
    return prev ? { high: prev.high, low: prev.low } : undefined;
  }

  /**
   * Groq review of a strategy signal.
   * - approved: Groq agrees with the side and confidence ≥ AI_MIN_CONFIDENCE
   * - rejected: Groq says SKIP / opposite side / low confidence
   * - unavailable: every key failed → trade skipped (fail-closed) unless AI_REVIEW_FAIL_MODE=open
   */
  private async reviewWithAI(signal: TradeSignal, atrPips: number): Promise<AiVerdict> {
    if (!config.aiReviewEnabled) return 'approved';

    const prompt = [
      `Instrument: ${signal.pair} (gold, 1 pip = 0.1), ${config.entryTimeframe} candles`,
      `Strategy: ${config.strategy} — ${signal.reasoning}`,
      `Proposed side: ${signal.signal}`,
      `Entry: ${signal.entryPrice}`,
      `Stop loss: ${signal.stopLoss}`,
      `Take profit: ${signal.takeProfit}`,
      `Risk/reward: 1:${signal.riskRewardRatio}`,
      `Broken range (${config.rangeMode === 'prevDay' ? 'previous day' : `last ${config.rangeHours}h`}): ${signal.meta?.rangeLow} – ${signal.meta?.rangeHigh}`,
      `ATR(14, ${config.entryTimeframe}): ${atrPips.toFixed(1)} pips | spread ${signal.meta?.spreadPips} pips`,
      `Breakout strength: ${signal.components.breakout.strength}/100`,
      `Price action: ${signal.components.priceAction.pattern} (${signal.components.priceAction.direction})`,
      `Nearest support: ${signal.components.supportResistance.support?.level ?? 'none'}`,
      `Nearest resistance: ${signal.components.supportResistance.resistance?.level ?? 'none'}`,
      `Fixed risk: $${config.riskPerTrade} per trade (${config.riskPercent}% of $${config.accountBalance}). ` +
        'Reject setups that contradict the strategy logic or run straight into a nearby level.',
    ].join('\n');

    try {
      const review = await groqClient.analyzeTradeOpportunity(prompt);
      notifier.reset('groq-down');
      logger.info(`🧠 AI review: ${review.decision} (${review.confidence}) — ${review.reasoning}`);
      if (review.decision === 'SKIP' || review.decision !== signal.signal) return 'rejected';
      return review.confidence >= config.aiMinConfidence ? 'approved' : 'rejected';
    } catch (error) {
      const message = error instanceof GroqUnavailableError ? error.message : `Groq review failed: ${(error as Error).message}`;
      if (config.aiFailOpen) {
        logger.warn(`${message} — AI_REVIEW_FAIL_MODE=open, continuing with strategy signal`);
        return 'approved';
      }
      logger.error(`${message} — trade skipped (fail-closed)`);
      void notifier.notify('error', `Groq unavailable — ${signal.signal} ${signal.pair} signal skipped.\n${message}`, 'groq-down', 30 * 60 * 1000);
      return 'unavailable';
    }
  }

  private async monitorPositions(): Promise<void> {
    if (!tradeExecutor.isDryRun && !marketClient.isSimulated) {
      await this.syncLivePositions();
    } else {
      for (const trade of tradeMonitor.getOpenTrades()) {
        const quote = await marketClient.getCurrentPrice(trade.pair);
        const exit = tradeMonitor.updateTradePrice(trade.tradeId, quote);
        if (exit) await this.closeAtLevel(trade, exit);
      }
    }

    const total = riskManager.getStatus().dailyLossAmount + tradeMonitor.calculateTotalPnL();
    if (total <= -config.maxDailyLoss && tradeMonitor.getOpenTrades().length > 0) {
      logger.error(`❌ DAILY LOSS LIMIT HIT ($${total.toFixed(2)}). Closing all positions.`);
      void notifier.notify('error', `Daily loss limit hit ($${total.toFixed(2)}) — closing all positions`);
      await this.closeAllPositions('Daily loss limit reached');
    }
  }

  /**
   * LIVE: SL/TP live on the broker. Update P&L from MT5 positions; a tracked ticket
   * that disappeared was closed by the broker → read the realized result from history.
   * With `adopt`, positions carrying our magic number that we don't track are adopted (after a crash).
   */
  async syncLivePositions(adopt: boolean = false): Promise<void> {
    const positions = await mt5Bridge.positions(config.mt5Magic);
    const byTicket = new Map(positions.map((p) => [p.ticket, p]));

    for (const trade of tradeMonitor.getOpenTrades()) {
      if (trade.ticket === undefined) continue;
      const pos = byTicket.get(trade.ticket);
      if (pos) {
        tradeMonitor.applyBrokerUpdate(trade.tradeId, pos);
        continue;
      }
      const history = await mt5Bridge.positionHistory(trade.ticket);
      if (!history.closed) {
        logger.warn(`Ticket ${trade.ticket} not in positions and no closing deal yet — will re-check`);
        continue;
      }
      const reason = history.exitReason ?? 'CLOSED';
      const exitPrice = history.exitPrice ?? trade.currentPrice;
      const pnl = history.profit ?? Calculator.calculatePnL(trade.entryPrice, exitPrice, trade.quantity, trade.type);
      this.finalizeClose(trade, exitPrice, pnl, reason);
    }

    if (adopt) {
      const tracked = new Set(tradeMonitor.getOpenTrades().map((t) => t.ticket));
      for (const p of positions) {
        if (tracked.has(p.ticket)) continue;
        const contract = (await marketClient.getSymbolSpec(p.symbol)).contractSize;
        const trade: OpenTrade = {
          tradeId: `MT5_${p.ticket}`,
          pair: p.symbol,
          type: p.side,
          entryPrice: p.priceOpen,
          currentPrice: p.priceCurrent,
          quantity: p.volume * contract,
          stopLoss: p.sl,
          takeProfit: p.tp,
          pnl: p.profit,
          pnlPercent: 0,
          openedAt: new Date(Date.now() - config.minTradeDurationSeconds * 1000),
          ticket: p.ticket,
          lots: p.volume,
          riskAmount: Math.abs(p.priceOpen - p.sl) * p.volume * contract,
        };
        tradeMonitor.registerTrade(trade);
        logger.warn(`♻️ Adopted untracked MT5 position ${p.ticket} (${p.side} ${p.volume} ${p.symbol})`);
      }
    }
  }

  /** PAPER: close at the SL/TP level that was hit */
  private async closeAtLevel(trade: OpenTrade, reason: ExitReason): Promise<void> {
    const closePrice = reason === 'STOP_LOSS' ? trade.stopLoss : trade.takeProfit;
    const pnl = Calculator.calculatePnL(trade.entryPrice, closePrice, trade.quantity, trade.type);
    logger.info(`${reason === 'TAKE_PROFIT' ? '🎉 TP' : '⛔ SL'} hit on ${trade.pair}`);
    const result = await tradeExecutor.closeTrade(trade.tradeId, closePrice, reason);
    if (!result.success) {
      logger.error(`Failed to close ${trade.tradeId}: ${result.message}`);
      return;
    }
    this.finalizeClose(trade, closePrice, pnl, reason);
  }

  private finalizeClose(trade: OpenTrade, exitPrice: number, pnl: number, reason: string): void {
    tradeMonitor.removeTrade(trade.tradeId);
    tradeJournal.recordClose(trade.tradeId, exitPrice, pnl, reason);
    riskManager.recordTradeClosed(pnl);
    this.updatePair(trade.pair, { status: `Closed (${reason})` });
    void notifier.notify(
      pnl >= 0 ? 'success' : 'warn',
      `${tradeExecutor.isDryRun ? '[PAPER] ' : ''}${trade.type} ${trade.pair} closed (${reason}) @ ${exitPrice}\n` +
        `P&L $${pnl.toFixed(2)} | today $${riskManager.getStatus().dailyLossAmount.toFixed(2)}`
    );
  }

  /** Close every open position at market (daily loss limit / manual) */
  async closeAllPositions(reason: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      const open = tradeMonitor.getOpenTrades();
      if (open.length === 0) return;

      // FundedNext Quick Strike rule: do not close a trade under 30 seconds.
      const minAgeMs = config.minTradeDurationSeconds * 1000;
      const waitMs = Math.max(0, ...open.map((trade) => minAgeMs - (Date.now() - trade.openedAt.getTime())));
      if (waitMs > 0) {
        logger.info(`⏳ Minimum trade duration ${config.minTradeDurationSeconds}s — waiting ${Math.ceil(waitMs / 1000)}s before closing`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      logger.warn(`🔴 Closing ${open.length} position(s): ${reason}`);
      for (const trade of open) {
        try {
          const quote = await marketClient.getCurrentPrice(trade.pair);
          tradeMonitor.updateTradePrice(trade.tradeId, quote);
          const result = await tradeExecutor.closeTrade(trade.tradeId, trade.currentPrice, reason, trade.ticket);
          if (!result.success) continue;
          let exitPrice = result.executedPrice ?? trade.currentPrice;
          let pnl = Calculator.calculatePnL(trade.entryPrice, exitPrice, trade.quantity, trade.type);
          if (trade.ticket !== undefined && !tradeExecutor.isDryRun) {
            const history = await mt5Bridge.positionHistory(trade.ticket).catch(() => null);
            if (history?.closed) {
              exitPrice = history.exitPrice ?? exitPrice;
              pnl = history.profit ?? pnl;
            }
          }
          this.finalizeClose(trade, exitPrice, pnl, reason);
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
