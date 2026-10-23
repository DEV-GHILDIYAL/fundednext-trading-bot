/**
 * Backtest the strategy library on historical MT5 candles.
 *
 *   npm run backtest                      # strategy/settings from .env
 *   npm run backtest -- --strategies      # every strategy × timeframe × session × R:R, ranked
 *   npm run backtest -- --strategies --only asianBreakout,turtle20   # just some strategies
 *   npm run backtest -- --bars 5000       # H1 history length (M5/M15/M30/H4/D1 always use 10000 bars)
 *   npm run backtest -- --source sim      # offline smoke test (random-walk feed)
 *   npm run backtest -- --portfolio       # STRATEGIES traded together: one position at a time, 3/day shared,
 *                                         # filters ON vs OFF per strategy, combined result + Monte Carlo pass odds
 *   npm run backtest -- --no-filters      # disable news blackout + range filters (compare with the old results)
 *
 * Same signal code as the live bot (src/strategies/library.ts). Fill = next candle open + spread.
 * SL and TP inside the same candle → SL assumed (conservative).
 * IS/OOS: first 70% of the history vs the last 30% — a strategy that only works in one half is luck.
 * News blackout in the backtest = built-in schedule only (NFP + FOMC); live also uses the ForexFactory feed.
 * NOT modelled: Groq review, slippage, swap, commission, news spread spikes.
 */
import { config, EntryTimeframe, TIMEFRAME_MINUTES, Sleeve, parseSleeves } from '../src/config';
import { builtInEvents, NewsIndex } from '../src/strategies/news';
import { monteCarloPass } from '../src/utils/monteCarlo';
import { createMarketDataSource, CandleData, MarketDataSource } from '../src/api/market';
import { defaultStrategyParams, rangeBarsFor } from '../src/strategies/entrySignalGenerator';
import { computeIndicators, Indicators, INDICATOR_WARMUP } from '../src/strategies/indicators';
import { evaluateStrategy, isSignal, StrategyName, STRATEGY_NAMES, SUPERTREND_EA, HTF_FOR } from '../src/strategies/library';
import { getPairSpec, PAIR_LIST } from '../src/constants/pairs';
import { isWithinTradingSession, getZonedTime, formatMinutes } from '../src/utils/time';

interface Variant {
  strategy: StrategyName;
  timeframe: EntryTimeframe;
  session: { name: string; start: number; end: number };
  rewardRatio: number;
  /** news blackout + range filters (default on) */
  filters?: boolean;
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
  /** fixed SL/TP, or Supertrend trailing exit */
  exit: 'fixed' | 'supertrend';
  /** initial risk in price units (1R) */
  risk: number;
  /** real UTC close time (ms) of the bar where the trade exited */
  closedAtMs?: number;
  sleeve?: string;
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
  // rr 0 = no fixed target (trailing exit)
  supertrend: { tfs: ['M15', 'M30', 'H1'], sessions: [SESSIONS.Any], rr: [0] },
  // EA uses its own server-time sessions (8–12, 14–19)
  emaRangeBreakout: { tfs: ['M5', 'M15', 'M30'], sessions: [SESSIONS.Any], rr: [1.5, 2] },
  // own time rules (NY 09:30–12:00 / any time of the broker day)
  nyOpenBreakout: { tfs: ['M15', 'M30'], sessions: [SESSIONS.Any], rr: [1.5, 2] },
  insideDayBreakout: { tfs: ['H1', 'M30'], sessions: [SESSIONS.Any], rr: [1.5, 2] },
};

/** The research-plan portfolio, used by --portfolio when STRATEGIES is not set */
const DEFAULT_PORTFOLIO = 'asianBreakout:M30:2, volBreakout:M30:2, nyOpenBreakout:M15:2, insideDayBreakout:H1:2';

/** For every entry candle: index of the last broker D1 candle of an EARLIER server day (yesterday) */
function mapDailyIdx(ds: Dataset, daily: Dataset): number[] {
  const out = new Array<number>(ds.candles.length).fill(-1);
  const key = (d: Date) => d.toISOString().slice(0, 10);
  let j = -1;
  for (let i = 0; i < ds.candles.length; i++) {
    const today = key(ds.candles[i].timestamp);
    while (j + 1 < daily.candles.length && key(daily.candles[j + 1].timestamp) < today) j++;
    out[i] = j;
  }
  return out;
}

