export const TRADING_PAIRS = {
  EURUSD: {
    name: 'EURUSD',
    profitability: 1, // Most liquid, tightest spreads
    volatility: 'MEDIUM',
    winRate: 0.70,
  },
  GBPUSD: {
    name: 'GBPUSD',
    profitability: 2, // High volatility
    volatility: 'HIGH',
    winRate: 0.68,
  },
  XAUUSD: {
    name: 'XAUUSD',
    profitability: 3, // Gold, trending well
    volatility: 'MEDIUM-HIGH',
    winRate: 0.65,
  },
};

export const PAIR_LIST = ['EURUSD', 'GBPUSD', 'XAUUSD'] as const;

export type TradingPair = (typeof PAIR_LIST)[number];
