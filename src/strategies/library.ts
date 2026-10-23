/**
 * Strategy library — every strategy is a pure function of closed candles + indicators,
 * so the live bot and the backtest run exactly the same code.
 *
 *   breakout       London breakout of the last-24h range (original strategy)
 *   trendPullback  EMA50/200 trend, buy/sell the pullback to EMA20 on a rejection candle
 *   asianBreakout  first close beyond the Asian session range (00:00–07:00 London)
 *   meanReversion  RSI(14) back from <30 / >70, only in the EMA200 trend direction
 *   emaCross       EMA9 crosses EMA21 in the EMA200 trend direction
 *   donchian       close beyond the 20-candle high/low in the EMA200 trend direction
 *
 * Objective versions of well-known educators' strategies (interpretations, not their exact method):
 *   turtle20/55    Turtle channel breakout (Kivanc Ozbilgic's AlgoWorld implementation): 20/55-bar break, 2×ATR stop
 *   volBreakout    Larry Williams volatility breakout: today's open ± 0.5 × yesterday's range, one per day
 *   pinBar         Nial Fuller price action: pin bar at a swing level or inside-bar breakout, with the trend
 *   raynerEma      Rayner Teo: EMA20>EMA50 trend, pullback into the 20/50 zone that has held twice
 *   ictSilverBullet ICT Silver Bullet: NY 03–04/10–11/14–15, sweep → FVG → retest, stop beyond the sweep
 *   casperSmc      Casper SMC continuation: NY 07:30–10:30, liquidity taken → pullback → displacement (ChoCH)
 *   supertrend     SupertrendGold Prop EA: ST(10,3) direction + ADX≥22 + ≤2 flips/30 bars + higher-TF ST agrees;
 *                  SL = ST line ± $3.5, NO fixed TP — exit when a candle closes beyond the line (trailing)
 *   emaRangeBreakout XAUUSD EMA Breakout EA: higher-TF close vs EMA200 trend, entry-TF close beyond the
 *                  previous 10 candles' range, SL = other side of range ± 0.5 ATR, TP = R × SL; server hours 8–12, 14–19
 *
 * Every strategy: stop distance clamped to [slMinAtr, slMaxAtr] × ATR, TP = rewardRatio × stop.
 */
import { CandleData, PriceData, computeAtrPips } from '../api/market';
import { getPairSpec } from '../constants/pairs';
import { getZonedTime } from '../utils/time';
import { Indicators } from './indicators';
import { EntrySignalGenerator, StrategyParams, minClosedCandles } from './entrySignalGenerator';

export const STRATEGY_NAMES = [
  'breakout',
  'trendPullback',
  'asianBreakout',
  'meanReversion',
  'emaCross',
  'donchian',
  'turtle20',
  'turtle55',
  'volBreakout',
  'pinBar',
  'raynerEma',
  'ictSilverBullet',
  'casperSmc',
  'supertrend',
  'emaRangeBreakout',
] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

export function isStrategyName(value: string): value is StrategyName {
  return (STRATEGY_NAMES as readonly string[]).includes(value);
}

export interface LibContext {
  pair: string;
  /** Closed candles, oldest first */
  candles: CandleData[];
  /** Index of the candle that just closed (the signal candle) */
  i: number;
  ind: Indicators;
  /** Quote used for the entry (ask for BUY, bid for SELL) */
  quote: PriceData;
  tfMinutes: number;
  rewardRatio: number;
  slMinAtr: number;
  slMaxAtr: number;
  minAtrPips: number;
  maxSpreadPips: number;
  /** Parameters for the original breakout strategy */
  breakout: StrategyParams;
  /** Bar timestamps → real UTC (MT5 bars carry broker server time) */
  toUtc: (d: Date) => Date;
  /**
   * Higher-timeframe trend at this bar: supertrend → HTF Supertrend direction,
   * emaRangeBreakout → sign of (last closed HTF close − HTF EMA200)
   */
  htfDir?: number;
}

