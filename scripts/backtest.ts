/**
 * Backtest the London breakout rules on historical candles.
 *
 *   npm run backtest                         # current .env strategy on MT5 history
 *   npm run backtest -- --bars 5000          # more history (max 10000 bars)
 *   npm run backtest -- --variants           # compare several strategy variants side by side
 *   npm run backtest -- --source sim         # offline smoke test on the random-walk feed
 *
 * Uses the same EntrySignalGenerator as the live bot. NOT modelled: the Groq review,
 * slippage, swap and commission. Fills = next bar's open + current spread. If SL and TP
 * are both inside one bar, the SL is assumed first (conservative).
 */
import { config, EntryTimeframe, TIMEFRAME_MINUTES } from '../src/config';
import { createMarketDataSource, computeAtrPips, CandleData, MarketDataSource } from '../src/api/market';
import { EntrySignalGenerator, StrategyParams, defaultStrategyParams, minClosedCandles, rangeBarsFor } from '../src/strategies/entrySignalGenerator';
import { getPairSpec, PAIR_LIST } from '../src/constants/pairs';
import { isWithinTradingSession, getZonedTime } from '../src/utils/time';

interface Variant {
  name: string;
  timeframe: EntryTimeframe;
  sessionStart: number; // minutes, London time
  sessionEnd: number;
  rangeMode: 'rolling24h' | 'prevDay';
  usePriceAction: boolean;
  rewardRatio: number;
}

interface BtTrade {
  side: 'BUY' | 'SELL';
  openedAt: Date;
  entry: number;
  sl: number;
  tp: number;
  result: 'WIN' | 'LOSS' | 'OPEN';
  r: number;
  day: string;
}

interface BtResult {
  variant: Variant;
  firstBar?: Date;
  lastBar?: Date;
  weeks: number;
  trades: BtTrade[];
}

const LONDON = { start: 8 * 60, end: 11 * 60 + 30 };
const LONDON_NY = { start: 8 * 60, end: 16 * 60 + 30 };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

function currentVariant(): Variant {
  return {
    name: 'current .env',
    timeframe: config.entryTimeframe,
    sessionStart: config.sessionStart,
    sessionEnd: config.sessionEnd,
    rangeMode: config.rangeMode,
    usePriceAction: config.usePriceAction,
    rewardRatio: config.profitRatio,
  };
}

const VARIANTS: Variant[] = [
  { name: 'A H1 London PA 1:2 (old)', timeframe: 'H1', sessionStart: LONDON.start, sessionEnd: LONDON.end, rangeMode: 'rolling24h', usePriceAction: true, rewardRatio: 2 },
  { name: 'B H1 London noPA 1:2', timeframe: 'H1', sessionStart: LONDON.start, sessionEnd: LONDON.end, rangeMode: 'rolling24h', usePriceAction: false, rewardRatio: 2 },
  { name: 'C H1 Lon+NY noPA 1:2', timeframe: 'H1', sessionStart: LONDON_NY.start, sessionEnd: LONDON_NY.end, rangeMode: 'rolling24h', usePriceAction: false, rewardRatio: 2 },
  { name: 'D H1 Lon+NY prevDay 1:2', timeframe: 'H1', sessionStart: LONDON_NY.start, sessionEnd: LONDON_NY.end, rangeMode: 'prevDay', usePriceAction: false, rewardRatio: 2 },
  { name: 'E H1 Lon+NY noPA 1:1.5', timeframe: 'H1', sessionStart: LONDON_NY.start, sessionEnd: LONDON_NY.end, rangeMode: 'rolling24h', usePriceAction: false, rewardRatio: 1.5 },
  { name: 'F H1 Lon+NY PA 1:2', timeframe: 'H1', sessionStart: LONDON_NY.start, sessionEnd: LONDON_NY.end, rangeMode: 'rolling24h', usePriceAction: true, rewardRatio: 2 },
  { name: 'G M30 Lon+NY noPA 1:2', timeframe: 'M30', sessionStart: LONDON_NY.start, sessionEnd: LONDON_NY.end, rangeMode: 'rolling24h', usePriceAction: false, rewardRatio: 2 },
  { name: 'H M15 London noPA 1:2', timeframe: 'M15', sessionStart: LONDON.start, sessionEnd: LONDON.end, rangeMode: 'rolling24h', usePriceAction: false, rewardRatio: 2 },
  { name: 'I M15 Lon+NY noPA 1:2', timeframe: 'M15', sessionStart: LONDON_NY.start, sessionEnd: LONDON_NY.end, rangeMode: 'rolling24h', usePriceAction: false, rewardRatio: 2 },
  { name: 'J M15 Lon+NY noPA 1:1.5', timeframe: 'M15', sessionStart: LONDON_NY.start, sessionEnd: LONDON_NY.end, rangeMode: 'rolling24h', usePriceAction: false, rewardRatio: 1.5 },
];

