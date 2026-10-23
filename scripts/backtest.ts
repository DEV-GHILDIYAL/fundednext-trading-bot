/**
 * Backtest the strategy library on historical MT5 candles.
 *
 *   npm run backtest                      # strategy/settings from .env
 *   npm run backtest -- --strategies      # every strategy × timeframe × session × R:R, ranked
 *   npm run backtest -- --strategies --only asianBreakout,turtle20   # just some strategies
 *   npm run backtest -- --bars 5000       # H1 history length (M30/M15 always use 10000 bars)
 *   npm run backtest -- --source sim      # offline smoke test (random-walk feed)
 *
 * Same signal code as the live bot (src/strategies/library.ts). Fill = next candle open + spread.
 * SL and TP inside the same candle → SL assumed (conservative).
 * IS/OOS: first 70% of the history vs the last 30% — a strategy that only works in one half is luck.
 * NOT modelled: Groq review, slippage, swap, commission.
 */
import { config, EntryTimeframe, TIMEFRAME_MINUTES } from '../src/config';
import { createMarketDataSource, CandleData, MarketDataSource } from '../src/api/market';
import { defaultStrategyParams, rangeBarsFor } from '../src/strategies/entrySignalGenerator';
import { computeIndicators, Indicators, INDICATOR_WARMUP } from '../src/strategies/indicators';
import { evaluateStrategy, isSignal, StrategyName, STRATEGY_NAMES } from '../src/strategies/library';
import { getPairSpec, PAIR_LIST } from '../src/constants/pairs';
import { isWithinTradingSession, getZonedTime, formatMinutes } from '../src/utils/time';

interface Variant {
  strategy: StrategyName;
  timeframe: EntryTimeframe;
  session: { name: string; start: number; end: number };
  rewardRatio: number;
}

interface BtTrade {
  openedAt: Date;
  index: number;
  result: 'WIN' | 'LOSS' | 'OPEN';
  r: number;
  day: string;
  side: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number;
}

interface Dataset {
  candles: CandleData[];
  ind: Indicators;
  weeks: number;
}

const SESSIONS = {
  London: { name: 'London', start: 8 * 60, end: 11 * 60 + 30 },
  LonNY: { name: 'Lon+NY', start: 8 * 60, end: 16 * 60 + 30 },
  AllDay: { name: 'AllDay', start: 1 * 60, end: 21 * 60 },
  Any: { name: 'Any', start: 0, end: 24 * 60 },
};

type Session = (typeof SESSIONS)[keyof typeof SESSIONS];
const INTRADAY: EntryTimeframe[] = ['H1', 'M30', 'M15'];
const INTRADAY_SESSIONS: Session[] = [SESSIONS.London, SESSIONS.LonNY, SESSIONS.AllDay];

