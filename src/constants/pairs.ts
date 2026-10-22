/**
 * Pairs the bot is allowed to open new trades on.
 * Keep this list to XAUUSD only unless you explicitly want to trade more pairs.
 */
export const PAIR_LIST = ['XAUUSD'] as const;

export type TradingPair = (typeof PAIR_LIST)[number];

/**
 * Pairs we still know the contract specs for. Non-tradable pairs are kept so
 * old journal entries (EURUSD/GBPUSD) still render correctly on the dashboard.
 */
export const KNOWN_PAIRS = ['EURUSD', 'GBPUSD', 'XAUUSD'] as const;

export type KnownPair = (typeof KNOWN_PAIRS)[number];

export interface PairSpec {
  name: KnownPair;
  /** Price change that equals 1 pip */
  pipSize: number;
  /** Decimal places used when rounding prices */
  digits: number;
  /** Units in 1 standard lot */
  contractSize: number;
  /** Simulated feed: starting price */
  mockBasePrice: number;
  /** Simulated feed: typical 1H candle range (price units) */
  mockHourlyRange: number;
  /** Simulated feed: bid/ask spread (price units) */
  mockSpread: number;
}

export const PAIR_SPECS: Record<KnownPair, PairSpec> = {
  EURUSD: {
    name: 'EURUSD',
    pipSize: 0.0001,
    digits: 5,
    contractSize: 100000,
    mockBasePrice: 1.085,
    mockHourlyRange: 0.0015,
    mockSpread: 0.0001,
  },
  GBPUSD: {
    name: 'GBPUSD',
    pipSize: 0.0001,
    digits: 5,
    contractSize: 100000,
    mockBasePrice: 1.27,
    mockHourlyRange: 0.002,
    mockSpread: 0.00015,
  },
  XAUUSD: {
    name: 'XAUUSD',
    pipSize: 0.1,
    digits: 2,
    contractSize: 100,
    mockBasePrice: 2650,
    mockHourlyRange: 6,
    mockSpread: 0.3,
  },
};

export function isTradingPair(pair: string): pair is TradingPair {
  return (PAIR_LIST as readonly string[]).includes(pair);
}

export function isKnownPair(pair: string): pair is KnownPair {
  return (KNOWN_PAIRS as readonly string[]).includes(pair);
}

export function getPairSpec(pair: string): PairSpec {
  if (!isKnownPair(pair)) {
    throw new Error(`Unsupported trading pair: ${pair}`);
  }
  return PAIR_SPECS[pair];
}

export function roundPrice(pair: string, price: number): number {
  return parseFloat(price.toFixed(getPairSpec(pair).digits));
}