export interface LibSignal {
  side: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss: number;
  /** 0 when the strategy has no fixed target (trailing exit) */
  takeProfit: number;
  reason: string;
  /** fixed = SL/TP only; supertrend = trail SL to the ST line and exit on a close beyond it */
  exit?: 'fixed' | 'supertrend';
}

/** SupertrendGold EA settings (defaults of the user's MQL5 EA v1.10) */
export const SUPERTREND_EA = {
  slBuffer: 3.5,
  adxMin: 22,
  flipLookback: 30,
  maxFlips: 2,
  minDistAtr: 0.7,
  maxDistAtr: 4.5,
  sessionStartHour: 9, // broker server time
  sessionEndHour: 22,
  fridayCloseHour: 21,
};

export type LibResult = LibSignal | { skip: string };

export function isSignal(r: LibResult): r is LibSignal {
  return 'side' in r;
}

const skip = (reason: string): LibResult => ({ skip: reason });

function round(pair: string, v: number): number {
  return parseFloat(v.toFixed(getPairSpec(pair).digits));
}

/** Build the order: entry at bid/ask, stop clamped by ATR, TP = R × stop */
function build(ctx: LibContext, side: 'BUY' | 'SELL', structuralStop: number, reason: string): LibResult {
  const a = ctx.ind.atr14[ctx.i];
  const entry = side === 'BUY' ? ctx.quote.ask : ctx.quote.bid;
  let dist = side === 'BUY' ? entry - structuralStop : structuralStop - entry;
  if (!(dist > 0)) dist = a * ctx.slMinAtr;
  dist = Math.min(Math.max(dist, a * ctx.slMinAtr), a * ctx.slMaxAtr);
  if (!(dist > 0)) return skip('Invalid stop distance');
  const sl = side === 'BUY' ? entry - dist : entry + dist;
  const tp = side === 'BUY' ? entry + dist * ctx.rewardRatio : entry - dist * ctx.rewardRatio;
  return { side, entryPrice: round(ctx.pair, entry), stopLoss: round(ctx.pair, sl), takeProfit: round(ctx.pair, tp), reason };
}

function commonFilters(ctx: LibContext): string | null {
  const a = ctx.ind.atr14[ctx.i];
  if (!Number.isFinite(a) || !Number.isFinite(ctx.ind.ema200[ctx.i])) return 'Indicators warming up';
  const atrPips = a / getPairSpec(ctx.pair).pipSize;
  if (atrPips < ctx.minAtrPips) return `ATR ${atrPips.toFixed(0)} < min ${ctx.minAtrPips.toFixed(0)} pips`;
  if (ctx.quote.spread > ctx.maxSpreadPips) return `Spread ${ctx.quote.spread} > max ${ctx.maxSpreadPips} pips`;
  return null;
}

// ─────────────────────────────── strategies ───────────────────────────────

function breakout(ctx: LibContext): LibResult {
  const needed = minClosedCandles(ctx.breakout.rangeBars);
  if (ctx.i + 1 < needed) return skip('Not enough candles');
  const slice = ctx.candles.slice(Math.max(0, ctx.i + 1 - needed - 40), ctx.i + 1);
  const spec = getPairSpec(ctx.pair);
  const s = EntrySignalGenerator.generateTradeSignal(
    { pair: ctx.pair, quote: ctx.quote, candles: slice, atrPips: computeAtrPips(slice, spec.pipSize, 14) },
    { ...ctx.breakout, rewardRatio: ctx.rewardRatio, slMinAtr: ctx.slMinAtr, slMaxAtr: ctx.slMaxAtr, maxSpreadPips: ctx.maxSpreadPips, minAtrPips: ctx.minAtrPips }
  );
  if (s.signal === 'SKIP') return skip(s.reasoning.replace(/^Skipped:\s*/, ''));
  return { side: s.signal, entryPrice: s.entryPrice, stopLoss: s.stopLoss, takeProfit: s.takeProfit, reason: s.reasoning };
}

