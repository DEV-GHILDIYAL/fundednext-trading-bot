import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Environment
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // API Keys
  fundednextApiKey: process.env.FUNDEDNEXT_API_KEY || '',
  fundednextAccountId: process.env.FUNDEDNEXT_ACCOUNT_ID || '',
  claudeApiKey: process.env.CLAUDE_API_KEY || '',
  marketDataApiKey: process.env.MARKET_DATA_API_KEY || '',

  // Account Configuration
  accountBalance: parseFloat(process.env.ACCOUNT_BALANCE || '6000'),
  riskPerTrade: parseFloat(process.env.RISK_PER_TRADE || '30'),
  targetProfit: parseFloat(process.env.TARGET_PROFIT || '300'),
  maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || '100'),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || '3', 10),
  safetyBuffer: parseFloat(process.env.SAFETY_BUFFER || '70'),

  // Database
  dbPath: process.env.DB_PATH || './data/trades.db',
  dbLogPath: process.env.DB_LOG_PATH || './logs/trades.log',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  logDir: process.env.LOG_DIR || './logs',

  // Bot Configuration
  botEnabled: process.env.BOT_ENABLED === 'true',
  dryRun: process.env.DRY_RUN !== 'false',
  debug: process.env.DEBUG === 'true',

  // Trading Hours (IST = UTC+5:30)
  londonOpenHour: parseInt(process.env.LONDON_OPEN_HOUR || '13', 10),
  londonOpenMinute: parseInt(process.env.LONDON_OPEN_MINUTE || '30', 10),
  londonCloseHour: parseInt(process.env.LONDON_CLOSE_HOUR || '17', 10),
  londonCloseMinute: parseInt(process.env.LONDON_CLOSE_MINUTE || '0', 10),

  // Risk Management
  minAtrPips: parseFloat(process.env.MIN_ATR_PIPS || '50'),
  profitRatio: parseFloat(process.env.PROFIT_RATIO || '2'),
  minWinRate: parseFloat(process.env.MIN_WIN_RATE || '0.70'),

  // Notifications
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  emailRecipient: process.env.EMAIL_RECIPIENT || '',
};

export default config;
