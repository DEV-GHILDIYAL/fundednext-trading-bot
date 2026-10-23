import dotenv from 'dotenv';

dotenv.config();

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(parsed) ? parsed : fallback;
};

/** "HH:MM" → minutes since midnight */
function parseClock(value: string | undefined, fallback: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value || fallback).trim()) ?? /^(\d{1,2}):(\d{2})$/.exec(fallback)!;
  return Math.min(24 * 60, Math.min(24, parseInt(m[1], 10)) * 60 + Math.min(59, parseInt(m[2], 10)));
}

export type EntryTimeframe = 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1';
export const TIMEFRAME_MINUTES: Record<EntryTimeframe, number> = { M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };

const STRATEGIES = [
  'breakout',
  'trendPullback',
  'asianBreakout',
  'meanReversion',
  'emaCross',
  'donchian',
  'turtle20',
  'turtle55',
  'volBreakout',
  'pinBar',
  'raynerEma',
  'ictSilverBullet',
  'casperSmc',
  'supertrend',
  'emaRangeBreakout',
] as const;
export type StrategyKey = (typeof STRATEGIES)[number];

function parseStrategy(value: string | undefined): StrategyKey {
  const v = (value || 'breakout').trim();
  return (STRATEGIES as readonly string[]).includes(v) ? (v as StrategyKey) : 'breakout';
}

function parseTimeframe(value: string | undefined): EntryTimeframe {
  const tf = (value || 'H1').toUpperCase();
  return tf === 'M5' || tf === 'M15' || tf === 'M30' || tf === 'H4' || tf === 'D1' ? tf : 'H1';
}

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

  // Market data / execution
  // sim = random-walk feed (offline testing), mt5 = real prices from the MT5 bridge
  dataSource: (process.env.DATA_SOURCE || 'sim').toLowerCase() === 'mt5' ? ('mt5' as const) : ('sim' as const),
  mt5BridgeUrl: (process.env.MT5_BRIDGE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, ''),
  mt5BridgeToken: process.env.MT5_BRIDGE_TOKEN || '',
  mt5Magic: num(process.env.MT5_MAGIC, 260101),
  mt5DeviationPoints: num(process.env.MT5_DEVIATION_POINTS, 30),
  mt5TimeoutMs: num(process.env.MT5_TIMEOUT_MS, 10000),

  // Groq — two keys from different accounts; switches to the next key on rate limit / auth errors
  groqApiKeys: [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2]
    .map((k) => (k || '').trim())
    .filter((k) => k.length > 0 && !k.includes('your_') && k !== 'test_key_development'),
  groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  groqBaseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  groqMaxRetries: Math.max(0, num(process.env.GROQ_MAX_RETRIES, 2)),
  groqTimeoutMs: num(process.env.GROQ_TIMEOUT_MS, 30000),

  // AI review of every strategy signal (on by default). Fail-closed: no AI answer → no trade.
  aiReviewEnabled: process.env.AI_REVIEW_ENABLED !== 'false',
  aiFailOpen: process.env.AI_REVIEW_FAIL_MODE === 'open',
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

  // Display timezone (logs, dashboard, daily reset)
  timezone: process.env.BOT_TIMEZONE || 'Asia/Kolkata',

  // Trading session — defined in London time so UK daylight saving is handled automatically.
  // 08:00–11:30 London = 13:30–17:00 IST in winter (12:30–16:00 IST in summer).
  sessionTimezone: process.env.SESSION_TIMEZONE || 'Europe/London',
  sessionStart: parseClock(process.env.SESSION_START, '08:00'),
  sessionEnd: parseClock(process.env.SESSION_END, '11:30'),

  // Strategy
  // Which strategy from src/strategies/library.ts the bot trades
  strategy: parseStrategy(process.env.STRATEGY),
  // Candle timeframe for entries: M5 | M15 | M30 | H1 (default) | H4 | D1
  entryTimeframe: parseTimeframe(process.env.ENTRY_TIMEFRAME),
  // Breakout range length in hours (rolling mode)
  rangeHours: Math.max(1, num(process.env.RANGE_HOURS, 24)),
  // Require the price-action filter to agree with the breakout
  usePriceAction: process.env.USE_PRICE_ACTION !== 'false',
  rangeMode: (process.env.RANGE_MODE || 'rolling24h') === 'prevDay' ? ('prevDay' as const) : ('rolling24h' as const),
  minAtrPips: num(process.env.MIN_ATR_PIPS, 50),
  slMinAtr: num(process.env.SL_MIN_ATR, 0.5),
  slMaxAtr: num(process.env.SL_MAX_ATR, 1.5),
  maxSpreadPips: num(process.env.MAX_SPREAD_PIPS, 8),
  // Reward:risk (TP = ratio × SL distance)
  profitRatio: Math.min(Math.max(num(process.env.PROFIT_RATIO, 2), 1), 5),

  // Dashboard (web UI + JSON API)
  dashboardEnabled: process.env.DASHBOARD_ENABLED !== 'false',
  dashboardHost: process.env.DASHBOARD_HOST || '0.0.0.0',
  dashboardPort: num(process.env.DASHBOARD_PORT, 3000),
  dashboardUser: process.env.DASHBOARD_USER || '',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  dataDir: process.env.DATA_DIR || './data',

  // Notifications (Telegram recommended: free push to phone)
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
};

export default config;
