import { logger } from '../utils/logger';
import { config, TIMEFRAME_MINUTES, EntryTimeframe, Sleeve } from '../config';
import { marketClient, PriceData, CandleData, computeAtrPips } from '../api/market';
import { mt5Bridge } from '../api/mt5Bridge';
import { groqClient, GroqUnavailableError } from '../api/groq';
import { EntrySignalGenerator, TradeSignal, StrategyParams, defaultStrategyParams, minClosedCandles, rangeBarsFor } from '../strategies/entrySignalGenerator';
import { computeIndicators, INDICATOR_WARMUP } from '../strategies/indicators';
import { evaluateStrategy, isSignal, HTF_FOR } from '../strategies/library';
import { newsCalendar } from '../strategies/news';
import { logAiReview } from '../services/aiReviewLog';
import { tradeExecutor } from '../services/tradeExecutor';
import { tradeMonitor, OpenTrade, ExitReason } from '../services/tradeMonitor';
import { riskManager } from '../services/riskManager';
import { tradeJournal } from '../services/tradeJournal';
import { notifier } from '../services/notifier';
import { alerts } from '../services/alerts';
import { Calculator } from '../utils/calculator';
import { PAIR_LIST, TradingPair, getPairSpec } from '../constants/pairs';
import { getZonedTime, formatClock, isWithinTradingSession, isAnySleeveInSession, isWeekend, liveServerOffsetMs } from '../utils/time';

const HOUR_MS = 60 * 60 * 1000;

/** What each strategy is trying to do — tells the Groq reviewer what a good setup looks like */
const STRATEGY_BRIEF: Partial<Record<string, string>> = {
  fibSweep:
    'Liquidity-sweep REVERSAL. The 11:30–12:30 IST candle-body range defines Fib lines 2 (above) and −1 (below). ' +
    'Price closed beyond a line (sweep leg), then a candle wicked beyond and closed back inside; the trade goes AGAINST the sweep ' +
    '(line 2 → SELL, line −1 → BUY), SL beyond the leg extreme, TP 2× risk. Approve when the sweep looks like a stop-run that is ' +
    'being rejected (long wick, momentum fading, back inside). SKIP when it looks like a genuine trend breakout that is likely to ' +
    'continue (strong closes beyond the line, trade against a clear H1 trend, no rejection), or when TP runs into a major level.',
  asianBreakout: 'Breakout of the Asian-session range at the London open, trading WITH the break.',
  volBreakout: "Volatility breakout: price moved more than half of yesterday's range from today's open, trading WITH the move.",
  nyOpenBreakout: 'Breakout of the 08:30–09:30 New York opening range, trading WITH the break.',
};
const tfMs = (tf: EntryTimeframe): number => TIMEFRAME_MINUTES[tf] * 60 * 1000;
/** A signal candle is only traded within this many minutes after it closes (max half a candle) */
export const entryWindowMinutes = (tf: EntryTimeframe): number => Math.min(15, TIMEFRAME_MINUTES[tf] / 2);

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
  strategies: SleeveSnapshot[];
}