function trendPullback(ctx: LibContext): LibResult {
  const { candles: c, i, ind } = ctx;
  if (i < 6) return skip('Not enough candles');
  const a = ind.atr14[i];
  const bar = c[i];
  const up = ind.ema50[i] > ind.ema200[i] && bar.close > ind.ema200[i] && ind.ema50[i] > ind.ema50[i - 5];
  const down = ind.ema50[i] < ind.ema200[i] && bar.close < ind.ema200[i] && ind.ema50[i] < ind.ema50[i - 5];
  const zone = 0.1 * a;
  if (up) {
    const touched = bar.low <= ind.ema20[i] + zone || c[i - 1].low <= ind.ema20[i - 1] + zone;
    const rejected = bar.close > ind.ema20[i] && bar.close > bar.open;
    if (touched && rejected) {
      const stop = Math.min(bar.low, c[i - 1].low) - 0.2 * a;
      return build(ctx, 'BUY', stop, 'Uptrend (EMA50>EMA200), pullback to EMA20 rejected');
    }
  } else if (down) {
    const touched = bar.high >= ind.ema20[i] - zone || c[i - 1].high >= ind.ema20[i - 1] - zone;
    const rejected = bar.close < ind.ema20[i] && bar.close < bar.open;
    if (touched && rejected) {
      const stop = Math.max(bar.high, c[i - 1].high) + 0.2 * a;
      return build(ctx, 'SELL', stop, 'Downtrend (EMA50<EMA200), pullback to EMA20 rejected');
    }
  }
  return skip(up || down ? 'Trend but no pullback rejection' : 'No clear EMA trend');
}

function asianBreakout(ctx: LibContext): LibResult {
  const { candles: c, i } = ctx;
  const tfMs = ctx.tfMinutes * 60000;
  const london = (d: Date) => getZonedTime(ctx.toUtc(d), 'Europe/London');
  const closeT = getZonedTime(new Date(ctx.toUtc(c[i].timestamp).getTime() + tfMs), 'Europe/London');
  if (closeT.minutesOfDay < 7 * 60) return skip('Asian session still running');

  let high = -Infinity;
  let low = Infinity;
  let bars = 0;
  for (let j = i; j >= 0 && j > i - 40; j--) {
    const t = london(c[j].timestamp);
    if (t.dateKey !== closeT.dateKey) break;
    if (t.minutesOfDay < 7 * 60) {
      high = Math.max(high, c[j].high);
      low = Math.min(low, c[j].low);
      bars++;
    }
  }
  const needBars = Math.max(2, Math.floor((5 * 60) / ctx.tfMinutes));
  if (bars < needBars) return skip('No complete Asian range today');

  const mid = (high + low) / 2;
  if (c[i].close > high && c[i - 1].close <= high) return build(ctx, 'BUY', mid, `Close above Asian high ${high}`);
  if (c[i].close < low && c[i - 1].close >= low) return build(ctx, 'SELL', mid, `Close below Asian low ${low}`);
  return skip('No Asian range breakout');
}

function meanReversion(ctx: LibContext): LibResult {
  const { candles: c, i, ind } = ctx;
  if (i < 2) return skip('Not enough candles');
  const r0 = ind.rsi14[i - 1];
  const r1 = ind.rsi14[i];
  const a = ind.atr14[i];
  if (r0 < 30 && r1 >= 30 && c[i].close > ind.ema200[i]) {
    return build(ctx, 'BUY', Math.min(c[i].low, c[i - 1].low) - 0.3 * a, `RSI back above 30 (${r1.toFixed(0)}) in uptrend`);
  }
  if (r0 > 70 && r1 <= 70 && c[i].close < ind.ema200[i]) {
    return build(ctx, 'SELL', Math.max(c[i].high, c[i - 1].high) + 0.3 * a, `RSI back below 70 (${r1.toFixed(0)}) in downtrend`);
  }
  return skip('No RSI reversal');
}

function emaCross(ctx: LibContext): LibResult {
  const { candles: c, i, ind } = ctx;
  if (i < 2) return skip('Not enough candles');
  const crossUp = ind.ema9[i - 1] <= ind.ema21[i - 1] && ind.ema9[i] > ind.ema21[i];
  const crossDown = ind.ema9[i - 1] >= ind.ema21[i - 1] && ind.ema9[i] < ind.ema21[i];
  const a = ind.atr14[i];
  if (crossUp && c[i].close > ind.ema200[i]) return build(ctx, 'BUY', c[i].close - 1.5 * a, 'EMA9 crossed above EMA21, above EMA200');
  if (crossDown && c[i].close < ind.ema200[i]) return build(ctx, 'SELL', c[i].close + 1.5 * a, 'EMA9 crossed below EMA21, below EMA200');
  return skip('No EMA cross');
}

