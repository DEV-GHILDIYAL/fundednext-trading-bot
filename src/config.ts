import dotenv from 'dotenv';

dotenv.config();

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  // Environment
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // API Keys
  fundednextApiKey: process.env.FUNDEDNEXT_API_KEY || '',
  fundednextAccountId: process.env.FUNDEDNEXT_ACCOUNT_ID || '',
  claudeApiKey: process.env.CLAUDE_API_KEY || '',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
  marketDataApiKey: process.env.MARKET_DATA_API_KEY || '',

  // Account Configuration
  accountBalance: num(process.env.ACCOUNT_BALANCE, 6000),
  riskPerTrade: num(process.env.RISK_PER_TRADE, 30),
  targetProfit: num(process.env.TARGET_PROFIT, 300),
  maxDailyLoss: num(process.env.MAX_DAILY_LOSS, 100),
  maxTradesPerDay: num(process.env.MAX_TRADES_PER_DAY, 3),
  safetyBuffer: num(process.env.SAFETY_BUFFER, 70),

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
  cycleIntervalSeconds: num(process.env.CYCLE_INTERVAL_SECONDS, 30),

  // Trading Hours — interpreted in BOT_TIMEZONE, independent of server timezone
  timezone: process.env.BOT_TIMEZONE || 'Asia/Kolkata',
  londonOpenHour: num(process.env.LONDON_OPEN_HOUR, 13),
  londonOpenMinute: num(process.env.LONDON_OPEN_MINUTE, 30),
  londonCloseHour: num(process.env.LONDON_CLOSE_HOUR, 17),
  londonCloseMinute: num(process.env.LONDON_CLOSE_MINUTE, 0),

  // Risk Management
  minAtrPips: num(process.env.MIN_ATR_PIPS, 50),
  profitRatio: num(process.env.PROFIT_RATIO, 2),
  minWinRate: num(process.env.MIN_WIN_RATE, 0.7),

  // Dashboard (web UI + JSON API)
  dashboardEnabled: process.env.DASHBOARD_ENABLED !== 'false',
  dashboardHost: process.env.DASHBOARD_HOST || '0.0.0.0',
  dashboardPort: num(process.env.DASHBOARD_PORT, 3000),
  dashboardUser: process.env.DASHBOARD_USER || '',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  dataDir: process.env.DATA_DIR || './data',

  // Notifications
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  emailRecipient: process.env.EMAIL_RECIPIENT || '',
};

export default config;