/** Previous broker day's high/low for every bar (bar times are broker server time) */
function prevDayRanges(candles: CandleData[]): ({ high: number; low: number } | undefined)[] {
  const days = new Map<string, { high: number; low: number }>();
  const order: string[] = [];
  for (const c of candles) {
    const key = c.timestamp.toISOString().slice(0, 10);
    const d = days.get(key);
    if (!d) {
      days.set(key, { high: c.high, low: c.low });
      order.push(key);
    } else {
      d.high = Math.max(d.high, c.high);
      d.low = Math.min(d.low, c.low);
    }
  }
  const prevOf = new Map<string, { high: number; low: number }>();
  for (let i = 1; i < order.length; i++) prevOf.set(order[i], days.get(order[i - 1])!);
  return candles.map((c) => prevOf.get(c.timestamp.toISOString().slice(0, 10)));
}

function runBacktest(candles: CandleData[], variant: Variant, spread: number, offsetMs: number): BtResult {
  const pair = PAIR_LIST[0];
  const spec = getPairSpec(pair);
  const tfMin = TIMEFRAME_MINUTES[variant.timeframe];
  const base = defaultStrategyParams();
  const params: StrategyParams = {
    ...base,
    rewardRatio: variant.rewardRatio,
    usePriceAction: variant.usePriceAction,
    rangeBars: rangeBarsFor(variant.timeframe, 24),
    // ATR grows ~√time: keep the H1 threshold equivalent on smaller timeframes
    minAtrPips: base.minAtrPips * Math.sqrt(tfMin / 60),
  };
  const needed = minClosedCandles(params.rangeBars);
  const prevDay = variant.rangeMode === 'prevDay' ? prevDayRanges(candles) : [];

  const trades: BtTrade[] = [];
  const perDay = new Map<string, number>();
  let open: BtTrade | null = null;

  for (let i = needed; i < candles.length - 1; i++) {
    const bar = candles[i];
    if (open) {
      const hitSl = open.side === 'BUY' ? bar.low <= open.sl : bar.high + spread >= open.sl;
      const hitTp = open.side === 'BUY' ? bar.high >= open.tp : bar.low + spread <= open.tp;
      if (hitSl || hitTp) {
        open.result = hitSl ? 'LOSS' : 'WIN';
        open.r = hitSl ? -1 : variant.rewardRatio;
        open = null;
      }
      if (open) continue; // no hedging
    }

    const closeAt = new Date(bar.timestamp.getTime() + tfMin * 60000 - offsetMs);
    if (!isWithinTradingSession(closeAt, variant.sessionStart, variant.sessionEnd)) continue;
    const day = getZonedTime(closeAt).dateKey;
    if ((perDay.get(day) ?? 0) >= config.maxTradesPerDay) continue;

    const history = candles.slice(Math.max(0, i - needed - 40), i + 1);
    const bid = candles[i + 1].open;
    const signal = EntrySignalGenerator.generateTradeSignal(
      {
        pair,
        quote: { pair, bid, ask: bid + spread, spread: parseFloat((spread / spec.pipSize).toFixed(1)), timestamp: closeAt },
        candles: history,
        atrPips: computeAtrPips(history, spec.pipSize, 14),
        range: variant.rangeMode === 'prevDay' ? prevDay[i] : undefined,
      },
      params
    );
    if (signal.signal === 'SKIP') continue;

    open = { side: signal.signal, openedAt: closeAt, entry: signal.entryPrice, sl: signal.stopLoss, tp: signal.takeProfit, result: 'OPEN', r: 0, day };
    trades.push(open);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const firstBar = candles[0]?.timestamp;
  const lastBar = candles[candles.length - 1]?.timestamp;
  const weeks = firstBar && lastBar ? (lastBar.getTime() - firstBar.getTime()) / (7 * 86400000) : 0;
  return { variant, firstBar, lastBar, weeks, trades };
}

function stats(r: BtResult) {
  const done = r.trades.filter((t) => t.result !== 'OPEN');
  const wins = done.filter((t) => t.result === 'WIN').length;
  const losses = done.length - wins;
  const netR = done.reduce((s, t) => s + t.r, 0);
  let peak = 0, eq = 0, maxDd = 0, streak = 0, maxStreak = 0;
  for (const t of done) {
    eq += t.r;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
    streak = t.result === 'LOSS' ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const tradeDays = new Set(done.map((t) => t.day)).size;
  const perWeekR = r.weeks > 0 ? netR / r.weeks : 0;
  const p1R = config.accountBalance * 0.08 / config.riskPerTrade;
  const p2R = config.accountBalance * 0.05 / config.riskPerTrade;
  return {
    trades: done.length,
    perWeek: r.weeks > 0 ? done.length / r.weeks : 0,
    winRate: done.length ? (wins / done.length) * 100 : 0,
    netR,
    pf: losses ? (wins * r.variant.rewardRatio) / losses : Infinity,
    maxDd,
    maxStreak,
    tradeDays,
    weeksP1: perWeekR > 0 ? p1R / perWeekR : Infinity,
    weeksP2: perWeekR > 0 ? p2R / perWeekR : Infinity,
  };
}

function fmt(n: number, d = 1): string {
  return Number.isFinite(n) ? n.toFixed(d) : '∞';
}

async function loadCandles(market: MarketDataSource, tf: EntryTimeframe, bars: number, cache: Map<string, CandleData[]>) {
  const key = `${tf}:${bars}`;
  if (!cache.has(key)) {
    const c = (await market.getCandles(PAIR_LIST[0], tf, bars)).filter((x) => x.closed !== false);
    cache.set(key, c);
  }
  return cache.get(key)!;
}

async function main(): Promise<void> {
  const source = arg('source', config.dataSource) === 'mt5' ? 'mt5' : 'sim';
  const bars = Math.min(10000, parseInt(arg('bars', '5000'), 10));
  const variantsMode = process.argv.includes('--variants');
  const pair = PAIR_LIST[0];
  const spec = getPairSpec(pair);
  const market = createMarketDataSource(source);

  const quote = await market.getCurrentPrice(pair);
  const spread = Math.max(quote.ask - quote.bid, spec.pipSize);
  let offsetMs = 0;
  if (source === 'mt5') offsetMs = Math.round((quote.timestamp.getTime() - Date.now()) / 1800000) * 1800000;
  console.log(`Backtest ${pair} on ${source.toUpperCase()} | spread ${spread.toFixed(2)} | server offset ${(offsetMs / 3600000).toFixed(1)}h | risk $${config.riskPerTrade}/trade`);

  const cache = new Map<string, CandleData[]>();
  const list = variantsMode ? VARIANTS : [currentVariant()];
  const results: BtResult[] = [];
  for (const v of list) {
    // smaller timeframes need more bars for the same history; the bridge caps at 10000
    const n = v.timeframe === 'H1' ? bars : 10000;
    results.push(runBacktest(await loadCandles(market, v.timeframe, n, cache), v, spread, offsetMs));
  }

  const p1 = (config.accountBalance * 0.08).toFixed(0);
  const p2 = (config.accountBalance * 0.05).toFixed(0);
  console.log('');
  console.log(
    'Variant'.padEnd(26) + 'Weeks'.padStart(6) + 'Trades'.padStart(7) + '/wk'.padStart(5) + 'Win%'.padStart(6) +
      'NetR'.padStart(7) + 'Net$'.padStart(8) + 'PF'.padStart(6) + 'MaxDD R'.padStart(8) + 'LossRun'.padStart(8) +
      `P1 $${p1} wks`.padStart(14) + `P2 $${p2} wks`.padStart(14)
  );
  for (const r of results) {
    const s = stats(r);
    console.log(
      r.variant.name.padEnd(26) + fmt(r.weeks, 0).padStart(6) + String(s.trades).padStart(7) + fmt(s.perWeek).padStart(5) +
        fmt(s.winRate, 0).padStart(6) + fmt(s.netR).padStart(7) + fmt(s.netR * config.riskPerTrade, 0).padStart(8) +
        fmt(s.pf, 2).padStart(6) + fmt(s.maxDd).padStart(8) + String(s.maxStreak).padStart(8) +
        fmt(s.weeksP1).padStart(14) + fmt(s.weeksP2).padStart(14)
    );
  }
  console.log('');
  console.log('PF = profit factor (>1.3 is decent). MaxDD/LossRun in R ($45 each). Max loss rule = 10% = 13.3 R.');
  console.log('P1/P2 wks = weeks to reach the phase target at the backtested pace (min 5 trading days also needed).');
  console.log('H1 rows use the --bars history; M30/M15 rows use the last 10000 bars (shorter period, see Weeks).');
  console.log('Not modelled: Groq review, slippage, swap, commission.');

  if (!variantsMode) {
    const done = results[0].trades.filter((t) => t.result !== 'OPEN');
    for (const t of done.slice(-10)) {
      console.log(`  ${t.openedAt.toISOString().slice(0, 16)} ${t.side} ${t.entry} SL ${t.sl} TP ${t.tp} → ${t.result}`);
    }
  }
}

main().catch((error) => {
  console.error('Backtest failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