/** Which timeframes / sessions / R:R each strategy is tested on */
const GRID: Record<StrategyName, { tfs: EntryTimeframe[]; sessions: Session[]; rr: number[] }> = {
  breakout: { tfs: INTRADAY, sessions: INTRADAY_SESSIONS, rr: [1.5, 2] },
  trendPullback: { tfs: INTRADAY, sessions: INTRADAY_SESSIONS, rr: [1.5, 2] },
  asianBreakout: { tfs: INTRADAY, sessions: INTRADAY_SESSIONS, rr: [1.5, 2] },
  meanReversion: { tfs: INTRADAY, sessions: INTRADAY_SESSIONS, rr: [1.5, 2] },
  emaCross: { tfs: INTRADAY, sessions: INTRADAY_SESSIONS, rr: [1.5, 2] },
  donchian: { tfs: INTRADAY, sessions: INTRADAY_SESSIONS, rr: [1.5, 2] },
  turtle20: { tfs: ['H1', 'H4', 'D1'], sessions: [SESSIONS.Any], rr: [2, 3] },
  turtle55: { tfs: ['H1', 'H4', 'D1'], sessions: [SESSIONS.Any], rr: [2, 3] },
  volBreakout: { tfs: INTRADAY, sessions: INTRADAY_SESSIONS, rr: [1.5, 2] },
  pinBar: { tfs: ['H1', 'H4', 'D1'], sessions: [SESSIONS.Any], rr: [2, 3] },
  raynerEma: { tfs: ['H1', 'H4'], sessions: [SESSIONS.Any, SESSIONS.LonNY], rr: [2, 3] },
  ictSilverBullet: { tfs: ['M15'], sessions: [SESSIONS.Any], rr: [2, 3] },
  casperSmc: { tfs: ['M15'], sessions: [SESSIONS.Any], rr: [3, 4] },
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

function runBacktest(ds: Dataset, v: Variant, spread: number, offsetMs: number): BtTrade[] {
  const pair = PAIR_LIST[0];
  const spec = getPairSpec(pair);
  const tfMin = TIMEFRAME_MINUTES[v.timeframe];
  const base = defaultStrategyParams();
  const minAtrPips = config.minAtrPips * Math.sqrt(tfMin / 60); // ATR scales ~√time
  const breakoutParams = { ...base, rangeBars: rangeBarsFor(v.timeframe, 24), usePriceAction: true, minAtrPips };
  const toUtc = (d: Date) => new Date(d.getTime() - offsetMs);
  const c = ds.candles;

  const trades: BtTrade[] = [];
  const perDay = new Map<string, { n: number; r: number }>();
  let open: BtTrade | null = null;

  for (let i = INDICATOR_WARMUP; i < c.length - 1; i++) {
    const bar = c[i];
    if (open) {
      const hitSl = open.side === 'BUY' ? bar.low <= open.sl : bar.high + spread >= open.sl;
      const hitTp = open.side === 'BUY' ? bar.high >= open.tp : bar.low + spread <= open.tp;
      if (hitSl || hitTp) {
        open.result = hitSl ? 'LOSS' : 'WIN';
        open.r = hitSl ? -1 : v.rewardRatio;
        const d = perDay.get(open.day)!;
        d.r += open.r;
        open = null;
      }
      if (open) continue; // one position at a time
    }

    const closeAt = new Date(toUtc(bar.timestamp).getTime() + tfMin * 60000);
    if (!isWithinTradingSession(closeAt, v.session.start, v.session.end)) continue;
    const day = getZonedTime(closeAt).dateKey;
    const today = perDay.get(day) ?? { n: 0, r: 0 };
    // live rules: max trades/day and the safety buffer (−risk × max trades)
    if (today.n >= config.maxTradesPerDay || today.r <= -config.maxTradesPerDay) continue;

    const bid = c[i + 1].open;
    const result = evaluateStrategy(v.strategy, {
      pair,
      candles: c,
      i,
      ind: ds.ind,
      quote: { pair, bid, ask: bid + spread, spread: parseFloat((spread / spec.pipSize).toFixed(1)), timestamp: closeAt },
      tfMinutes: tfMin,
      rewardRatio: v.rewardRatio,
      slMinAtr: config.slMinAtr,
      slMaxAtr: Math.max(config.slMaxAtr, 2),
      minAtrPips,
      maxSpreadPips: config.maxSpreadPips,
      breakout: breakoutParams,
      toUtc,
    });
    if (!isSignal(result)) continue;

    open = { openedAt: closeAt, index: i, result: 'OPEN', r: 0, day, side: result.side, entry: result.entryPrice, sl: result.stopLoss, tp: result.takeProfit };
    trades.push(open);
    today.n++;
    perDay.set(day, today);
  }
  return trades;
}

function summarize(trades: BtTrade[], ds: Dataset, rr: number) {
  const done = trades.filter((t) => t.result !== 'OPEN');
  const split = Math.floor(ds.candles.length * 0.7);
  const wins = done.filter((t) => t.result === 'WIN').length;
  const losses = done.length - wins;
  const netR = done.reduce((s, t) => s + t.r, 0);
  const isR = done.filter((t) => t.index < split).reduce((s, t) => s + t.r, 0);
  const oosR = done.filter((t) => t.index >= split).reduce((s, t) => s + t.r, 0);
  let peak = 0, eq = 0, maxDd = 0, run = 0, maxRun = 0;
  for (const t of done) {
    eq += t.r;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
    run = t.result === 'LOSS' ? run + 1 : 0;
    maxRun = Math.max(maxRun, run);
  }
  const perWeekR = ds.weeks > 0 ? netR / ds.weeks : 0;
  const riskR = config.riskPerTrade;
  return {
    trades: done.length,
    perWeek: ds.weeks > 0 ? done.length / ds.weeks : 0,
    winRate: done.length ? (wins / done.length) * 100 : 0,
    netR,
    isR,
    oosR,
    pf: losses ? (wins * rr) / losses : Infinity,
    maxDd,
    maxRun,
    weeksP1: perWeekR > 0 ? (config.accountBalance * 0.08) / riskR / perWeekR : Infinity,
    weeksP2: perWeekR > 0 ? (config.accountBalance * 0.05) / riskR / perWeekR : Infinity,
  };
}

const f = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '∞');

async function loadDataset(market: MarketDataSource, tf: EntryTimeframe, bars: number): Promise<Dataset> {
  const candles = (await market.getCandles(PAIR_LIST[0], tf, bars)).filter((x) => x.closed !== false);
  const first = candles[0]?.timestamp;
  const last = candles[candles.length - 1]?.timestamp;
  const weeks = first && last ? (last.getTime() - first.getTime()) / (7 * 86400000) : 0;
  return { candles, ind: computeIndicators(candles), weeks };
}