function donchian(ctx: LibContext): LibResult {
  const { candles: c, i, ind } = ctx;
  const n = 20;
  if (i < n + 1) return skip('Not enough candles');
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i - n; j < i; j++) {
    hi = Math.max(hi, c[j].high);
    lo = Math.min(lo, c[j].low);
  }
  const a = ind.atr14[i];
  if (c[i].close > hi && c[i - 1].close <= hi && c[i].close > ind.ema200[i]) return build(ctx, 'BUY', c[i].close - 1.5 * a, `Close above 20-bar high ${hi}`);
  if (c[i].close < lo && c[i - 1].close >= lo && c[i].close < ind.ema200[i]) return build(ctx, 'SELL', c[i].close + 1.5 * a, `Close below 20-bar low ${lo}`);
  return skip('No 20-bar breakout');
}

// ─────────────────────────────── named educators' strategies ───────────────────────────────

/** Turtle channel breakout (no trend filter), initial stop 2 × ATR */
function turtle(n: number) {
  return (ctx: LibContext): LibResult => {
    const { candles: c, i, ind } = ctx;
    if (i < n + 1) return skip('Not enough candles');
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n; j < i; j++) {
      hi = Math.max(hi, c[j].high);
      lo = Math.min(lo, c[j].low);
    }
    const a = ind.atr14[i];
    if (c[i].close > hi && c[i - 1].close <= hi) return build(ctx, 'BUY', c[i].close - 2 * a, `Turtle: close above ${n}-bar high ${hi}`);
    if (c[i].close < lo && c[i - 1].close >= lo) return build(ctx, 'SELL', c[i].close + 2 * a, `Turtle: close below ${n}-bar low ${lo}`);
    return skip(`No ${n}-bar breakout`);
  };
}

const serverDay = (d: Date) => d.toISOString().slice(0, 10);

/** Larry Williams volatility breakout from today's open by k × yesterday's range (broker day) */
function volBreakout(ctx: LibContext, k: number = 0.5): LibResult {
  const { candles: c, i } = ctx;
  const today = serverDay(c[i].timestamp);
  let first = i;
  while (first > 0 && serverDay(c[first - 1].timestamp) === today) first--;
  if (first === 0) return skip('No previous day in data');
  const yesterday = serverDay(c[first - 1].timestamp);
  let hi = -Infinity;
  let lo = Infinity;
  let bars = 0;
  for (let j = first - 1; j >= 0 && serverDay(c[j].timestamp) === yesterday; j--) {
    hi = Math.max(hi, c[j].high);
    lo = Math.min(lo, c[j].low);
    bars++;
  }
  if (bars < Math.floor((12 * 60) / ctx.tfMinutes)) return skip('Previous day incomplete');
  const range = hi - lo;
  const open = c[first].open;
  const up = open + k * range;
  const down = open - k * range;
  // only the first close beyond the level today
  for (let j = first; j < i; j++) {
    if (c[j].close > up || c[j].close < down) return skip('Already triggered today');
  }
  if (c[i].close > up) return build(ctx, 'BUY', c[i].close - 0.5 * range, `Open ${open} + ${k}×range ${range.toFixed(2)} broken`);
  if (c[i].close < down) return build(ctx, 'SELL', c[i].close + 0.5 * range, `Open ${open} − ${k}×range ${range.toFixed(2)} broken`);
  return skip('No volatility breakout');
}