const htfOf = (strategy: StrategyName, tf: EntryTimeframe): EntryTimeframe | undefined =>
  HTF_FOR[strategy]?.[tf] as EntryTimeframe | undefined;

/** Higher-timeframe trend known at each entry candle's close (last CLOSED higher-TF candle) */
function mapHtfDir(strategy: StrategyName, ds: Dataset, tf: EntryTimeframe, htf: Dataset, htfTf: EntryTimeframe): number[] {
  const out = new Array<number>(ds.candles.length).fill(0);
  const tfMs = TIMEFRAME_MINUTES[tf] * 60000;
  const htfMs = TIMEFRAME_MINUTES[htfTf] * 60000;
  let j = -1;
  for (let i = 0; i < ds.candles.length; i++) {
    const closeAt = ds.candles[i].timestamp.getTime() + tfMs;
    while (j + 1 < htf.candles.length && htf.candles[j + 1].timestamp.getTime() + htfMs <= closeAt) j++;
    if (j < 0) continue;
    if (strategy === 'supertrend') out[i] = htf.ind.stDir[j];
    else {
      const e = htf.ind.ema200[j];
      const cl = htf.candles[j].close;
      out[i] = Number.isFinite(e) ? Math.sign(cl - e) : 0;
    }
  }
  return out;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

/** --why: count of skip reasons per strategy (debugging why a strategy rarely trades) */
const WHY: Map<string, number> | null = process.argv.includes('--why') ? new Map() : null;
function printWhy(): void {
  if (!WHY) return;
  console.log('\n=== WHY NO TRADE (skip reasons on in-session candles) ===');
  const groups = new Map<string, [string, number][]>();
  for (const [k, n] of WHY) {
    const [g, r] = k.split(' | ');
    groups.set(g, [...(groups.get(g) ?? []), [r, n]]);
  }
  for (const [g, list] of groups) {
    console.log(`  ${g}: ` + list.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, n]) => `${r} ×${n}`).join(' · '));
  }
}

interface Extras {
  htfDir?: number[];
  daily?: Dataset;
  dailyIdx?: number[];
  news?: NewsIndex;
}

function runBacktest(ds: Dataset, v: Variant, spread: number, offsetMs: number, extras: Extras = {}): BtTrade[] {
  const { htfDir, daily, dailyIdx, news } = extras;
  const filters = v.filters !== false;
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
    if (open && open.exit === 'supertrend') {
      // EA exit rules, evaluated like the EA: hard SL intrabar, then on the candle close
      const buy = open.side === 'BUY';
      const hitSl = buy ? bar.low <= open.sl : bar.high + spread >= open.sl;
      const closeAtServer = new Date(bar.timestamp.getTime() + tfMin * 60000);
      const fridayClose = closeAtServer.getUTCDay() === 5 && closeAtServer.getUTCHours() >= SUPERTREND_EA.fridayCloseHour;
      let exitPrice: number | null = null;
      if (hitSl) exitPrice = open.sl;
      else if (ds.ind.stDir[i] !== (buy ? 1 : -1) || fridayClose) exitPrice = buy ? c[i + 1].open : c[i + 1].open + spread;
      else {
        const trail = buy ? ds.ind.stLine[i] - SUPERTREND_EA.slBuffer : ds.ind.stLine[i] + SUPERTREND_EA.slBuffer;
        if (buy ? trail > open.sl : trail < open.sl) open.sl = trail; // only tighter
      }
      if (exitPrice !== null) {
        const pnl = buy ? exitPrice - open.entry : open.entry - exitPrice;
        open.r = parseFloat((pnl / open.risk).toFixed(3));
        open.result = open.r > 0 ? 'WIN' : 'LOSS';
        open.closedAtMs = toUtc(bar.timestamp).getTime() + tfMin * 60000;
        perDay.get(open.day)!.r += open.r;
        open = null;
        if (hitSl) continue; // stopped mid-candle: new signals are taken from the next close
      } else continue;
    }
    if (open) {
      const hitSl = open.side === 'BUY' ? bar.low <= open.sl : bar.high + spread >= open.sl;
      const hitTp = open.side === 'BUY' ? bar.high >= open.tp : bar.low + spread <= open.tp;
      if (hitSl || hitTp) {
        open.result = hitSl ? 'LOSS' : 'WIN';
        open.r = hitSl ? -1 : Math.abs(open.tp - open.entry) / open.risk;
        open.closedAtMs = toUtc(bar.timestamp).getTime() + tfMin * 60000;
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
      htfDir: htfDir ? htfDir[i] : undefined,
      daily: daily && dailyIdx && dailyIdx[i] >= 0 ? { candles: daily.candles, idx: dailyIdx[i] } : undefined,
      newsBlock: filters && news ? news.check(closeAt) : null,
      useFilters: filters,
    });
    if (!isSignal(result)) {
      if (WHY) {
        const key = `${v.strategy}:${v.timeframe} ${v.filters === false ? 'OFF' : 'ON'} | ${result.skip.replace(/-?[\d.]+/g, '#')}`;
        WHY.set(key, (WHY.get(key) ?? 0) + 1);
      }
      continue;
    }

    open = {
      openedAt: closeAt,
      index: i,
      result: 'OPEN',
      r: 0,
      day,
      side: result.side,
      entry: result.entryPrice,
      sl: result.stopLoss,
      tp: result.takeProfit,
      exit: result.exit ?? 'fixed',
      risk: Math.abs(result.entryPrice - result.stopLoss),
      sleeve: `${v.strategy}:${v.timeframe}`,
    };
    trades.push(open);
    today.n++;
    perDay.set(day, today);
  }
  return trades;
}