async function main(): Promise<void> {
  const source = arg('source', config.dataSource) === 'mt5' ? 'mt5' : 'sim';
  const bars = Math.min(10000, parseInt(arg('bars', '5000'), 10));
  const matrix = process.argv.includes('--strategies') || process.argv.includes('--variants');
  const pair = PAIR_LIST[0];
  const spec = getPairSpec(pair);
  const market = createMarketDataSource(source);

  const quote = await market.getCurrentPrice(pair);
  const spread = Math.max(quote.ask - quote.bid, spec.pipSize);
  const offsetMs = source === 'mt5' ? Math.round((quote.timestamp.getTime() - Date.now()) / 1800000) * 1800000 : 0;
  console.log(`Backtest ${pair} on ${source.toUpperCase()} | spread ${spread.toFixed(2)} | server offset ${(offsetMs / 3600000).toFixed(1)}h | risk $${config.riskPerTrade}/trade`);

  const only = arg('only', '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const names = STRATEGY_NAMES.filter((n) => only.length === 0 || only.includes(n));
  const timeframes: EntryTimeframe[] = matrix
    ? Array.from(new Set(names.flatMap((n) => GRID[n].tfs)))
    : [config.entryTimeframe];
  const datasets = new Map<EntryTimeframe, Dataset>();
  for (const tf of timeframes) {
    datasets.set(tf, await loadDataset(market, tf, tf === 'H1' ? bars : 10000));
    const ds = datasets.get(tf)!;
    console.log(`  ${tf}: ${ds.candles.length} candles, ${f(ds.weeks, 0)} weeks`);
  }

  const variants: Variant[] = [];
  if (matrix) {
    for (const strategy of names)
      for (const timeframe of GRID[strategy].tfs)
        for (const session of GRID[strategy].sessions)
          for (const rewardRatio of GRID[strategy].rr) variants.push({ strategy, timeframe, session, rewardRatio });
    console.log(`  ${variants.length} combinations to test...`);
  } else {
    variants.push({
      strategy: config.strategy,
      timeframe: config.entryTimeframe,
      session: { name: `${formatMinutes(config.sessionStart)}-${formatMinutes(config.sessionEnd)}`, start: config.sessionStart, end: config.sessionEnd },
      rewardRatio: config.profitRatio,
    });
  }

  const rows = variants.map((v) => {
    const ds = datasets.get(v.timeframe)!;
    const trades = runBacktest(ds, v, spread, offsetMs);
    return { v, ds, trades, s: summarize(trades, ds, v.rewardRatio) };
  });

  const header =
    'Strategy'.padEnd(16) + 'TF'.padEnd(5) + 'Session'.padEnd(8) + 'RR'.padStart(4) + 'Wks'.padStart(5) + 'Trd'.padStart(5) +
    '/wk'.padStart(5) + 'Win%'.padStart(6) + 'NetR'.padStart(7) + 'IS R'.padStart(7) + 'OOS R'.padStart(7) + 'PF'.padStart(6) +
    'DD R'.padStart(6) + 'LRun'.padStart(5) + 'P1 wk'.padStart(7) + 'P2 wk'.padStart(7);
  const line = (r: (typeof rows)[number]) =>
    r.v.strategy.padEnd(16) + r.v.timeframe.padEnd(5) + r.v.session.name.padEnd(8) + f(r.v.rewardRatio).padStart(4) +
    f(r.ds.weeks, 0).padStart(5) + String(r.s.trades).padStart(5) + f(r.s.perWeek).padStart(5) + f(r.s.winRate, 0).padStart(6) +
    f(r.s.netR).padStart(7) + f(r.s.isR).padStart(7) + f(r.s.oosR).padStart(7) + f(r.s.pf, 2).padStart(6) + f(r.s.maxDd).padStart(6) +
    String(r.s.maxRun).padStart(5) + f(r.s.weeksP1, 0).padStart(7) + f(r.s.weeksP2, 0).padStart(7);

  if (matrix) {
    const robust = rows.filter((r) => r.s.trades >= 20 && r.s.isR > 0 && r.s.oosR > 0 && r.s.maxDd < 13.3);
    robust.sort((a, b) => b.s.netR / Math.max(b.ds.weeks, 1) - a.s.netR / Math.max(a.ds.weeks, 1));
    console.log('\n=== ROBUST: profitable in BOTH halves, ≥20 trades, drawdown under the 10% max-loss (13.3 R) — ranked by R/week ===');
    console.log(header);
    if (robust.length === 0) console.log('  (none)');
    robust.slice(0, 15).forEach((r) => console.log(line(r)));

    console.log('\n=== BEST ROW PER STRATEGY (by Net R) ===');
    console.log(header);
    for (const name of names) {
      const best = rows.filter((r) => r.v.strategy === name).sort((a, b) => b.s.netR - a.s.netR)[0];
      if (best) console.log(line(best));
    }
  } else {
    console.log('');
    console.log(header);
    console.log(line(rows[0]));
    for (const t of rows[0].trades.filter((x) => x.result !== 'OPEN').slice(-10)) {
      console.log(`  ${t.openedAt.toISOString().slice(0, 16)} ${t.side} ${t.entry} SL ${t.sl} TP ${t.tp} → ${t.result}`);
    }
  }

  console.log('\nR = $' + config.riskPerTrade + '. IS/OOS = first 70% / last 30% of history. PF > 1.3 decent. DD R = max drawdown (limit 13.3 R).');
  console.log('P1/P2 wk = weeks to the phase target at this pace (5 trading days also required). Not modelled: Groq, slippage, swap, commission.');
}

main().catch((error) => {
  console.error('Backtest failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
