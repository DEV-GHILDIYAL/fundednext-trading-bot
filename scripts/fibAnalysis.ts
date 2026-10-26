/**
 * Offline research for the Fib Sweep strategy on downloaded MT5 history (npm run fetch-history first).
 * Read-only: uses the same strategy code as the live bot, changes nothing.
 *
 *   npm run fib-analysis
 *   npm run fib-analysis -- --spread 0.5 --data data/history
 *
 * Compares the strategy as-is with trend filters (SHORT only in a downtrend, LONG only in an uptrend),
 * month by month, by trend regime, first half vs second half, plus Monte Carlo pass odds.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../src/config';
import { CandleData } from '../src/api/market';
import { computeIndicators, ema } from '../src/strategies/indicators';
import { evaluateStrategy, isSignal } from '../src/strategies/library';
import { defaultStrategyParams } from '../src/strategies/entrySignalGenerator';
import { builtInEvents, majorNewsDays, NewsIndex } from '../src/strategies/news';
import { getZonedTime, serverToUtc } from '../src/utils/time';
import { monteCarloPass } from '../src/utils/monteCarlo';
import { PAIR_LIST } from '../src/constants/pairs';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

function loadCsv(file: string): CandleData[] {
  if (!fs.existsSync(file)) throw new Error(`${file} not found — run: npm run fetch-history`);
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => {
      const [t, o, h, lo, c, v] = l.split(',');
      return { timestamp: new Date(t), open: +o, high: +h, low: +lo, close: +c, volume: +v, closed: true };
    });
}

interface Trade {
  openedAt: Date; // real UTC
  side: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number;
  r: number;
  index: number;
  trendH1: number; // H1 EMA50/200 at entry
}

const pair = PAIR_LIST[0];
const istKey = (d: Date) => getZonedTime(d, 'Asia/Kolkata').dateKey;
const f = (n: number, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '∞');

/** Trend of a higher timeframe, known at each M5 close (last CLOSED higher-TF bar) */
function mapTrend(m5: CandleData[], htf: CandleData[], htfMinutes: number, dirAt: (j: number) => number): number[] {
  const out = new Array<number>(m5.length).fill(0);
  let j = -1;
  for (let i = 0; i < m5.length; i++) {
    const closeAt = m5[i].timestamp.getTime() + 5 * 60000;
    while (j + 1 < htf.length && htf[j + 1].timestamp.getTime() + htfMinutes * 60000 <= closeAt) j++;
    if (j >= 0) out[i] = dirAt(j);
  }
  return out;
}

function simulate(
  m5: CandleData[],
  ind: ReturnType<typeof computeIndicators>,
  spread: number,
  news: NewsIndex,
  majorDays: Map<string, string>,
  trendH1: number[],
  filter?: number[],
  rules: { colour: boolean; maxTrades: number } = { colour: true, maxTrades: 1 }
): Trade[] {
  const trades: Trade[] = [];
  let open: Trade | null = null;
  for (let i = 300; i < m5.length - 1; i++) {
    const bar = m5[i];
    if (open) {
      const buy = open.side === 'BUY';
      const hitSl = buy ? bar.low <= open.sl : bar.high + spread >= open.sl;
      const hitTp = buy ? bar.high >= open.tp : bar.low + spread <= open.tp;
      if (hitSl || hitTp) {
        open.r = hitSl ? -1 : Math.abs(open.tp - open.entry) / Math.abs(open.entry - open.sl);
        open = null;
      }
      if (open || hitSl || hitTp) continue;
    }
    const closeUtc = new Date(serverToUtc(bar.timestamp).getTime() + 5 * 60000);
    const ist = getZonedTime(serverToUtc(bar.timestamp), 'Asia/Kolkata').minutesOfDay;
    if (ist < 14 * 60 + 30 || ist >= 21 * 60) continue;
    const bid = m5[i + 1].open;
    const day = majorDays.get(istKey(closeUtc));
    const r = evaluateStrategy('fibSweep', {
      pair,
      candles: m5,
      i,
      ind,
      quote: { pair, bid, ask: bid + spread, spread: parseFloat((spread * 10).toFixed(1)), timestamp: closeUtc },
      tfMinutes: 5,
      rewardRatio: 2,
      slMinAtr: config.slMinAtr,
      slMaxAtr: config.slMaxAtr,
      minAtrPips: 0,
      maxSpreadPips: 100,
      breakout: defaultStrategyParams(),
      toUtc: serverToUtc,
      newsBlock: news.check(closeUtc),
      newsDay: day ? `Major US news day (${day})` : null,
      fibTrend: filter,
      fibColour: rules.colour,
      fibMaxTrades: rules.maxTrades,
    });
    if (!isSignal(r)) continue;
    open = { openedAt: closeUtc, side: r.side, entry: r.entryPrice, sl: r.stopLoss, tp: r.takeProfit, r: 0, index: i, trendH1: trendH1[i] };
    trades.push(open);
  }
  return trades.filter((t) => t.r !== 0);
}