function summarize(trades: BtTrade[], ds: Dataset) {
  const done = trades.filter((t) => t.result !== 'OPEN');
  const split = Math.floor(ds.candles.length * 0.7);
  const wins = done.filter((t) => t.r > 0).length;
  const grossWin = done.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0);
  const grossLoss = -done.filter((t) => t.r < 0).reduce((s, t) => s + t.r, 0);
  const netR = done.reduce((s, t) => s + t.r, 0);
  const isR = done.filter((t) => t.index < split).reduce((s, t) => s + t.r, 0);
  const oosR = done.filter((t) => t.index >= split).reduce((s, t) => s + t.r, 0);
  let peak = 0, eq = 0, maxDd = 0, run = 0, maxRun = 0;
  for (const t of done) {
    eq += t.r;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
    run = t.r < 0 ? run + 1 : 0;
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
    pf: grossLoss > 0 ? grossWin / grossLoss : Infinity,
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


// ─────────────────────────────── portfolio + Monte Carlo ───────────────────────────────

interface Combined {
  trades: BtTrade[];
  weeks: number;
  startMs: number;
  endMs: number;
}

/** Merge per-strategy trades the way the live bot trades them: one position at a time, max trades/day shared */
function mergePortfolio(all: BtTrade[], startMs: number, endMs: number, maxPerDay: number = config.maxTradesPerDay): BtTrade[] {
  const sorted = all
    .filter((t) => t.result !== 'OPEN' && t.closedAtMs !== undefined && t.openedAt.getTime() >= startMs && t.openedAt.getTime() <= endMs)
    .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  const out: BtTrade[] = [];
  const perDay = new Map<string, { n: number; r: number }>();
  let busyUntil = 0;
  for (const t of sorted) {
    if (t.openedAt.getTime() < busyUntil) continue;
    const day = getZonedTime(t.openedAt).dateKey;
    const d = perDay.get(day) ?? { n: 0, r: 0 };
    if (d.n >= maxPerDay || d.r <= -maxPerDay) continue;
    d.n++;
    d.r += t.r;
    perDay.set(day, d);
    out.push(t);
    busyUntil = t.closedAtMs!;
  }
  return out;
}

function stats(trades: BtTrade[], weeks: number, splitMs: number) {
  const wins = trades.filter((t) => t.r > 0);
  const gw = wins.reduce((s, t) => s + t.r, 0);
  const gl = -trades.filter((t) => t.r < 0).reduce((s, t) => s + t.r, 0);
  const net = gw - gl;
  let peak = 0, eq = 0, dd = 0, run = 0, maxRun = 0;
  for (const t of trades) {
    eq += t.r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
    run = t.r < 0 ? run + 1 : 0;
    maxRun = Math.max(maxRun, run);
  }
  return {
    n: trades.length,
    perWeek: weeks > 0 ? trades.length / weeks : 0,
    win: trades.length ? (wins.length / trades.length) * 100 : 0,
    net,
    rWeek: weeks > 0 ? net / weeks : 0,
    is: trades.filter((t) => t.openedAt.getTime() < splitMs).reduce((s, t) => s + t.r, 0),
    oos: trades.filter((t) => t.openedAt.getTime() >= splitMs).reduce((s, t) => s + t.r, 0),
    pf: gl > 0 ? gw / gl : Infinity,
    dd,
    maxRun,
  };
}

function runPortfolio(
  sleeves: Sleeve[],
  datasets: Map<EntryTimeframe, Dataset>,
  spread: number,
  offsetMs: number,
  extrasFor: (s: StrategyName, tf: EntryTimeframe) => Extras
): void {
  const toUtcMs = (d: Date) => d.getTime() - offsetMs;
  for (const sl of sleeves) {
    const n = datasets.get(sl.timeframe)!.candles.length;
    if (n <= INDICATOR_WARMUP + 50) throw new Error(`${sl.timeframe}: only ${n} candles — need more history for ${sl.id}`);
  }
  const perSleeve: { sleeve: Sleeve; on: BtTrade[]; off: BtTrade[] }[] = [];
  for (const sl of sleeves) {
    const ds = datasets.get(sl.timeframe)!;
    const base: Variant = {
      strategy: sl.strategy,
      timeframe: sl.timeframe,
      session: { name: `${formatMinutes(sl.sessionStart)}-${formatMinutes(sl.sessionEnd)}`, start: sl.sessionStart, end: sl.sessionEnd },
      rewardRatio: sl.rewardRatio,
    };
    const ex = extrasFor(sl.strategy, sl.timeframe);
    perSleeve.push({
      sleeve: sl,
      on: runBacktest(ds, { ...base, filters: true }, spread, offsetMs, ex),
      off: runBacktest(ds, { ...base, filters: false }, spread, offsetMs, ex),
    });
  }

  // common window: every strategy has data and warmed-up indicators
  const startMs = Math.max(...sleeves.map((sl) => toUtcMs(datasets.get(sl.timeframe)!.candles[INDICATOR_WARMUP].timestamp)));
  const endMs = Math.min(...sleeves.map((sl) => {
    const c = datasets.get(sl.timeframe)!.candles;
    return toUtcMs(c[c.length - 1].timestamp);
  }));
  const weeks = (endMs - startMs) / (7 * 86400000);
  const splitMs = startMs + 0.7 * (endMs - startMs);
  console.log(`\nPortfolio window (all strategies have data): ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)} (${weeks.toFixed(1)} weeks)`);

  const hdr = 'Strategy'.padEnd(26) + 'Filt'.padEnd(5) + 'Trd'.padStart(5) + '/wk'.padStart(5) + 'Win%'.padStart(6) + 'NetR'.padStart(7) +
    'R/wk'.padStart(6) + 'IS R'.padStart(7) + 'OOS R'.padStart(7) + 'PF'.padStart(6) + 'DD R'.padStart(6) + 'LRun'.padStart(5);
  const row = (name: string, filt: string, x: ReturnType<typeof stats>) =>
    name.padEnd(26) + filt.padEnd(5) + String(x.n).padStart(5) + f(x.perWeek).padStart(5) + f(x.win, 0).padStart(6) + f(x.net).padStart(7) +
    f(x.rWeek, 2).padStart(6) + f(x.is).padStart(7) + f(x.oos).padStart(7) + f(x.pf, 2).padStart(6) + f(x.dd).padStart(6) + String(x.maxRun).padStart(5);

  console.log('\n=== EACH STRATEGY ALONE, same window (filters ON vs OFF) ===');
  console.log(hdr);
  const inWin = (ts: BtTrade[]) => ts.filter((t) => t.result !== 'OPEN' && t.openedAt.getTime() >= startMs && t.openedAt.getTime() <= endMs);
  for (const p of perSleeve) {
    const name = `${p.sleeve.id} 1:${p.sleeve.rewardRatio}`;
    console.log(row(name, 'ON', stats(inWin(p.on), weeks, splitMs)));
    console.log(row('', 'OFF', stats(inWin(p.off), weeks, splitMs)));
  }

  const combinedOn = mergePortfolio(perSleeve.flatMap((p) => p.on), startMs, endMs);
  const combinedOff = mergePortfolio(perSleeve.flatMap((p) => p.off), startMs, endMs);
  const sOn = stats(combinedOn, weeks, splitMs);
  const sOff = stats(combinedOff, weeks, splitMs);
  console.log('\n=== PORTFOLIO (one position at a time, max ' + config.maxTradesPerDay + '/day shared — exactly how the live bot trades) ===');
  console.log(hdr);
  console.log(row('ALL STRATEGIES', 'ON', sOn));
  console.log(row('ALL STRATEGIES', 'OFF', sOff));
  console.log('  contribution (filters ON): ' + perSleeve.map((p) => {
    const mine = combinedOn.filter((t) => t.sleeve === `${p.sleeve.strategy}:${p.sleeve.timeframe}`);
    return `${p.sleeve.id} ${mine.length} trades ${f(mine.reduce((s, t) => s + t.r, 0))}R`;
  }).join(' | '));

  const p1R = (config.accountBalance * 0.08) / config.riskPerTrade;
  const p2R = (config.accountBalance * 0.05) / config.riskPerTrade;
  const lossR = config.maxTotalLoss / config.riskPerTrade;
  const rs = combinedOn.map((t) => t.r);
  const oosRs = combinedOn.filter((t) => t.openedAt.getTime() >= splitMs).map((t) => t.r);
  const show = (label: string, series: number[]) => {
    const m1 = monteCarloPass(series, p1R, lossR);
    const m2 = monteCarloPass(series, p2R, lossR);
    const wk = (n: number) => (sOn.perWeek > 0 && Number.isFinite(n) ? f(n / sOn.perWeek, 0) : '∞');
    console.log(
      `  ${label.padEnd(22)} Phase 1 (${f(p1R)}R before −${f(lossR)}R): ${f(m1.pass * 100, 0)}% (median ${wk(m1.medianTrades)} wks) | ` +
        `Phase 2 (${f(p2R)}R): ${f(m2.pass * 100, 0)}% (median ${wk(m2.medianTrades)} wks) | both: ${f(m1.pass * m2.pass * 100, 0)}%`
    );
  };
  console.log(`\n=== MONTE CARLO (20,000 block-bootstrap runs of the portfolio's own trades, risk $${config.riskPerTrade}) ===`);
  show('all trades', rs);
  show('out-of-sample only', oosRs);

  console.log('\nLast 12 portfolio trades:');
  for (const t of combinedOn.slice(-12)) {
    console.log(`  ${t.openedAt.toISOString().slice(0, 16)} ${(t.sleeve ?? '').padEnd(24)} ${t.side} ${t.entry} SL ${t.sl.toFixed(2)} TP ${t.tp} → ${t.result} (${t.r.toFixed(2)}R)`);
  }
  printWhy();
  console.log('\nR = $' + config.riskPerTrade + ' | IS/OOS = first 70% / last 30% of the window | filters = news blackout (NFP/FOMC) + range vs D1 ATR');
  console.log('Not modelled: Groq review, slippage, swap, commission, news spread spikes. Monte Carlo assumes the future looks like this sample.');
}

/** Offline smoke test: ~2 years of random-walk M15 gold aggregated to every timeframe (server time = UTC+3) */
function syntheticMarket(): MarketDataSource {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const m15: CandleData[] = [];
  let price = 3300;
  const startMs = Date.UTC(2024, 9, 1, 3);
  for (let k = 0; m15.length < 50000; k++) {
    const t = new Date(startMs + k * 15 * 60000);
    const dow = t.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const hour = (t.getUTCHours() + 21) % 24; // UTC hour (bars are server time UTC+3)
    const vol = hour >= 12 && hour < 16 ? 7 : hour >= 7 && hour < 12 ? 4.5 : 2.5;
    const open = price;
    let hi = open, lo = open;
    for (let s = 0; s < 3; s++) {
      price += (rand() - 0.5) * vol * 2.2;
      hi = Math.max(hi, price);
      lo = Math.min(lo, price);
    }
    m15.push({ timestamp: t, open, high: hi + rand() * vol * 0.4, low: lo - rand() * vol * 0.4, close: price, volume: 100, closed: true });
  }
  const agg = (minutes: number): CandleData[] => {
    const out: CandleData[] = [];
    for (const c of m15) {
      const key = Math.floor(c.timestamp.getTime() / (minutes * 60000)) * minutes * 60000;
      const last = out[out.length - 1];
      if (last && last.timestamp.getTime() === key) {
        last.high = Math.max(last.high, c.high);
        last.low = Math.min(last.low, c.low);
        last.close = c.close;
      } else out.push({ ...c, timestamp: new Date(key) });
    }
    return out;
  };
  const byTf: Record<string, CandleData[]> = { M15: m15, M30: agg(30), H1: agg(60), H4: agg(240), D1: agg(1440) };
  const last = m15[m15.length - 1];
  return {
    name: 'SYNTH',
    isSimulated: true,
    async getCurrentPrice(pair: string) {
      return { pair, bid: last.close, ask: last.close + 0.3, spread: 3, timestamp: new Date(last.timestamp.getTime() + 15 * 60000) };
    },
    async getCandles(_pair: string, tf: string = 'H1', limit: number = 100) {
      return (byTf[tf] ?? byTf.H1).slice(-limit);
    },
  } as unknown as MarketDataSource;
}

async function main(): Promise<void> {
  const source = arg('source', config.dataSource) === 'mt5' ? 'mt5' : 'sim';
  // --source synth = long random-walk history (all timeframes) to smoke-test the pipeline offline
  const bars = Math.min(10000, parseInt(arg('bars', '5000'), 10));
  const matrix = process.argv.includes('--strategies') || process.argv.includes('--variants');
  const portfolio = process.argv.includes('--portfolio');
  const filtersOn = !process.argv.includes('--no-filters');
  const pair = PAIR_LIST[0];
  const spec = getPairSpec(pair);
  const market: MarketDataSource = arg('source', '') === 'synth' ? syntheticMarket() : createMarketDataSource(source);

  const quote = await market.getCurrentPrice(pair);
  const spread = Math.max(quote.ask - quote.bid, spec.pipSize);
  const offsetMs = arg('source', '') === 'synth' ? 3 * 3600000 : source === 'mt5' ? Math.round((quote.timestamp.getTime() - Date.now()) / 1800000) * 1800000 : 0;
  console.log(`Backtest ${pair} on ${source.toUpperCase()} | spread ${spread.toFixed(2)} | server offset ${(offsetMs / 3600000).toFixed(1)}h | risk $${config.riskPerTrade}/trade`);

  const only = arg('only', '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const names = STRATEGY_NAMES.filter((n) => only.length === 0 || only.includes(n));
  const sleeves: Sleeve[] = portfolio
    ? process.env.STRATEGIES
      ? config.sleeves
      : parseSleeves(DEFAULT_PORTFOLIO, config.sleeves[0])
    : [];
  const timeframes: EntryTimeframe[] = portfolio
    ? Array.from(new Set(sleeves.map((sl) => sl.timeframe)))
    : matrix
      ? Array.from(new Set(names.flatMap((n) => GRID[n].tfs)))
      : [config.entryTimeframe];
  // higher timeframes needed by HTF-filtered strategies (supertrend, emaRangeBreakout)
  const htfNeeds = portfolio
    ? sleeves.map((sl) => htfOf(sl.strategy, sl.timeframe))
    : matrix
      ? names.flatMap((n) => GRID[n].tfs.map((tf) => htfOf(n, tf)))
      : [htfOf(config.strategy, config.entryTimeframe)];
  for (const tf of htfNeeds) if (tf && !timeframes.includes(tf)) timeframes.push(tf);
  if (!timeframes.includes('D1')) timeframes.push('D1'); // D1 ATR filters + inside-day strategy
  const datasets = new Map<EntryTimeframe, Dataset>();
  for (const tf of timeframes) {
    datasets.set(tf, await loadDataset(market, tf, tf === 'H1' && !portfolio ? bars : 10000));
    const ds = datasets.get(tf)!;
    console.log(`  ${tf}: ${ds.candles.length} candles, ${f(ds.weeks, 0)} weeks`);
  }

  const d1 = datasets.get('D1')!;
  const allTimes = Array.from(datasets.values()).flatMap((d) => (d.candles.length ? [d.candles[0].timestamp, d.candles[d.candles.length - 1].timestamp] : []));
  const news = new NewsIndex(
    builtInEvents(new Date(Math.min(...allTimes.map((t) => t.getTime())) - 86400000), new Date(Math.max(...allTimes.map((t) => t.getTime())) + 86400000))
  );
  const extrasFor = (strategy: StrategyName, tf: EntryTimeframe): Extras => {
    const ds = datasets.get(tf)!;
    const htfTf = htfOf(strategy, tf);
    return {
      htfDir: htfTf && datasets.has(htfTf) ? mapHtfDir(strategy, ds, tf, datasets.get(htfTf)!, htfTf) : undefined,
      daily: d1,
      dailyIdx: mapDailyIdx(ds, d1),
      news,
    };
  };

  if (portfolio) {
    runPortfolio(sleeves, datasets, spread, offsetMs, extrasFor);
    return;
  }

  const variants: Variant[] = [];
  if (matrix) {
    for (const strategy of names)
      for (const timeframe of GRID[strategy].tfs)
        for (const session of GRID[strategy].sessions)
          for (const rewardRatio of GRID[strategy].rr) variants.push({ strategy, timeframe, session, rewardRatio, filters: filtersOn });
    console.log(`  ${variants.length} combinations to test...`);
  } else {
    variants.push({
      strategy: config.strategy,
      timeframe: config.entryTimeframe,
      session: { name: `${formatMinutes(config.sessionStart)}-${formatMinutes(config.sessionEnd)}`, start: config.sessionStart, end: config.sessionEnd },
      rewardRatio: config.profitRatio,
      filters: filtersOn,
    });
  }

  const rows = variants.map((v) => {
    const ds = datasets.get(v.timeframe)!;
    const trades = runBacktest(ds, v, spread, offsetMs, extrasFor(v.strategy, v.timeframe));
    return { v, ds, trades, s: summarize(trades, ds) };
  });

  const header =
    'Strategy'.padEnd(18) + 'TF'.padEnd(5) + 'Session'.padEnd(8) + 'RR'.padStart(4) + 'Wks'.padStart(5) + 'Trd'.padStart(5) +
    '/wk'.padStart(5) + 'Win%'.padStart(6) + 'NetR'.padStart(7) + 'IS R'.padStart(7) + 'OOS R'.padStart(7) + 'PF'.padStart(6) +
    'DD R'.padStart(6) + 'LRun'.padStart(5) + 'P1 wk'.padStart(7) + 'P2 wk'.padStart(7);
  const line = (r: (typeof rows)[number]) =>
    r.v.strategy.padEnd(18) + r.v.timeframe.padEnd(5) + r.v.session.name.padEnd(8) + (r.v.rewardRatio === 0 ? 'trl' : f(r.v.rewardRatio)).padStart(4) +
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
      console.log(`  ${t.openedAt.toISOString().slice(0, 16)} ${t.side} ${t.entry} SL ${t.sl.toFixed(2)} ${t.exit === "supertrend" ? "trail" : `TP ${t.tp}`} → ${t.result} (${t.r.toFixed(2)}R)`);
    }
  }

  printWhy();
  console.log(`Filters (news blackout + range vs D1 ATR): ${filtersOn ? 'ON' : 'OFF (--no-filters)'}`);
  console.log('\nR = $' + config.riskPerTrade + '. IS/OOS = first 70% / last 30% of history. PF > 1.3 decent. DD R = max drawdown (limit 13.3 R).');
  console.log('P1/P2 wk = weeks to the phase target at this pace (5 trading days also required). Not modelled: Groq, slippage, swap, commission.');
}

main().catch((error) => {
  console.error('Backtest failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
