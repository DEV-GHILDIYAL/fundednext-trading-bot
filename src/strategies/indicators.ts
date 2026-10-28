import { CandleData } from '../api/market';

/** Exponential moving average; NaN until `period` values are available */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder RSI; NaN until `period + 1` values are available */
export function rsi(values: number[], period: number = 14): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Simple-average ATR in price units (same definition as computeAtrPips) */
export function atr(candles: CandleData[], period: number = 14): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  const tr: number[] = candles.map((c, i) =>
    i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))
  );
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    sum += tr[i];
    if (i > period) sum -= tr[i - period];
    if (i >= period) out[i] = sum / period;
  }
  return out;
}

/** Wilder-smoothed ATR (as in MT5 / TradingView Supertrend) */
export function atrWilder(candles: CandleData[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length < period) return out;
  const tr = candles.map((c, i) =>
    i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))
  );
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  out[period - 1] = a;
  for (let i = period; i < candles.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}

/**
 * Supertrend (TradingView style, Wilder ATR) — a straight port of the EA's CalcST:
 * direction flips only on a CLOSE beyond the band.
 */
export function supertrend(candles: CandleData[], period: number = 10, mult: number = 3): { line: number[]; dir: number[]; atr: number[] } {
  const n = candles.length;
  const line = new Array<number>(n).fill(NaN);
  const dir = new Array<number>(n).fill(0);
  const a = atrWilder(candles, period);
  if (n < period + 1) return { line, dir, atr: a };
  const i0 = period - 1;
  let hl2 = (candles[i0].high + candles[i0].low) / 2;
  let fu = hl2 + mult * a[i0];
  let fl = hl2 - mult * a[i0];
  dir[i0] = candles[i0].close > hl2 ? 1 : -1;
  line[i0] = dir[i0] === 1 ? fl : fu;
  for (let i = period; i < n; i++) {
    hl2 = (candles[i].high + candles[i].low) / 2;
    const bu = hl2 + mult * a[i];
    const bl = hl2 - mult * a[i];
    const prevClose = candles[i - 1].close;
    const nfu = bu < fu || prevClose > fu ? bu : fu;
    const nfl = bl > fl || prevClose < fl ? bl : fl;
    fu = nfu;
    fl = nfl;
    dir[i] = dir[i - 1] === -1 ? (candles[i].close > fu ? 1 : -1) : candles[i].close < fl ? -1 : 1;
    line[i] = dir[i] === 1 ? fl : fu;
  }
  return { line, dir, atr: a };
}

/** Wilder ADX with +DI / −DI */
export function adx(candles: CandleData[], period: number = 14): { adx: number[]; pdi: number[]; mdi: number[] } {
  const n = candles.length;
  const out = { adx: new Array<number>(n).fill(NaN), pdi: new Array<number>(n).fill(NaN), mdi: new Array<number>(n).fill(NaN) };
  if (n < 2 * period + 1) return out;
  let trS = 0, pS = 0, mS = 0;
  const dx: number[] = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i <= period) {
      trS += tr; pS += pdm; mS += mdm;
      if (i < period) continue;
    } else {
      trS = trS - trS / period + tr;
      pS = pS - pS / period + pdm;
      mS = mS - mS / period + mdm;
    }
    const pdi = trS > 0 ? (100 * pS) / trS : 0;
    const mdi = trS > 0 ? (100 * mS) / trS : 0;
    out.pdi[i] = pdi;
    out.mdi[i] = mdi;
    dx[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  }
  let adxV = 0;
  for (let i = period; i < n; i++) {
    if (i < 2 * period) {
      adxV += dx[i];
      if (i === 2 * period - 1) {
        adxV /= period;
        out.adx[i] = adxV;
      }
    } else {
      adxV = (adxV * (period - 1) + dx[i]) / period;
      out.adx[i] = adxV;
    }
  }
  return out;
}

export interface Indicators {
  ema9: number[];
  ema20: number[];
  ema21: number[];
  ema50: number[];
  ema200: number[];
  rsi14: number[];
  atr14: number[];
  /** Supertrend(10, 3) */
  stLine: number[];
  stDir: number[];
  stAtr: number[];
  adx14: number[];
  pdi14: number[];
  mdi14: number[];
}

/** Every indicator the strategy library needs, aligned with `candles` */
export function computeIndicators(candles: CandleData[]): Indicators {
  const close = candles.map((c) => c.close);
  return {
    ema9: ema(close, 9),
    ema20: ema(close, 20),
    ema21: ema(close, 21),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    rsi14: rsi(close, 14),
    atr14: atr(candles, 14),
    ...(() => {
      const st = supertrend(candles, 10, 3);
      const ad = adx(candles, 14);
      return { stLine: st.line, stDir: st.dir, stAtr: st.atr, adx14: ad.adx, pdi14: ad.pdi, mdi14: ad.mdi };
    })(),
  };
}

/** Bars of warm-up the indicators need (EMA200 + margin) */
export const INDICATOR_WARMUP = 220;