/** Swing (fractal) lows/highs with `w` bars on each side, between indices [from, to] */
function swings(c: CandleData[], from: number, to: number, w: number = 2): { lows: number[]; highs: number[] } {
  const lows: number[] = [];
  const highs: number[] = [];
  for (let j = Math.max(from, w); j <= to - w; j++) {
    let isLow = true;
    let isHigh = true;
    for (let k = j - w; k <= j + w; k++) {
      if (k === j) continue;
      if (c[k].low <= c[j].low) isLow = false;
      if (c[k].high >= c[j].high) isHigh = false;
    }
    if (isLow) lows.push(c[j].low);
    if (isHigh) highs.push(c[j].high);
  }
  return { lows, highs };
}

/** Nial Fuller price action: pin bar rejecting a swing level, or inside-bar breakout — with the trend */
function pinBar(ctx: LibContext): LibResult {
  const { candles: c, i, ind } = ctx;
  if (i < 65) return skip('Not enough candles');
  const a = ind.atr14[i];
  const bar = c[i];
  const range = bar.high - bar.low;
  if (range <= 0) return skip('Zero range');
  const body = Math.abs(bar.close - bar.open);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const up = bar.close > ind.ema50[i] && ind.ema50[i] > ind.ema50[i - 5];
  const down = bar.close < ind.ema50[i] && ind.ema50[i] < ind.ema50[i - 5];
  const { lows, highs } = swings(c, i - 60, i - 3);

  const bullPin = lowerWick >= 2.5 * body && lowerWick >= 0.6 * range && bar.close >= bar.low + 0.6 * range;
  const bearPin = upperWick >= 2.5 * body && upperWick >= 0.6 * range && bar.close <= bar.high - 0.6 * range;
  if (up && bullPin && lows.some((l) => Math.abs(bar.low - l) <= 0.5 * a)) {
    return build(ctx, 'BUY', bar.low - 0.1 * a, 'Bullish pin bar at swing-low level, uptrend');
  }
  if (down && bearPin && highs.some((h) => Math.abs(bar.high - h) <= 0.5 * a)) {
    return build(ctx, 'SELL', bar.high + 0.1 * a, 'Bearish pin bar at swing-high level, downtrend');
  }

  // Inside bar (c[i-1] inside mother c[i-2]) broken in the trend direction by c[i]
  const mother = c[i - 2];
  const inside = c[i - 1].high < mother.high && c[i - 1].low > mother.low;
  if (inside && up && bar.close > mother.high) return build(ctx, 'BUY', mother.low - 0.1 * a, 'Inside-bar breakout up, uptrend');
  if (inside && down && bar.close < mother.low) return build(ctx, 'SELL', mother.high + 0.1 * a, 'Inside-bar breakout down, downtrend');
  return skip('No pin bar / inside bar setup');
}

/** Rayner Teo: trend (EMA20>EMA50, both rising), pullback into the 20/50 zone that has held at least twice */
function raynerEma(ctx: LibContext): LibResult {
  const { candles: c, i, ind } = ctx;
  if (i < 40) return skip('Not enough candles');
  const a = ind.atr14[i];
  const bar = c[i];
  const up = ind.ema20[i] > ind.ema50[i] && ind.ema20[i] > ind.ema20[i - 3] && ind.ema50[i] > ind.ema50[i - 3];
  const down = ind.ema20[i] < ind.ema50[i] && ind.ema20[i] < ind.ema20[i - 3] && ind.ema50[i] < ind.ema50[i - 3];
  if (!up && !down) return skip('EMAs flat or tangled');

  // count separate earlier touches of the zone that held (closed back on the trend side of EMA50)
  let touches = 0;
  let inTouch = false;
  for (let j = i - 30; j < i; j++) {
    const touched = up ? c[j].low <= ind.ema20[j] && c[j].close > ind.ema50[j] : c[j].high >= ind.ema20[j] && c[j].close < ind.ema50[j];
    if (touched && !inTouch) touches++;
    inTouch = touched;
  }
  if (touches < 2) return skip(`Zone respected ${touches}× (<2)`);

  if (up && bar.low <= ind.ema20[i] && bar.low >= ind.ema50[i] - 0.5 * a && bar.close > ind.ema20[i] && bar.close > bar.open) {
    return build(ctx, 'BUY', Math.min(bar.low, ind.ema50[i]) - 0.3 * a, 'Pullback into EMA20/50 zone, bullish close');
  }
  if (down && bar.high >= ind.ema20[i] && bar.high <= ind.ema50[i] + 0.5 * a && bar.close < ind.ema20[i] && bar.close < bar.open) {
    return build(ctx, 'SELL', Math.max(bar.high, ind.ema50[i]) + 0.3 * a, 'Pullback into EMA20/50 zone, bearish close');
  }
  return skip('Trend but no zone pullback');
}

