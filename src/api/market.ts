import { logger } from '../utils/logger';
import { getPairSpec, PAIR_LIST, roundPrice } from '../constants/pairs';
import { Calculator } from '../utils/calculator';
import { config } from '../config';
import { mt5Bridge, Mt5BridgeClient } from './mt5Bridge';

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
  /** false while the bar is still forming (undefined = closed) */
  closed?: boolean;
}

/** Broker contract details needed for lot sizing */
export interface SymbolSpec {
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  digits: number;
}

export interface MarketDataSource {
  readonly isSimulated: boolean;
  readonly name: 'SIMULATED' | 'MT5';
  getCurrentPrice(pair: string): Promise<PriceData>;
  /** Oldest first. The last bar may still be forming (closed === false). */
  getCandles(pair: string, timeframe?: string, limit?: number): Promise<CandleData[]>;
  getSymbolSpec(pair: string): Promise<SymbolSpec>;
  /** ATR in pips from closed 1H candles */
  calculateATR(pair: string, period?: number): Promise<number>;
  validateConnection(): Promise<boolean>;
}

/** Average True Range in pips over the last `period` bars of `candles` (closed bars only) */
export function computeAtrPips(candles: CandleData[], pipSize: number, period: number = 14): number {
  const closed = candles.filter((c) => c.closed !== false).slice(-(period + 1));
  if (closed.length < 2) return 0;
  let trSum = 0;
  for (let i = 1; i < closed.length; i++) {
    const curr = closed[i];
    const prevClose = closed[i - 1].close;
    trSum += Math.max(curr.high - curr.low, Math.abs(curr.high - prevClose), Math.abs(curr.low - prevClose));
  }
  return parseFloat((trSum / (closed.length - 1) / pipSize).toFixed(2));
}

/** Group 1H candles into daily candles by UTC date */
function aggregateDaily(candles: CandleData[]): CandleData[] {
  const days = new Map<string, CandleData>();
  for (const c of candles) {
    const key = c.timestamp.toISOString().slice(0, 10);
    const d = days.get(key);
    if (!d) {
      days.set(key, { ...c, timestamp: new Date(`${key}T00:00:00Z`) });
    } else {
      d.high = Math.max(d.high, c.high);
      d.low = Math.min(d.low, c.low);
      d.close = c.close;
      d.closed = c.closed;
    }
  }
  return Array.from(days.values());
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
 * Offline test feed (DATA_SOURCE=sim). NOTE: this is a SIMULATED feed (independent random walk per pair,
 * with realistic price levels, spreads and hourly ranges). It is consistent
 * over time so strategies behave sensibly, but it is NOT real market data.
 * Replace the internals with an MT5 bridge / data provider for live use.
 */
export class SimulatedMarketData implements MarketDataSource {
  readonly isSimulated = true;
  readonly name = 'SIMULATED' as const;
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
    const stepSize = spec.mockHourlyRange * 0.15 * config.simVolatility;
    for (let i = 0; i < steps; i++) {
      state.price += (Math.random() - 0.5) * stepSize;
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

  /** 1H candles (oldest first, last one forming). 'D1' is aggregated from the 1H history. */
  async getCandles(pair: string, timeframe: string = 'H1', limit: number = 100): Promise<CandleData[]> {
    const state = this.getFeed(pair);
    const hourly = state.candles.map((c, i, all) => ({ ...c, closed: i < all.length - 1 }));
    const bars = timeframe.toUpperCase() === 'D1' ? aggregateDaily(hourly) : hourly;
    return bars.slice(-limit);
  }

  async getSymbolSpec(pair: string): Promise<SymbolSpec> {
    const spec = getPairSpec(pair);
    return { contractSize: spec.contractSize, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, digits: spec.digits };
  }

  async calculateATR(pair: string, period: number = 14): Promise<number> {
    return computeAtrPips(await this.getCandles(pair, 'H1', period + 2), getPairSpec(pair).pipSize, period);
  }

  async validateConnection(): Promise<boolean> {
    try {
      await this.getCurrentPrice(PAIR_LIST[0]);
      if (this.isSimulated) {
        logger.warn(
          `⚠️ Market data: SIMULATED feed (not real prices). Paper trading only. ` +
            `Volatility ×${config.simVolatility}`
        );
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

/** Real prices from the MT5 terminal via the bridge */
export class Mt5MarketData implements MarketDataSource {
  readonly isSimulated = false;
  readonly name = 'MT5' as const;
  private specCache = new Map<string, { spec: SymbolSpec; at: number }>();

  constructor(private readonly bridge: Mt5BridgeClient = mt5Bridge) {}

  async getCurrentPrice(pair: string): Promise<PriceData> {
    const spec = getPairSpec(pair);
    const t = await this.bridge.tick(pair);
    return {
      pair,
      bid: t.bid,
      ask: t.ask,
      timestamp: new Date(t.time),
      spread: Calculator.calculateSpread(t.bid, t.ask, spec.pipSize),
    };
  }

  async getCandles(pair: string, timeframe: string = 'H1', limit: number = 100): Promise<CandleData[]> {
    const tf = timeframe.toUpperCase() === '1H' ? 'H1' : timeframe.toUpperCase();
    const bars = await this.bridge.candles(pair, tf, limit);
    return bars.map((b) => ({
      timestamp: new Date(b.time),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      closed: b.closed,
    }));
  }

  async getSymbolSpec(pair: string): Promise<SymbolSpec> {
    const cached = this.specCache.get(pair);
    if (cached && Date.now() - cached.at < HOUR_MS) return cached.spec;
    const s = await this.bridge.symbol(pair);
    const spec: SymbolSpec = {
      contractSize: s.contractSize,
      volumeMin: s.volumeMin,
      volumeMax: s.volumeMax,
      volumeStep: s.volumeStep,
      digits: s.digits,
    };
    this.specCache.set(pair, { spec, at: Date.now() });
    return spec;
  }

  async calculateATR(pair: string, period: number = 14): Promise<number> {
    return computeAtrPips(await this.getCandles(pair, 'H1', period + 2), getPairSpec(pair).pipSize, period);
  }

  async validateConnection(): Promise<boolean> {
    try {
      const health = await this.bridge.health();
      if (!health.ok) {
        logger.error('❌ MT5 bridge is up but the terminal is not connected');
        return false;
      }
      const acc = await this.bridge.account();
      const price = await this.getCurrentPrice(PAIR_LIST[0]);
      logger.info(
        `✅ MT5 connected${health.mock ? ' (MOCK bridge)' : ''}: login ${acc.login} @ ${acc.server} | ` +
          `balance ${acc.currency} ${acc.balance} | ${PAIR_LIST[0]} ${price.bid}/${price.ask} | ` +
          `algo trading ${acc.tradeAllowed ? 'ON' : 'OFF'}`
      );
      if (!acc.tradeAllowed) {
        logger.warn('⚠️ MT5 "Algo Trading" is OFF — live orders will be rejected until it is enabled in the terminal');
      }
      return true;
    } catch (error) {
      logger.error(`❌ MT5 bridge not reachable at ${config.mt5BridgeUrl}`, error);
      return false;
    }
  }
}

export function createMarketDataSource(source: 'sim' | 'mt5' = config.dataSource): MarketDataSource {
  return source === 'mt5' ? new Mt5MarketData() : new SimulatedMarketData();
}

export const marketClient: MarketDataSource = createMarketDataSource();
