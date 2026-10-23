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

export interface Indicators {
  ema9: number[];
  ema20: number[];
  ema21: number[];
  ema50: number[];
  ema200: number[];
  rsi14: number[];
  atr14: number[];
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
  };
}

/** Bars of warm-up the indicators need (EMA200 + margin) */
export const INDICATOR_WARMUP = 220;