const nyMinutes = (ctx: LibContext, d: Date) => getZonedTime(ctx.toUtc(d), 'America/New_York').minutesOfDay;

/** ICT Silver Bullet: in a NY window, sweep of a 20-bar extreme → FVG → first retest of the FVG */
function ictSilverBullet(ctx: LibContext): LibResult {
  const { candles: c, i, ind } = ctx;
  const windows = [
    [3 * 60, 4 * 60],
    [10 * 60, 11 * 60],
    [14 * 60, 15 * 60],
  ];
  const m = nyMinutes(ctx, c[i].timestamp);
  if (!windows.some(([s, e]) => m >= s && m < e)) return skip('Outside Silver Bullet windows');
  if (i < 40) return skip('Not enough candles');
  const a = ind.atr14[i];
  const lookback = Math.max(4, Math.round(120 / ctx.tfMinutes)); // sweep/FVG within the last ~2h

  for (const bull of [true, false]) {
    if (bull && !(c[i].close > ind.ema200[i])) continue;
    if (!bull && !(c[i].close < ind.ema200[i])) continue;
    for (let k = i - lookback; k <= i - 3; k++) {
      if (k < 21) continue;
      let ext = bull ? Infinity : -Infinity;
      for (let j = k - 20; j < k; j++) ext = bull ? Math.min(ext, c[j].low) : Math.max(ext, c[j].high);
      const swept = bull ? c[k].low < ext && c[k].close > ext : c[k].high > ext && c[k].close < ext;
      if (!swept) continue;
      for (let j = k + 2; j <= i - 1; j++) {
        const top = bull ? c[j].low : c[j - 2].low; // FVG between c[j-2] and c[j]
        const bottom = bull ? c[j - 2].high : c[j].high;
        if (!(top - bottom >= 0.1 * a)) continue;
        // first return into the gap happens on bar i
        let touchedBefore = false;
        for (let t = j + 1; t < i; t++) {
          if (bull ? c[t].low <= top : c[t].high >= bottom) touchedBefore = true;
        }
        if (touchedBefore) continue;
        const retest = bull ? c[i].low <= top && c[i].close >= bottom : c[i].high >= bottom && c[i].close <= top;
        if (!retest) continue;
        return bull
          ? build(ctx, 'BUY', c[k].low - 0.2 * a, `Sweep of ${ext} → FVG ${bottom}–${top} retest (NY window)`)
          : build(ctx, 'SELL', c[k].high + 0.2 * a, `Sweep of ${ext} → FVG ${bottom}–${top} retest (NY window)`);
      }
    }
  }
  return skip('No sweep → FVG → retest');
}

