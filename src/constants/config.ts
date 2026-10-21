// Risk Management Constants
export const RISK_CONFIG = {
  MAX_DAILY_LOSS: 100,
  SAFETY_BUFFER: 70,
  MAX_TRADES_PER_DAY: 3,
  RISK_PER_TRADE: 30,
  MIN_REWARD_RATIO: 2, // 1:2 minimum
  TARGET_PROFIT: 300,
};

// Time Windows (in IST - UTC+5:30)
export const TRADING_HOURS = {
  LONDON_OPEN_HOUR: 13, // 8 AM GMT = 1:30 PM IST
  LONDON_OPEN_MINUTE: 30,
  LONDON_CLOSE_HOUR: 17, // 5 PM GMT = 10:30 PM IST
  LONDON_CLOSE_MINUTE: 0,
};

// Volatility Thresholds
export const VOLATILITY_THRESHOLDS = {
  MIN_ATR_PIPS: 50,
  MIN_ATR_BREAKOUT: 50,
  HIGH_VOLATILITY_THRESHOLD: 100,
};

// Precision Constants
export const PRECISION = {
  PRICE_DECIMAL: 5,
  POSITION_SIZE_DECIMAL: 2,
  PIP_VALUE: 0.0001, // For most pairs
};