export interface SleeveSnapshot {
  id: string;
  status: string;
  updatedAt: string | null;
  lastSignal: { side: string; at: string; verdict: string; reason: string } | null;
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
  /** When the MT5 feed started failing (alert only after 3 min, never on weekends) */
  private feedDownSince: number | null = null;
  private feedAlerted = false;
  /** Last closed candle already evaluated per pair (one decision per 1H candle) */
  private evaluatedCandle = new Map<string, string>();
  private lastRiskReason = '';
  private sleeveStatus = new Map<string, SleeveSnapshot>();
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
      inSession: isAnySleeveInSession(),
      startedAt: this.startedAt?.toISOString() ?? null,
      lastCycleAt: this.lastCycleAt?.toISOString() ?? null,
      dataFeedOk: this.feedOk,
      pairs: Array.from(this.pairStatus.values()).map((p) => ({ ...p })),
      strategies: config.sleeves.map(
        (sl) => this.sleeveStatus.get(sl.id) ?? { id: sl.id, status: 'Waiting for its session', updatedAt: null, lastSignal: null }
      ),
    };
  }

  private async validateSetup(): Promise<void> {
    const feedOk = await marketClient.validateConnection();
    if (!feedOk) {
      logger.error(`MT5 bridge not reachable at startup (${config.mt5BridgeUrl}). Will keep retrying.`);
      this.feedOk = false;
      this.feedDownSince = Date.now();
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
      `Strategies: ${config.sleeves.map((s) => `${s.id} 1:${s.rewardRatio}`).join(' | ')} | news filter ${config.newsFilter ? 'ON' : 'OFF'} | ` +
        `max ${config.maxOpenPositions} open (same direction)`
    );
    logger.info(
      `Rules: max ${config.maxTradesPerDay}/day | risk ${config.riskPercent}% ($${config.riskPerTrade}) | ` +
        `1:${config.profitRatio} RR | exits: SL/TP only | min hold ${config.minTradeDurationSeconds}s`
    );
    logger.info(
      `Challenge: Phase ${config.challengePhase} | target ${config.profitTargetPercent}% ($${config.targetProfit}) | ` +
        `min ${config.minTradingDaysPerPhase} trading days/phase` +
        (config.phaseStartDate ? ` since ${config.phaseStartDate}` : '')
    );
    let account = marketClient.isSimulated ? 'simulated feed' : 'MT5';
    if (!marketClient.isSimulated) {
      const acc = await mt5Bridge.account().catch(() => null);
      if (acc) account = `${acc.login} @ ${acc.server} · ${acc.currency} ${acc.balance.toFixed(2)}`;
    }
    alerts.startup(
      `${tradeExecutor.isDryRun ? 'PAPER (simulated fills)' : 'LIVE orders'} · AI review ${config.aiReviewEnabled ? 'ON' : 'OFF'}`,
      account,
      config.sleeves.map((sl) => `${sl.strategy} ${sl.timeframe} 1:${sl.rewardRatio}`).join(', ')
    );
  }

  private async mainLoop(): Promise<void> {
    while (this.isRunning) {
      this.currentCycle++;
      const started = Date.now();

      try {
        const inSession = isAnySleeveInSession();
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
    if (ok) {
      if (this.feedDownSince !== null && this.feedAlerted) alerts.feedRecovered(Date.now() - this.feedDownSince);
      this.feedOk = true;
      this.feedDownSince = null;
      this.feedAlerted = false;
      return;
    }
    if (marketClient.name !== 'MT5') return;
    this.feedOk = false;
    this.feedDownSince ??= Date.now();
    const minutes = Math.floor((Date.now() - this.feedDownSince) / 60000);
    // short blips (broker maintenance, bridge restart) and weekends don't page anyone
    if (minutes >= 3 && !isWeekend()) {
      alerts.feedDown(minutes, String((error as Error)?.message ?? error));
      this.feedAlerted = true;
    }
  }

  private logSessionChange(inSession: boolean): void {
    if (this.lastSessionState === inSession) return;
    this.lastSessionState = inSession;
    const now = formatClock(getZonedTime());
    if (inSession) {
      logger.info(`📈 Trading window OPEN (${now} ${config.timezone}) — scanning ${PAIR_LIST.join(', ')}`);
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

    const openTrades = tradeMonitor.getOpenTrades();
    if (openTrades.length >= config.maxOpenPositions) {
      this.updatePair(pair, { status: `${openTrades.length} position(s) open (max ${config.maxOpenPositions})` });
      return;
    }
    // Worst case if every open stop AND one more trade lose: must stay inside the daily and max-loss limits
    const openRisk = openTrades.reduce((s, t) => s + (t.riskAmount ?? config.riskPerTrade), 0);
    const worstDay = riskManager.getStatus().dailyLossAmount - openRisk - config.riskPerTrade;
    const worstTotal = tradeJournal.getPhaseSummary().totalPnL - openRisk - config.riskPerTrade;
    if (worstDay <= -config.maxDailyLoss || worstTotal <= -config.maxTotalLoss) {
      this.updatePair(pair, { status: 'Open risk too close to a loss limit — no new trade' });
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

    const now = new Date();
    const active = config.sleeves.filter((sl) => isWithinTradingSession(now, sl.sessionStart, sl.sessionEnd));
    const statuses: string[] = [];
    for (const sleeve of active) {
      if (openTrades.some((t) => t.sleeve === sleeve.id)) {
        statuses.push(`${sleeve.id}: own position open`);
        continue;
      }
      const opened = await this.scanSleeve(pair, price, sleeve, statuses, openTrades[0]?.type);
      if (opened) return; // re-scan next cycle (limits re-checked with the new position)
    }
    if (statuses.length > 0) this.updatePair(pair, { status: statuses.join(' | ') });
  }

  /** Evaluate one portfolio strategy on its own timeframe; true when a trade was opened */
  private async scanSleeve(pair: TradingPair, price: PriceData, sleeve: Sleeve, statuses: string[], openSide?: 'BUY' | 'SELL'): Promise<boolean> {
    const status = (text: string) => {
      statuses.push(config.sleeves.length > 1 ? `${sleeve.id}: ${text}` : text);
      const prev = this.sleeveStatus.get(sleeve.id);
      this.sleeveStatus.set(sleeve.id, { id: sleeve.id, status: text, updatedAt: new Date().toISOString(), lastSignal: prev?.lastSignal ?? null });
    };
    const signalSeen = (verdict: string, side: string, reason: string) => {
      const prev = this.sleeveStatus.get(sleeve.id);
      this.sleeveStatus.set(sleeve.id, {
        id: sleeve.id,
        status: prev?.status ?? '',
        updatedAt: new Date().toISOString(),
        lastSignal: { side, at: new Date().toISOString(), verdict, reason },
      });
    };
    const params = { ...defaultStrategyParams(), rangeBars: rangeBarsFor(sleeve.timeframe), rewardRatio: sleeve.rewardRatio };
    const useLibrary = sleeve.strategy !== 'breakout';
    const needed = useLibrary ? INDICATOR_WARMUP + 5 : minClosedCandles(params.rangeBars);
    const candles = await marketClient.getCandles(pair, sleeve.timeframe, needed + 40);
    const closed = candles.filter((c) => c.closed !== false);
    if (closed.length < needed) {
      status(`Warming up (${closed.length}/${needed} candles)`);
      return false;
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
    const evalKey = `${pair}|${sleeve.id}`;
    if (this.evaluatedCandle.get(evalKey) === candleKey) {
      status(`waiting for next ${sleeve.timeframe} close`);
      return false;
    }

    // Only act on a candle that closed in the last few minutes (e.g. not one from before a restart)
    const ageMin = this.candleCloseAgeMinutes(last, price, sleeve.timeframe);
    if (ageMin > entryWindowMinutes(sleeve.timeframe)) {
      this.evaluatedCandle.set(evalKey, candleKey);
      status(`last candle closed ${ageMin.toFixed(0)} min ago — waiting`);
      return false;
    }

    const signal = useLibrary
      ? await this.librarySignal(pair, price, closed, params, sleeve)
      : EntrySignalGenerator.generateTradeSignal({ pair, quote: price, candles: closed, atrPips, range }, params);
    if (signal.signal === 'SKIP') {
      // A wide spread can be temporary: allow a re-check within the entry window
      if (!/^Skipped: Spread/.test(signal.reasoning)) this.evaluatedCandle.set(evalKey, candleKey);
      status(signal.reasoning.replace(/^Skipped:\s*/, ''));
      return false;
    }

    if (openSide && signal.signal !== openSide) {
      this.evaluatedCandle.set(evalKey, candleKey);
      status(`${signal.signal} signal skipped — ${openSide} position open (no hedging)`);
      return false;
    }

    const review = await this.reviewWithAI(signal, atrPips, sleeve);
    const verdict = review.verdict;
    const record = {
      at: new Date().toISOString(),
      sleeve: sleeve.id,
      pair,
      side: signal.signal,
      entry: signal.entryPrice,
      sl: signal.stopLoss,
      tp: signal.takeProfit,
      verdict,
      aiDecision: review.decision,
      confidence: review.confidence,
      reasoning: review.reasoning,
    };
    if (verdict !== 'unavailable') signalSeen(verdict, signal.signal, signal.reasoning);
    if (verdict === 'unavailable') {
      // Fail-closed: no trade now; retried next cycle while still inside the entry window
      status('AI review unavailable — trade skipped (retrying)');
      return false;
    }
    this.evaluatedCandle.set(evalKey, candleKey);
    if (verdict === 'rejected') {
      logAiReview({ ...record, traded: false });
      status('AI review rejected signal');
      alerts.setupSkipped(sleeve.id, signal.signal, signal.entryPrice, `Groq: ${review.decision ?? 'SKIP'} (${review.confidence ?? '-'}) — ${review.reasoning ?? ''}`);
      return false;
    }

    const result = await tradeExecutor.executeTrade(signal);
    if (!result.success || !result.tradeId || !result.quantity || result.executedPrice === undefined) {
      const reason = result.error ?? result.message;
      logAiReview({ ...record, traded: false });
      status(`Order rejected: ${reason}`);
      logger.warn(`Trade not opened for ${pair}: ${reason}`);
      void notifier.notify('error', `Order for ${signal.signal} ${pair} rejected: ${reason}`, `order-reject-${reason}`, 30 * 60 * 1000);
      return false;
    }
    logAiReview({ ...record, traded: true });

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
      sleeve: sleeve.id,
    };
    tradeMonitor.registerTrade(trade);
    tradeJournal.recordOpen(trade);
    riskManager.recordTradeOpened();
    this.updatePair(pair, { status: `${trade.type} opened [${sleeve.id}]` });
    status(`${trade.type} opened @ ${trade.entryPrice}`);
    alerts.tradeOpened(trade, {
      lots: result.lots,
      risk: result.riskAmount,
      confidence: config.aiReviewEnabled ? review.confidence : undefined,
      reason: signal.reasoning.replace(/^\[[^\]]+\]\s*/, ''),
    });
    return true;
  }

  /** Minutes since the given closed candle closed (handles the MT5 server-time offset) */
  /** MT5 bar/tick times are broker server time written as UTC; estimate the offset from the tick */
  private serverOffsetMs(quote: PriceData): number {
    if (marketClient.isSimulated) return 0;
    return liveServerOffsetMs(quote.timestamp);
  }

  /** Minutes since the given closed candle closed */
  private candleCloseAgeMinutes(candle: CandleData, quote: PriceData, tf: EntryTimeframe): number {
    const closeAt = candle.timestamp.getTime() + tfMs(tf) - this.serverOffsetMs(quote);
    return (Date.now() - closeAt) / 60000;
  }

  /**
   * Higher-timeframe trend for strategies that need it (same definition as the backtest):
   * supertrend → HTF Supertrend direction, emaRangeBreakout → sign(HTF close − EMA200),
   * using the last HTF candle that had closed when the entry candle closed.
   */
  private async higherTimeframeTrend(pair: string, entryCandle: CandleData, sleeve: Sleeve): Promise<number | undefined> {
    const htfTf = HTF_FOR[sleeve.strategy]?.[sleeve.timeframe] as EntryTimeframe | undefined;
    if (!htfTf) return undefined;
    const htf = (await marketClient.getCandles(pair, htfTf, INDICATOR_WARMUP + 30)).filter((c) => c.closed !== false);
    const entryClose = entryCandle.timestamp.getTime() + tfMs(sleeve.timeframe);
    const htfMs = TIMEFRAME_MINUTES[htfTf] * 60000;
    let j = htf.length - 1;
    while (j >= 0 && htf[j].timestamp.getTime() + htfMs > entryClose) j--;
    if (j < 0) return undefined;
    const ind = computeIndicators(htf);
    if (sleeve.strategy === 'supertrend') return ind.stDir[j];
    return Number.isFinite(ind.ema200[j]) ? Math.sign(htf[j].close - ind.ema200[j]) : undefined;
  }

  /** Signal from the strategy library (STRATEGY other than breakout), as a TradeSignal */
  private async librarySignal(pair: string, quote: PriceData, closed: CandleData[], params: StrategyParams, sleeve: Sleeve): Promise<TradeSignal> {
    const i = closed.length - 1;
    const offset = this.serverOffsetMs(quote);
    const candleTime = closed[i].timestamp.toISOString();
    const htfDir = await this.higherTimeframeTrend(pair, closed[i], sleeve);
    const daily = await this.dailyContext(pair, closed[i]);
    const newsBlock = config.newsFilter ? await newsCalendar.check(new Date()) : null;
    const newsDay = config.newsFilter ? await newsCalendar.majorNewsDay(new Date()) : null;
    const tfMin = TIMEFRAME_MINUTES[sleeve.timeframe];
    const r = evaluateStrategy(sleeve.strategy, {
      pair,
      candles: closed,
      i,
      ind: computeIndicators(closed),
      quote,
      tfMinutes: tfMin,
      rewardRatio: sleeve.rewardRatio,
      slMinAtr: config.slMinAtr,
      slMaxAtr: config.slMaxAtr,
      // MIN_ATR_PIPS is the H1 value; scale by √time like the backtest (M30 ≈ 0.71×, M15 = 0.5×)
      minAtrPips: config.minAtrPips * Math.sqrt(tfMin / 60),
      maxSpreadPips: config.maxSpreadPips,
      breakout: params,
      toUtc: (d) => new Date(d.getTime() - offset),
      htfDir,
      daily,
      newsBlock,
      newsDay,
      fibTaken: sleeve.strategy === 'fibSweep' ? this.recentTradeTimes(sleeve.id) : undefined,
      fibMaxTrades: config.fibMaxTradesPerDay,
    });
    if (!isSignal(r)) return EntrySignalGenerator.skipSignal(pair, r.skip, candleTime);
    if (r.exit === 'supertrend') {
      // trailing / flip exits are backtest-only for now — never open a trade without its exit logic
      return EntrySignalGenerator.skipSignal(pair, 'Supertrend trailing exit not available in the live bot yet (backtest only)', candleTime);
    }

    const base = EntrySignalGenerator.skipSignal(pair, '', candleTime);
    const dir = r.side === 'BUY' ? 'UP' : 'DOWN';
    logger.info(`🎯 Signal ${r.side} ${pair} [${sleeve.id}]`, { entry: r.entryPrice, sl: r.stopLoss, tp: r.takeProfit, candle: candleTime });
    return {
      ...base,
      signal: r.side,
      entryPrice: r.entryPrice,
      stopLoss: r.stopLoss,
      takeProfit: r.takeProfit,
      riskRewardRatio: sleeve.rewardRatio,
      confidence: 0.6,
      reasoning: `[${sleeve.strategy}] ${r.reason}`,
      aiContext: await this.marketContext(pair, closed, sleeve).catch(() => undefined),
      meta: {
        rangeHigh: Math.max(...closed.slice(-25, -1).map((c) => c.high)),
        rangeLow: Math.min(...closed.slice(-25, -1).map((c) => c.low)),
        atrPips: computeAtrPips(closed, getPairSpec(pair).pipSize, 14),
        spreadPips: quote.spread,
        slDistance: Math.abs(r.entryPrice - r.stopLoss),
      },
      components: { ...base.components, priceAction: { ...base.components.priceAction, pattern: sleeve.strategy, direction: dir, description: r.reason } },
    };
  }

  /** Real open times of this strategy's trades in the last 30 h (journal + open positions) */
  private recentTradeTimes(sleeveId: string): number[] {
    const since = Date.now() - 30 * HOUR_MS;
    const closed = tradeJournal
      .getAllClosed()
      .filter((t) => t.sleeve === sleeveId)
      .map((t) => Date.parse(t.openedAt));
    const open = tradeMonitor
      .getOpenTrades()
      .filter((t) => t.sleeve === sleeveId)
      .map((t) => t.openedAt.getTime());
    return [...closed, ...open].filter((t) => t >= since);
  }

  /** Trend + recent candles for the Groq review */
  private async marketContext(pair: string, closed: CandleData[], sleeve: Sleeve): Promise<string> {
    const ind = computeIndicators(closed);
    const i = closed.length - 1;
    const last = closed[i];
    const lines: string[] = [];
    const rel = (v: number) => (Number.isFinite(v) ? `${last.close > v ? 'above' : 'below'} (${v.toFixed(2)})` : 'n/a');
    lines.push(`${sleeve.timeframe} close ${last.close} is ${rel(ind.ema50[i])} EMA50 and ${rel(ind.ema200[i])} EMA200; RSI14 ${ind.rsi14[i]?.toFixed(0)}`);
    const h1 = (await marketClient.getCandles(pair, 'H1', INDICATOR_WARMUP + 10)).filter((c) => c.closed !== false);
    if (h1.length > 210) {
      const hi = computeIndicators(h1);
      const k = h1.length - 1;
      const trend = hi.ema50[k] > hi.ema200[k] ? 'UP' : 'DOWN';
      lines.push(`H1 trend: ${trend} (EMA50 ${hi.ema50[k].toFixed(2)} vs EMA200 ${hi.ema200[k].toFixed(2)}), H1 close ${h1[k].close}`);
      const day = h1.slice(-24);
      lines.push(`Last 24h high/low: ${Math.max(...day.map((c) => c.high))} / ${Math.min(...day.map((c) => c.low))}`);
    }
    lines.push(`Last 8 ${sleeve.timeframe} candles (oldest→newest, O/H/L/C):`);
    for (const c of closed.slice(-8)) lines.push(`  ${c.open}/${c.high}/${c.low}/${c.close}`);
    return lines.join('\n');
  }

  /** Closed broker D1 candles + index of yesterday relative to the signal candle's server day */
  private async dailyContext(pair: string, entryCandle: CandleData): Promise<{ candles: CandleData[]; idx: number } | undefined> {
    const days = (await marketClient.getCandles(pair, 'D1', 70)).filter((d) => d.closed !== false);
    const today = entryCandle.timestamp.toISOString().slice(0, 10);
    let idx = days.length - 1;
    while (idx >= 0 && days[idx].timestamp.toISOString().slice(0, 10) >= today) idx--;
    return idx >= 0 ? { candles: days, idx } : undefined;
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
  private async reviewWithAI(
    signal: TradeSignal,
    atrPips: number,
    sleeve: Sleeve
  ): Promise<{ verdict: AiVerdict; decision?: string; confidence?: number; reasoning?: string }> {
    if (!config.aiReviewEnabled) return { verdict: 'approved', reasoning: 'AI review disabled' };

    const brief = STRATEGY_BRIEF[sleeve.strategy];
    const prompt = [
      `Instrument: ${signal.pair} (gold, 1 pip = 0.1), ${sleeve.timeframe} candles`,
      ...(brief ? [`Strategy logic: ${brief}`] : []),
      `Strategy: ${sleeve.strategy} — ${signal.reasoning}`,
      `Proposed side: ${signal.signal}`,
      `Entry: ${signal.entryPrice}`,
      `Stop loss: ${signal.stopLoss}`,
      `Take profit: ${signal.takeProfit}`,
      `Risk/reward: 1:${signal.riskRewardRatio}`,
      `Broken range (${config.rangeMode === 'prevDay' ? 'previous day' : `last ${config.rangeHours}h`}): ${signal.meta?.rangeLow} – ${signal.meta?.rangeHigh}`,
      `ATR(14, ${sleeve.timeframe}): ${atrPips.toFixed(1)} pips | spread ${signal.meta?.spreadPips} pips`,
      ...(sleeve.strategy === 'breakout'
        ? [
            `Breakout strength: ${signal.components.breakout.strength}/100`,
            `Price action: ${signal.components.priceAction.pattern} (${signal.components.priceAction.direction})`,
            `Nearest support: ${signal.components.supportResistance.support?.level ?? 'none'}`,
            `Nearest resistance: ${signal.components.supportResistance.resistance?.level ?? 'none'}`,
          ]
        : []),
      ...(signal.aiContext ? ['Market context:', signal.aiContext] : []),
      `Fixed risk: $${config.riskPerTrade} per trade (${config.riskPercent}% of $${config.accountBalance}). ` +
        'Reject setups that contradict the strategy logic or run straight into a nearby level.',
    ].join('\n');

    try {
      const review = await groqClient.analyzeTradeOpportunity(prompt);
      notifier.reset('groq-down');
      logger.info(`🧠 AI review: ${review.decision} (${review.confidence}) — ${review.reasoning}`);
      const info = { decision: review.decision, confidence: review.confidence, reasoning: review.reasoning };
      if (review.decision === 'SKIP' || review.decision !== signal.signal) return { verdict: 'rejected', ...info };
      return { verdict: review.confidence >= config.aiMinConfidence ? 'approved' : 'rejected', ...info };
    } catch (error) {
      const message = error instanceof GroqUnavailableError ? error.message : `Groq review failed: ${(error as Error).message}`;
      if (config.aiFailOpen) {
        logger.warn(`${message} — AI_REVIEW_FAIL_MODE=open, continuing with strategy signal`);
        return { verdict: 'approved', reasoning: 'Groq unavailable, fail-open' };
      }
      logger.error(`${message} — trade skipped (fail-closed)`);
      void notifier.notify('error', `Groq unavailable — ${signal.signal} ${signal.pair} signal skipped.\n${message}`, 'groq-down', 30 * 60 * 1000);
      return { verdict: 'unavailable', reasoning: message };
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
    alerts.tradeClosed(trade, exitPrice, pnl, reason);
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