/** Casper SMC continuation: NY 07:30–10:30, swing high/low taken → pullback → displacement through the pullback's minor swing */
function casperSmc(ctx: LibContext): LibResult {
  const { candles: c, i, ind } = ctx;
  const m = nyMinutes(ctx, c[i].timestamp);
  if (m < 7 * 60 + 30 || m >= 10 * 60 + 30) return skip('Outside NY 07:30–10:30');
  if (i < 50) return skip('Not enough candles');
  const a = ind.atr14[i];
  const bar = c[i];
  const body = Math.abs(bar.close - bar.open);
  if (body < a) return skip('No displacement candle');

  const bull = bar.close > ind.ema200[i] && bar.close > bar.open;
  const bear = bar.close < ind.ema200[i] && bar.close < bar.open;
  if (!bull && !bear) return skip('Displacement against the bias');

  // liquidity taken: a bar in the last 20 broke the 20-bar extreme before it
  for (let h = i - 20; h <= i - 3; h++) {
    let ext = bull ? -Infinity : Infinity;
    for (let j = h - 20; j < h; j++) ext = bull ? Math.max(ext, c[j].high) : Math.min(ext, c[j].low);
    if (bull ? c[h].high <= ext : c[h].low >= ext) continue;
    // pullback after h
    let pIdx = h + 1;
    for (let j = h + 1; j < i; j++) if (bull ? c[j].low < c[pIdx].low : c[j].high > c[pIdx].high) pIdx = j;
    const depth = bull ? c[h].high - c[pIdx].low : c[pIdx].high - c[h].low;
    if (pIdx >= i || depth < 0.5 * a) continue;
    // minor swing of the pullback (last 3 bars into the pullback extreme)
    let minor = bull ? -Infinity : Infinity;
    for (let j = Math.max(h + 1, pIdx - 3); j <= pIdx; j++) minor = bull ? Math.max(minor, c[j].high) : Math.min(minor, c[j].low);
    const choch = bull ? bar.close > minor && c[i - 1].close <= minor : bar.close < minor && c[i - 1].close >= minor;
    if (!choch) continue;
    return bull
      ? build(ctx, 'BUY', c[pIdx].low - 0.2 * a, `Liquidity taken, pullback, displacement through ${minor}`)
      : build(ctx, 'SELL', c[pIdx].high + 0.2 * a, `Liquidity taken, pullback, displacement through ${minor}`);
  }
  return skip('No liquidity → pullback → ChoCH');
}

/** SupertrendGold Prop EA entry (all filters on the closed candle; entry at the next open) */
function supertrendEa(ctx: LibContext): LibResult {
  const { candles: c, i, ind } = ctx;
  const E = SUPERTREND_EA;
  if (i < E.flipLookback + 15) return skip('Not enough candles');
  const d = ind.stDir[i];
  if (d === 0 || !Number.isFinite(ind.stLine[i])) return skip('Supertrend warming up');

  // session / Friday cutoff in broker server time (bar times are server time)
  const entryAt = new Date(c[i].timestamp.getTime() + ctx.tfMinutes * 60000);
  const h = entryAt.getUTCHours();
  if (h < E.sessionStartHour || h >= E.sessionEndHour) return skip('Outside EA session (server time)');
  if (entryAt.getUTCDay() === 5 && h >= E.fridayCloseHour - 1) return skip('Friday cutoff');

  if (!(ind.adx14[i] >= E.adxMin)) return skip(`Sideways: ADX ${ind.adx14[i]?.toFixed(0)} < ${E.adxMin}`);
  if (d === 1 && !(ind.pdi14[i] > ind.mdi14[i])) return skip('ADX direction disagrees');
  if (d === -1 && !(ind.mdi14[i] > ind.pdi14[i])) return skip('ADX direction disagrees');

  let flips = 0;
  for (let j = i - E.flipLookback + 1; j <= i; j++) if (ind.stDir[j] !== ind.stDir[j - 1]) flips++;
  if (flips > E.maxFlips) return skip(`Sideways: ${flips} flips`);
  if (ctx.htfDir !== undefined && ctx.htfDir !== d) return skip('HTF Supertrend disagrees');

  const side: 'BUY' | 'SELL' = d === 1 ? 'BUY' : 'SELL';
  const price = side === 'BUY' ? ctx.quote.ask : ctx.quote.bid;
  const line = ind.stLine[i];
  const dist = Math.abs(price - line);
  const a = ind.stAtr[i];
  if (dist < E.minDistAtr * a) return skip('Too close to line');
  if (dist > E.maxDistAtr * a) return skip('Too far from line (late entry)');
  if ((d === 1 && line >= price) || (d === -1 && line <= price)) return skip('Price on wrong side of line');

  const sl = side === 'BUY' ? line - E.slBuffer : line + E.slBuffer;
  return {
    side,
    entryPrice: round(ctx.pair, price),
    stopLoss: round(ctx.pair, sl),
    takeProfit: 0,
    reason: `Supertrend ${side === 'BUY' ? 'up' : 'down'}, ADX ${ind.adx14[i].toFixed(0)}, ${flips} flips, HTF agrees`,
    exit: 'supertrend',
  };
}

