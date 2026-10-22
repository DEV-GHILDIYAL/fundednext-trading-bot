// Risk Management Constants (FundedNext rules; runtime values live in src/config.ts)
export const RISK_CONFIG = {
  RISK_PERCENT: 0.75,
  MAX_DAILY_LOSS_PERCENT: 5,
  MAX_LOSS_PERCENT: 10,
  MAX_TRADES_PER_DAY: 3,
  MIN_REWARD_RATIO: 2, // 1:2 exactly
  MIN_TRADE_DURATION_SECONDS: 30,
  TARGET_PROFIT_PERCENT: 8,
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
