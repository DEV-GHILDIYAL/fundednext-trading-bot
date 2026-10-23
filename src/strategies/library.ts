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
 * Every strategy: stop distance clamped to [slMinAtr, slMaxAtr] × ATR, TP = rewardRatio × stop.
 */
import { CandleData, PriceData, computeAtrPips } from '../api/market';
import { getPairSpec } from '../constants/pairs';
import { getZonedTime } from '../utils/time';
import { Indicators } from './indicators';
import { EntrySignalGenerator, StrategyParams, minClosedCandles } from './entrySignalGenerator';

export const STRATEGY_NAMES = ['breakout', 'trendPullback', 'asianBreakout', 'meanReversion', 'emaCross', 'donchian'] as const;
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
}

export interface LibSignal {
  side: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  reason: string;
}

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

const IMPL: Record<StrategyName, (ctx: LibContext) => LibResult> = {
  breakout,
  trendPullback,
  asianBreakout,
  meanReversion,
  emaCross,
  donchian,
};

export function evaluateStrategy(name: StrategyName, ctx: LibContext): LibResult {
  if (name !== 'breakout') {
    const blocked = commonFilters(ctx);
    if (blocked) return skip(blocked);
  }
  return IMPL[name](ctx);
}