function stats(ts: Trade[], weeks: number, splitIdx: number) {
  const wins = ts.filter((t) => t.r > 0);
  const gw = wins.reduce((a, t) => a + t.r, 0);
  const gl = -ts.filter((t) => t.r < 0).reduce((a, t) => a + t.r, 0);
  let eq = 0, peak = 0, dd = 0, run = 0, maxRun = 0;
  for (const t of ts) {
    eq += t.r;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
    run = t.r < 0 ? run + 1 : 0;
    maxRun = Math.max(maxRun, run);
  }
  const side = (s: 'BUY' | 'SELL') => {
    const x = ts.filter((t) => t.side === s);
    return { n: x.length, win: x.length ? (x.filter((t) => t.r > 0).length / x.length) * 100 : 0, r: x.reduce((a, t) => a + t.r, 0) };
  };
  return {
    n: ts.length,
    perWeek: weeks > 0 ? ts.length / weeks : 0,
    win: ts.length ? (wins.length / ts.length) * 100 : 0,
    net: gw - gl,
    pf: gl > 0 ? gw / gl : Infinity,
    dd,
    maxRun,
    buy: side('BUY'),
    sell: side('SELL'),
    h1: ts.filter((t) => t.index < splitIdx).reduce((a, t) => a + t.r, 0),
    h2: ts.filter((t) => t.index >= splitIdx).reduce((a, t) => a + t.r, 0),
  };
}

