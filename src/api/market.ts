import { logger } from '../utils/logger';
import { getPairSpec, PAIR_LIST, roundPrice } from '../constants/pairs';
import { Calculator } from '../utils/calculator';

export interface PriceData {
  pair: string;
  bid: number;
  ask: number;
  timestamp: Date;
  /** Spread in pips */
  spread: number;
}

export interface CandleData {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const HISTORY_CANDLES = 72; // 3 days of 1H candles
const TICK_INTERVAL_MS = 5000;

interface FeedState {
  price: number;
  candles: CandleData[];
  lastTick: number;
}

/**
 * Market data source.
 *
 * NOTE: This is currently a SIMULATED feed (independent random walk per pair,
 * with realistic price levels, spreads and hourly ranges). It is consistent
 * over time so strategies behave sensibly, but it is NOT real market data.
 * Replace the internals with an MT5 bridge / data provider for live use.
 */
export class MarketDataClient {
  readonly isSimulated = true;
  private feeds = new Map<string, FeedState>();

  private getFeed(pair: string): FeedState {
    let state = this.feeds.get(pair);
    if (!state) {
      state = this.seedFeed(pair);
      this.feeds.set(pair, state);
    }
    this.tick(pair, state);
    return state;
  }

  private seedFeed(pair: string): FeedState {
    const spec = getPairSpec(pair);
    const currentHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const candles: CandleData[] = [];
    let price = spec.mockBasePrice;

    for (let i = HISTORY_CANDLES - 1; i >= 0; i--) {
      const open = price;
      const close = open + (Math.random() - 0.5) * spec.mockHourlyRange;
      const high = Math.max(open, close) + Math.random() * spec.mockHourlyRange * 0.5;
      const low = Math.min(open, close) - Math.random() * spec.mockHourlyRange * 0.5;
      candles.push({
        timestamp: new Date(currentHour - i * HOUR_MS),
        open: roundPrice(pair, open),
        high: roundPrice(pair, high),
        low: roundPrice(pair, low),
        close: roundPrice(pair, close),
        volume: 1000,
      });
      price = close;
    }

    logger.debug(`Simulated feed seeded for ${pair}`, { price: roundPrice(pair, price) });
    return { price, candles, lastTick: Date.now() };
  }

  /** Advance the random walk and keep the current 1H candle up to date */
  private tick(pair: string, state: FeedState): void {
    const now = Date.now();
    if (now - state.lastTick < TICK_INTERVAL_MS) return;

    const spec = getPairSpec(pair);
    const steps = Math.min(Math.floor((now - state.lastTick) / TICK_INTERVAL_MS), 720);
    for (let i = 0; i < steps; i++) {
      state.price += (Math.random() - 0.5) * spec.mockHourlyRange * 0.15;
    }
    state.lastTick = now;

    const price = roundPrice(pair, state.price);
    const bucket = Math.floor(now / HOUR_MS) * HOUR_MS;
    const last = state.candles[state.candles.length - 1];

    if (last.timestamp.getTime() === bucket) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
    } else {
      state.candles.push({
        timestamp: new Date(bucket),
        open: last.close,
        high: Math.max(last.close, price),
        low: Math.min(last.close, price),
        close: price,
        volume: 1000,
      });
      if (state.candles.length > HISTORY_CANDLES) state.candles.shift();
    }
  }

  async getCurrentPrice(pair: string): Promise<PriceData> {
    const spec = getPairSpec(pair);
    const state = this.getFeed(pair);
    const bid = roundPrice(pair, state.price);
    const ask = roundPrice(pair, state.price + spec.mockSpread);

    logger.debug(`Price ${pair}: ${bid}/${ask}`);
    return {
      pair,
      bid,
      ask,
      timestamp: new Date(),
      spread: Calculator.calculateSpread(bid, ask, spec.pipSize),
    };
  }

  /** Returns 1H candles (oldest first). Only the 1H timeframe is supported. */
  async getCandles(pair: string, _timeframe: string = '1H', limit: number = 100): Promise<CandleData[]> {
    const state = this.getFeed(pair);
    return state.candles.slice(-limit).map((c) => ({ ...c }));
  }

  /** Average True Range in pips */
  async calculateATR(pair: string, period: number = 14): Promise<number> {
    const spec = getPairSpec(pair);
    const candles = await this.getCandles(pair, '1H', period + 1);
    if (candles.length < 2) return 0;

    let trSum = 0;
    for (let i = 1; i < candles.length; i++) {
      const curr = candles[i];
      const prevClose = candles[i - 1].close;
      trSum += Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prevClose),
        Math.abs(curr.low - prevClose)
      );
    }

    const atrPips = trSum / (candles.length - 1) / spec.pipSize;
    return parseFloat(atrPips.toFixed(2));
  }

  async validateConnection(): Promise<boolean> {
    try {
      await this.getCurrentPrice(PAIR_LIST[0]);
      if (this.isSimulated) {
        logger.warn('⚠️ Market data: SIMULATED feed (not real prices). Paper trading only.');
      } else {
        logger.info('✅ Market data connection validated');
      }
      return true;
    } catch (error) {
      logger.error('❌ Market data connection failed', error);
      return false;
    }
  }

  clearCache(): void {
    this.feeds.clear();
  }
}

export const marketClient = new MarketDataClient();
