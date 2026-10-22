import dotenv from 'dotenv';

dotenv.config();

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(parsed) ? parsed : fallback;
};

// FundedNext rule set (percentages are of the initial account balance).
// Adjust MAX_LOSS_PERCENT / PROFIT_TARGET_PERCENT for your challenge type:
//   1-Step = 6% max loss, 2-Step = 10% max loss, Lite = 8% max loss.
const accountBalance = num(process.env.ACCOUNT_BALANCE, 6000);
const riskPercent = Math.min(num(process.env.RISK_PERCENT, 0.75), 1);
const maxTradesPerDay = Math.min(num(process.env.MAX_TRADES_PER_DAY, 3), 3);
const riskPerTrade = parseFloat((accountBalance * (riskPercent / 100)).toFixed(2));
const dailyLossPercent = Math.min(num(process.env.DAILY_LOSS_PERCENT, 5), 5);
const maxDailyLoss = parseFloat((accountBalance * (dailyLossPercent / 100)).toFixed(2));
const maxLossPercent = Math.min(num(process.env.MAX_LOSS_PERCENT, 10), 10);
const maxTotalLoss = parseFloat((accountBalance * (maxLossPercent / 100)).toFixed(2));
const challengePhase = Math.min(Math.max(num(process.env.CHALLENGE_PHASE, 1), 1), 2);
const defaultTargetPercent = challengePhase === 2 ? 5 : 8;
const profitTargetPercent = num(process.env.PROFIT_TARGET_PERCENT, defaultTargetPercent);
const targetProfit = parseFloat((accountBalance * (profitTargetPercent / 100)).toFixed(2));
const minTradingDaysPerPhase = Math.max(1, num(process.env.MIN_TRADING_DAYS_PER_PHASE, 5));
const phaseStartDate = (process.env.PHASE_START_DATE || '').trim();
const safetyBuffer = parseFloat((riskPerTrade * maxTradesPerDay).toFixed(2));
const minTradeDurationSeconds = Math.max(30, num(process.env.MIN_TRADE_DURATION_SECONDS, 30));

export const config = {
  // Environment
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // API Keys
  fundednextApiKey: process.env.FUNDEDNEXT_API_KEY || '',
  fundednextAccountId: process.env.FUNDEDNEXT_ACCOUNT_ID || '',
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  groqBaseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  marketDataApiKey: process.env.MARKET_DATA_API_KEY || '',

  // Optional AI review of generated signals (off by default; strategy rules still run)
  aiReviewEnabled: process.env.AI_REVIEW_ENABLED === 'true',
  aiMinConfidence: num(process.env.AI_MIN_CONFIDENCE, 0.55),

  // Account Configuration (FundedNext Stellar 2-Step)
  accountBalance,
  challengePhase,
  riskPercent,
  riskPerTrade,
  targetProfit,
  profitTargetPercent,
  maxDailyLoss,
  dailyLossPercent,
  maxTotalLoss,
  maxLossPercent,
  maxTradesPerDay,
  minTradingDaysPerPhase,
  phaseStartDate,
  safetyBuffer,
  minTradeDurationSeconds,

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

  // Simulated market data volatility multiplier (only affects the mock feed;
  // 1 = current behaviour, >1 = bigger fake price swings for faster testing)
  simVolatility: Math.min(Math.max(num(process.env.SIM_VOLATILITY, 1), 0.1), 10),

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