function main(): void {
  const dir = arg('data', 'data/history');
  const spread = parseFloat(arg('spread', '0.5'));
  const m5 = loadCsv(path.join(dir, `${pair}_M5.csv`));
  const h1 = loadCsv(path.join(dir, `${pair}_H1.csv`));
  const d1 = loadCsv(path.join(dir, `${pair}_D1.csv`));
  const ind = computeIndicators(m5);
  const first = serverToUtc(m5[0].timestamp);
  const last = serverToUtc(m5[m5.length - 1].timestamp);
  const weeks = (last.getTime() - first.getTime()) / (7 * 86400000);
  const splitIdx = Math.floor(m5.length / 2);

  const events = builtInEvents(new Date(first.getTime() - 86400000), new Date(last.getTime() + 86400000));
  const news = new NewsIndex(events);
  const majorDays = majorNewsDays(events);

  // trend definitions
  const h1Ind = computeIndicators(h1);
  const trendH1Ema = mapTrend(m5, h1, 60, (j) => (Number.isFinite(h1Ind.ema200[j]) ? Math.sign(h1Ind.ema50[j] - h1Ind.ema200[j]) : 0));
  const trendH1Price = mapTrend(m5, h1, 60, (j) => (Number.isFinite(h1Ind.ema200[j]) ? Math.sign(h1[j].close - h1Ind.ema200[j]) : 0));
  const d1Ema20 = ema(d1.map((c) => c.close), 20);
  const trendD1 = mapTrend(m5, d1, 1440, (j) => (Number.isFinite(d1Ema20[j]) ? Math.sign(d1[j].close - d1Ema20[j]) : 0));
  const trendD1Slope = mapTrend(m5, d1, 1440, (j) => (j >= 5 && Number.isFinite(d1Ema20[j - 5]) ? Math.sign(d1Ema20[j] - d1Ema20[j - 5]) : 0));

  console.log(`Fib Sweep research — ${pair} M5 from MT5, ${first.toISOString().slice(0, 10)} → ${last.toISOString().slice(0, 10)} (${f(weeks, 0)} weeks, ${m5.length} candles)`);
  console.log(`Gold moved ${f(m5[0].open)} → ${f(m5[m5.length - 1].close)} (${f(((m5[m5.length - 1].close - m5[0].open) / m5[0].open) * 100)}%) | spread $${spread} | news days skipped: ${majorDays.size}`);
  const upShare = (arr: number[]) => (arr.filter((x) => x > 0).length / Math.max(1, arr.filter((x) => x !== 0).length)) * 100;
  console.log(`Time in uptrend: H1 EMA50>200 ${f(upShare(trendH1Ema), 0)}% · D1 close>EMA20 ${f(upShare(trendD1), 0)}%`);

  // ── rule changes (no trend filter) ──
  const ruleSets: [string, { colour: boolean; maxTrades: number }][] = [
    ['A  PDF original (2/day)', { colour: false, maxTrades: 2 }],
    ['B  + candle colour (2/day)', { colour: true, maxTrades: 2 }],
    ['C  + colour, 1 trade/day', { colour: true, maxTrades: 1 }],
  ];
  const ruleRes = ruleSets.map(([name, rules]) => ({ name, trades: simulate(m5, ind, spread, news, majorDays, trendH1Ema, undefined, rules) }));
  console.log('\n=== RULE CHANGES (same data, no trend filter) ===');
  console.log('Variant'.padEnd(28) + 'Trd'.padStart(5) + '/wk'.padStart(5) + 'Win%'.padStart(6) + 'NetR'.padStart(7) + 'PF'.padStart(6) + 'DD R'.padStart(6) + 'LRun'.padStart(5) + '  BUY n/win%/R'.padEnd(20) + 'SELL n/win%/R'.padEnd(18) + '1st½ R'.padStart(7) + '2nd½ R'.padStart(7));
  for (const r of ruleRes) {
    const s = stats(r.trades, weeks, splitIdx);
    console.log(
      r.name.padEnd(28) + String(s.n).padStart(5) + f(s.perWeek).padStart(5) + f(s.win, 0).padStart(6) + f(s.net).padStart(7) + f(s.pf, 2).padStart(6) +
        f(s.dd).padStart(6) + String(s.maxRun).padStart(5) + `  ${s.buy.n}/${f(s.buy.win, 0)}%/${f(s.buy.r)}`.padEnd(20) +
        `${s.sell.n}/${f(s.sell.win, 0)}%/${f(s.sell.r)}`.padEnd(18) + f(s.h1).padStart(7) + f(s.h2).padStart(7)
    );
  }
  const months0 = Array.from(new Set(m5.map((c) => serverToUtc(c.timestamp).toISOString().slice(0, 7))));
  console.log('\n=== MONTHLY P&L — A (PDF) vs C (colour + 1/day), risk $' + config.riskPerTrade + ' per trade ===');
  console.log('Month'.padEnd(9) + '   A trd/win%/R/$'.padEnd(28) + '   C trd/win%/R/$');
  const cellM = (ts: Trade[], mo: string) => {
    const x = ts.filter((t) => t.openedAt.toISOString().slice(0, 7) === mo);
    const r = x.reduce((a, t) => a + t.r, 0);
    return `${x.length}/${f(x.length ? (x.filter((t) => t.r > 0).length / x.length) * 100 : 0, 0)}%/${f(r)}R/${r * config.riskPerTrade >= 0 ? '+' : '−'}$${Math.abs(r * config.riskPerTrade).toFixed(0)}`;
  };
  for (const mo of months0) console.log(mo.padEnd(9) + `   ${cellM(ruleRes[0].trades, mo)}`.padEnd(28) + `   ${cellM(ruleRes[2].trades, mo)}`);
  for (const r of [ruleRes[0], ruleRes[2]]) {
    const net = r.trades.reduce((a, t) => a + t.r, 0);
    const perMonth = net / (weeks / 4.345);
    console.log(`  ${r.name.trim()}: average ${f(perMonth)}R/month ≈ $${(perMonth * config.riskPerTrade).toFixed(0)}/month at $${config.riskPerTrade} risk`);
  }

  const variants: [string, number[] | undefined][] = [
    ['As-is (no filter)', undefined],
    ['H1 EMA50 vs EMA200', trendH1Ema],
    ['H1 close vs EMA200', trendH1Price],
    ['D1 close vs EMA20', trendD1],
    ['D1 EMA20 slope (5d)', trendD1Slope],
  ];
  const results = variants.map(([name, tr]) => ({ name, trades: simulate(m5, ind, spread, news, majorDays, trendH1Ema, tr) }));

  console.log('\n=== TREND FILTERS on top of C (only trade in the trend direction) ===');
  console.log(
    'Variant'.padEnd(22) + 'Trd'.padStart(5) + '/wk'.padStart(5) + 'Win%'.padStart(6) + 'NetR'.padStart(7) + 'PF'.padStart(6) + 'DD R'.padStart(6) +
      'LRun'.padStart(5) + '  BUY n/win%/R'.padEnd(20) + 'SELL n/win%/R'.padEnd(18) + '1st½ R'.padStart(7) + '2nd½ R'.padStart(7)
  );
  for (const r of results) {
    const s = stats(r.trades, weeks, splitIdx);
    console.log(
      r.name.padEnd(22) + String(s.n).padStart(5) + f(s.perWeek).padStart(5) + f(s.win, 0).padStart(6) + f(s.net).padStart(7) + f(s.pf, 2).padStart(6) +
        f(s.dd).padStart(6) + String(s.maxRun).padStart(5) + `  ${s.buy.n}/${f(s.buy.win, 0)}%/${f(s.buy.r)}`.padEnd(20) +
        `${s.sell.n}/${f(s.sell.win, 0)}%/${f(s.sell.r)}`.padEnd(18) + f(s.h1).padStart(7) + f(s.h2).padStart(7)
    );
  }

  // regime analysis of the unfiltered strategy
  const base = results[0].trades;
  console.log('\n=== AS-IS TRADES BY H1 TREND AT ENTRY (does a LONG sweep work in an uptrend?) ===');
  console.log('Group'.padEnd(34) + 'Trades'.padStart(7) + 'Win%'.padStart(7) + 'Net R'.padStart(8));
  const grp = (label: string, ts: Trade[]) =>
    console.log(label.padEnd(34) + String(ts.length).padStart(7) + f(ts.length ? (ts.filter((t) => t.r > 0).length / ts.length) * 100 : 0, 0).padStart(7) + f(ts.reduce((a, t) => a + t.r, 0)).padStart(8));
  grp('LONG  in UPtrend   (with trend)', base.filter((t) => t.side === 'BUY' && t.trendH1 > 0));
  grp('LONG  in DOWNtrend (against)', base.filter((t) => t.side === 'BUY' && t.trendH1 < 0));
  grp('SHORT in DOWNtrend (with trend)', base.filter((t) => t.side === 'SELL' && t.trendH1 < 0));
  grp('SHORT in UPtrend   (against)', base.filter((t) => t.side === 'SELL' && t.trendH1 > 0));

  // month by month
  const best = results.slice(1).sort((a, b) => stats(b.trades, weeks, splitIdx).net - stats(a.trades, weeks, splitIdx).net)[0];
  console.log(`\n=== MONTH BY MONTH: as-is vs best filter (${best.name}) ===`);
  console.log('Month'.padEnd(9) + 'Gold %'.padStart(8) + '   As-is trd/win%/R'.padEnd(22) + `   Filter trd/win%/R`);
  const months = Array.from(new Set(m5.map((c) => serverToUtc(c.timestamp).toISOString().slice(0, 7))));
  for (const mo of months) {
    const bars = m5.filter((c) => serverToUtc(c.timestamp).toISOString().slice(0, 7) === mo);
    const move = ((bars[bars.length - 1].close - bars[0].open) / bars[0].open) * 100;
    const cell = (ts: Trade[]) => {
      const x = ts.filter((t) => t.openedAt.toISOString().slice(0, 7) === mo);
      return `${x.length}/${f(x.length ? (x.filter((t) => t.r > 0).length / x.length) * 100 : 0, 0)}%/${f(x.reduce((a, t) => a + t.r, 0))}`;
    };
    console.log(mo.padEnd(9) + `${move >= 0 ? '+' : ''}${f(move)}%`.padStart(8) + `   ${cell(base)}`.padEnd(22) + `   ${cell(best.trades)}`);
  }

  // Monte Carlo
  const p1R = (config.accountBalance * 0.08) / config.riskPerTrade;
  const p2R = (config.accountBalance * 0.05) / config.riskPerTrade;
  const lossR = config.maxTotalLoss / config.riskPerTrade;
  console.log(`\n=== MONTE CARLO pass odds (risk $${config.riskPerTrade}: Phase 1 = ${f(p1R)}R, Phase 2 = ${f(p2R)}R, max loss ${f(lossR)}R) ===`);
  for (const r of results) {
    const rs = r.trades.map((t) => t.r);
    const s = stats(r.trades, weeks, splitIdx);
    const m1 = monteCarloPass(rs, p1R, lossR);
    const m2 = monteCarloPass(rs, p2R, lossR);
    const wk = (n: number) => (s.perWeek > 0 && Number.isFinite(n) ? f(n / s.perWeek, 0) : '∞');
    console.log(`  ${r.name.padEnd(22)} P1 ${f(m1.pass * 100, 0)}% (~${wk(m1.medianTrades)} wks) · P2 ${f(m2.pass * 100, 0)}% (~${wk(m2.medianTrades)} wks) · both ${f(m1.pass * m2.pass * 100, 0)}%`);
  }

  console.log('\nHow to read: a filter is only worth applying if it improves BOTH halves and most months, and LONG-with-uptrend');
  console.log('is not negative (otherwise the "filter" is just "short only" fitted to a falling market).');
  console.log('Not modelled: Groq review, slippage, spread spikes. Fill = next M5 open ± spread; SL+TP in one candle → SL.');
}

main();