/** XAUUSD EMA Breakout EA settings (defaults of the user's MQL5 EA v1.00) */
export const EMA_RANGE_EA = {
  rangeBars: 10,
  atrBufferMult: 0.5,
  sessions: [
    [8, 12],
    [14, 19],
  ] as const, // broker server hours
};

/** Strategies that need a higher-timeframe trend (htfDir) and which timeframe that is */
export const HTF_FOR: Partial<Record<StrategyName, Partial<Record<string, string>>>> = {
  supertrend: { M15: 'H1', M30: 'H1', H1: 'H4' },
  emaRangeBreakout: { M5: 'M15', M15: 'H1', M30: 'H1', H1: 'H4' },
};

/** XAUUSD EMA Breakout EA: HTF EMA200 trend + close beyond the previous N candles' range */
function emaRangeBreakout(ctx: LibContext): LibResult {
  const { candles: c, i, ind } = ctx;
  const E = EMA_RANGE_EA;
  if (i < E.rangeBars + 2) return skip('Not enough candles');
  const entryAt = new Date(c[i].timestamp.getTime() + ctx.tfMinutes * 60000); // server time
  const h = entryAt.getUTCHours();
  if (!E.sessions.some(([s, e]) => h >= s && h < e)) return skip('Outside EA sessions (server 8–12, 14–19)');
  if (ctx.htfDir === undefined) return skip('Higher-timeframe EMA200 trend not available');
  if (ctx.htfDir === 0) return skip('HTF close equals EMA200');

  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i - E.rangeBars; j < i; j++) {
    hi = Math.max(hi, c[j].high);
    lo = Math.min(lo, c[j].low);
  }
  const a = ind.atr14[i];
  if (!Number.isFinite(a) || a <= 0) return skip('ATR not ready');
  const buffer = a * E.atrBufferMult;
  const spread = ctx.quote.ask - ctx.quote.bid;

  let side: 'BUY' | 'SELL' | null = null;
  if (ctx.htfDir === 1 && c[i].close > hi) side = 'BUY';
  if (ctx.htfDir === -1 && c[i].close < lo) side = 'SELL';
  if (!side) return skip('No range breakout with the HTF trend');

  const entry = side === 'BUY' ? ctx.quote.ask : ctx.quote.bid;
  const sl = side === 'BUY' ? lo - buffer : hi + buffer + spread;
  if (side === 'BUY' ? sl >= entry : sl <= entry) return skip('SL on the wrong side of entry');
  const dist = Math.abs(entry - sl);
  const tp = side === 'BUY' ? entry + ctx.rewardRatio * dist : entry - ctx.rewardRatio * dist;
  return {
    side,
    entryPrice: round(ctx.pair, entry),
    stopLoss: round(ctx.pair, sl),
    takeProfit: round(ctx.pair, tp),
    reason: `HTF ${side === 'BUY' ? 'above' : 'below'} EMA200, close beyond ${E.rangeBars}-bar range ${lo}–${hi}`,
    exit: 'fixed',
  };
}

const IMPL: Record<StrategyName, (ctx: LibContext) => LibResult> = {
  breakout,
  trendPullback,
  asianBreakout,
  meanReversion,
  emaCross,
  donchian,
  turtle20: turtle(20),
  turtle55: turtle(55),
  volBreakout: (ctx) => volBreakout(ctx, 0.5),
  pinBar,
  raynerEma,
  ictSilverBullet,
  casperSmc,
  supertrend: supertrendEa,
  emaRangeBreakout,
};

export function evaluateStrategy(name: StrategyName, ctx: LibContext): LibResult {
  if (name === 'supertrend' || name === 'emaRangeBreakout') {
    // EA has its own filters (ADX, flips, distance); only the spread check is shared
    if (ctx.quote.spread > ctx.maxSpreadPips) return skip(`Spread ${ctx.quote.spread} > max ${ctx.maxSpreadPips} pips`);
    return IMPL[name](ctx);
  }
  if (name !== 'breakout') {
    const blocked = commonFilters(ctx);
    if (blocked) return skip(blocked);
  }
  return IMPL[name](ctx);
}
