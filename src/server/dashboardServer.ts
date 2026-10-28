import http from 'http';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger, getRecentLogs } from '../utils/logger';
import { getZonedTime, formatClock, isAnySleeveInSession, isWithinTradingSession, formatMinutes, sessionInDisplayZone, sessionClockInDisplayZone } from '../utils/time';
import { dashboardData } from '../services/dashboardData';
import { readAiReviews } from '../services/aiReviewLog';
import type { ClosedTrade } from '../services/tradeJournal';
import { groqClient } from '../api/groq';
import { notifier } from '../services/notifier';
import { bot } from '../bot/bot';
import { marketClient } from '../api/market';
import { tradeExecutor } from '../services/tradeExecutor';
import { tradeMonitor } from '../services/tradeMonitor';
import { riskManager } from '../services/riskManager';
import { tradeJournal } from '../services/tradeJournal';
import { getPairSpec } from '../constants/pairs';
import { Calculator } from '../utils/calculator';
import { control } from '../services/control';
import {
  authEnabled, isAuthorized, checkCredentials, makeSessionToken, sessionCookie, clearCookie, clientIp, lockedFor, recordLogin,
} from './auth';
import { setTrading, modifyLevels, placeManualOrder, closePosition, ActionError, MANUAL_MAGIC, MANUAL_MAX_LOTS, lossRoom } from './actions';

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');

const r2 = (n: number) => parseFloat(n.toFixed(2));

/** Win rate, profit factor, expectancy, drawdown, streaks — overall, per strategy, per day */
export function buildAnalytics(closed: ClosedTrade[]) {
  const rOf = (t: ClosedTrade) => t.pnl / (t.riskAmount && t.riskAmount > 0 ? t.riskAmount : config.riskPerTrade);
  const summarize = (ts: ClosedTrade[]) => {
    const wins = ts.filter((t) => t.pnl > 0);
    const losses = ts.filter((t) => t.pnl < 0);
    const gw = wins.reduce((a, t) => a + t.pnl, 0);
    const gl = -losses.reduce((a, t) => a + t.pnl, 0);
    let eq = 0, peak = 0, dd = 0, run = 0, maxLossRun = 0;
    for (const t of ts) {
      eq += t.pnl;
      peak = Math.max(peak, eq);
      dd = Math.max(dd, peak - eq);
      run = t.pnl < 0 ? run + 1 : 0;
      maxLossRun = Math.max(maxLossRun, run);
    }
    const holds = ts.map((t) => (Date.parse(t.closedAt) - Date.parse(t.openedAt)) / 60000).filter((m) => m >= 0);
    return {
      trades: ts.length,
      wins: wins.length,
      losses: losses.length,
      winRate: ts.length ? r2((wins.length / ts.length) * 100) : 0,
      net: r2(gw - gl),
      netR: r2(ts.reduce((a, t) => a + rOf(t), 0)),
      profitFactor: gl > 0 ? r2(gw / gl) : gw > 0 ? null : 0,
      avgWin: wins.length ? r2(gw / wins.length) : 0,
      avgLoss: losses.length ? r2(-gl / losses.length) : 0,
      expectancy: ts.length ? r2((gw - gl) / ts.length) : 0,
      expectancyR: ts.length ? r2(ts.reduce((a, t) => a + rOf(t), 0) / ts.length) : 0,
      best: ts.length ? r2(Math.max(...ts.map((t) => t.pnl))) : 0,
      worst: ts.length ? r2(Math.min(...ts.map((t) => t.pnl))) : 0,
      maxDrawdown: r2(dd),
      maxLosingStreak: maxLossRun,
      avgHoldMin: holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : 0,
    };
  };
  const bySleeve = new Map<string, ClosedTrade[]>();
  for (const t of closed) {
    const k = t.sleeve ?? 'before portfolio';
    bySleeve.set(k, [...(bySleeve.get(k) ?? []), t]);
  }
  const daily = new Map<string, { pnl: number; trades: number }>();
  for (const t of closed) {
    const k = getZonedTime(new Date(t.openedAt)).dateKey;
    const d = daily.get(k) ?? { pnl: 0, trades: 0 };
    d.pnl += t.pnl;
    d.trades++;
    daily.set(k, d);
  }
  let streak = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    const w = closed[i].pnl > 0;
    if (streak === 0) streak = w ? 1 : -1;
    else if ((streak > 0) === w) streak += w ? 1 : -1;
    else break;
  }
  return {
    overall: { ...summarize(closed), currentStreak: streak },
    byStrategy: Array.from(bySleeve.entries()).map(([id, ts]) => ({ id, ...summarize(ts) })),
    daily: Array.from(daily.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-35)
      .map(([date, d]) => ({ date, pnl: r2(d.pnl), trades: d.trades })),
  };
}

/** Everything the dashboard shows, in one JSON document */
export function buildStatus(): Record<string, unknown> {
  const now = getZonedTime();
  const openTrades = tradeMonitor.getOpenTrades().map((t) => ({
    ...t,
    openedAt: t.openedAt.toISOString(),
    lots: Calculator.unitsToLots(t.quantity, getPairSpec(t.pair).contractSize),
  }));

  return {
    generatedAt: new Date().toISOString(),
    clock: { date: now.dateKey, time: formatClock(now), timezone: config.timezone },
    mode: tradeExecutor.isDryRun ? 'PAPER' : 'LIVE',
    dataSource: marketClient.name,
    simVolatility: config.simVolatility,
    control: control.snapshot,
    bot: {
      enabled: config.botEnabled,
      cycleSeconds: config.cycleIntervalSeconds,
      ...bot.getSnapshot(),
    },
    session: {
      open: isAnySleeveInSession(),
      strategies: config.sleeves.map((sl) => `${sl.id} 1:${sl.rewardRatio} ${formatMinutes(sl.sessionStart)}–${formatMinutes(sl.sessionEnd)} London`),
      opens: sessionInDisplayZone()?.opens ?? formatMinutes(config.sessionStart),
      closes: sessionInDisplayZone()?.closes ?? formatMinutes(config.sessionEnd),
      london: `${formatMinutes(config.sessionStart)}–${formatMinutes(config.sessionEnd)} London`,
      days: 'Mon–Fri',
    },
    ai: {
      enabled: config.aiReviewEnabled,
      failMode: config.aiFailOpen ? 'open' : 'closed',
      model: groqClient.modelName,
      ...groqClient.getStatus(),
    },
    notifications: { enabled: notifier.enabled },
    limits: {
      accountBalance: config.accountBalance,
      riskPercent: config.riskPercent,
      riskPerTrade: config.riskPerTrade,
      safetyBuffer: config.safetyBuffer,
      maxDailyLoss: config.maxDailyLoss,
      dailyLossPercent: config.dailyLossPercent,
      maxTotalLoss: config.maxTotalLoss,
      maxLossPercent: config.maxLossPercent,
      maxTradesPerDay: config.maxTradesPerDay,
      targetProfit: config.targetProfit,
      profitTargetPercent: config.profitTargetPercent,
      minTradeDurationSeconds: config.minTradeDurationSeconds,
      challengePhase: config.challengePhase,
      minTradingDaysPerPhase: config.minTradingDaysPerPhase,
      phaseStartDate: config.phaseStartDate || null,
    },
    phase: {
      number: config.challengePhase,
      targetProfit: config.targetProfit,
      targetPercent: config.profitTargetPercent,
      minTradingDays: config.minTradingDaysPerPhase,
      tradingDays: tradeJournal.getTradingDays(),
      phasePnL: tradeJournal.getPhaseSummary().totalPnL,
      startDate: config.phaseStartDate || null,
    },
    risk: riskManager.getStatus(),
    unrealizedPnL: tradeMonitor.calculateTotalPnL(),
    openTrades,
    history: tradeJournal.getClosedTrades(50),
    summary: tradeJournal.getSummary(),
    equity: tradeJournal.getEquityCurve(),
    logs: getRecentLogs(80),
    ...buildAdvanced(),
  };
}

/** Account, challenge progress, strategies, news, AI, analytics, chart, health */
function buildAdvanced(): Record<string, unknown> {
  const dd = dashboardData.snapshot;
  const now = new Date();
  const acc = dd.account;
  const initial = config.accountBalance;
  const balance = acc?.balance ?? initial + tradeJournal.getSummary().totalPnL;
  const equity = acc?.equity ?? balance + tradeMonitor.calculateTotalPnL();
  const dayStartBalance = dd.dayStart?.balance ?? balance;
  const maxLossFloor = initial - config.maxTotalLoss;
  const dailyFloor = dayStartBalance - config.maxDailyLoss;
  const profit = balance - initial;
  const reviews = readAiReviews();
  const recentReviews = reviews.slice(-200);
  const botSnap = bot.getSnapshot();
  const botPositions = new Set(tradeMonitor.getOpenTrades().map((t) => t.ticket).filter((t) => t !== undefined));

  return {
    account: acc
      ? { ...acc, balance: r2(acc.balance), equity: r2(acc.equity), margin: r2(acc.margin), freeMargin: r2(acc.freeMargin), marginLevel: acc.marginLevel === null ? null : r2(acc.marginLevel) }
      : null,
    mt5Positions: dd.positions.map((p) => ({ ...p, byBot: botPositions.has(p.ticket) || p.magic === config.mt5Magic, manual: p.magic === MANUAL_MAGIC })),
    manualTrading: { enabled: !tradeExecutor.isDryRun && !marketClient.isSimulated, maxLots: MANUAL_MAX_LOTS, room: lossRoom(), minHoldSec: config.minTradeDurationSeconds },
    challenge: {
      phase: config.challengePhase,
      initialBalance: initial,
      balance: r2(balance),
      equity: r2(equity),
      profit: r2(profit),
      target: config.targetProfit,
      targetPercent: config.profitTargetPercent,
      progressPercent: r2(Math.max(0, Math.min(100, (profit / config.targetProfit) * 100))),
      toTarget: r2(Math.max(0, config.targetProfit - profit)),
      maxLossFloor: r2(maxLossFloor),
      roomToMaxLoss: r2(equity - maxLossFloor),
      dailyFloor: r2(dailyFloor),
      dayStartBalance: r2(dayStartBalance),
      roomToDailyLimit: r2(equity - dailyFloor),
      tradingDays: tradeJournal.getTradingDays(),
      minTradingDays: config.minTradingDaysPerPhase,
      riskPerTrade: config.riskPerTrade,
      tradesToTargetAt2R: Math.ceil(Math.max(0, config.targetProfit - profit) / (config.riskPerTrade * 2)),
    },
    strategies: config.sleeves.map((sl) => {
      const live = botSnap.strategies.find((x) => x.id === sl.id);
      const fullDay = sl.sessionStart === 0 && sl.sessionEnd >= 24 * 60;
      return {
        id: sl.id,
        strategy: sl.strategy,
        timeframe: sl.timeframe,
        rewardRatio: sl.rewardRatio,
        window: fullDay
          ? sl.strategy === 'nyOpenBreakout'
            ? '09:30–12:00 New York'
            : sl.strategy === 'fibSweep'
              ? 'Range 11:30–12:30 IST · entries 14:30–21:00 IST'
              : 'Any time (own rules)'
          : `${sessionClockInDisplayZone(sl.sessionStart, now)}–${sessionClockInDisplayZone(sl.sessionEnd, now)} IST (${formatMinutes(sl.sessionStart)}–${formatMinutes(sl.sessionEnd)} London)`,
        active:
          sl.strategy === 'fibSweep'
            ? (() => {
                const t = getZonedTime(now, 'Asia/Kolkata');
                return t.weekday >= 1 && t.weekday <= 5 && t.minutesOfDay >= 14 * 60 + 30 && t.minutesOfDay < 21 * 60;
              })()
            : sl.strategy === 'nyOpenBreakout'
            ? (() => {
                const ny = getZonedTime(now, 'America/New_York');
                return ny.weekday >= 1 && ny.weekday <= 5 && ny.minutesOfDay > 9 * 60 + 30 && ny.minutesOfDay <= 12 * 60;
              })()
            : isWithinTradingSession(now, sl.sessionStart, sl.sessionEnd),
        status: live?.status ?? '—',
        updatedAt: live?.updatedAt ?? null,
        lastSignal: live?.lastSignal ?? null,
      };
    }),
    settings: {
      maxOpenPositions: config.maxOpenPositions,
      newsFilter: config.newsFilter,
      aiMinConfidence: config.aiMinConfidence,
      maxSpreadPips: config.maxSpreadPips,
      magic: config.mt5Magic,
    },
    news: dd.news,
    ai: {
      ...groqClient.getStatus(),
      enabled: config.aiReviewEnabled,
      failMode: config.aiFailOpen ? 'open' : 'closed',
      model: groqClient.modelName,
      reviewed: recentReviews.length,
      approved: recentReviews.filter((r) => r.verdict === 'approved').length,
      rejected: recentReviews.filter((r) => r.verdict === 'rejected').length,
      traded: recentReviews.filter((r) => r.traded).length,
      recent: recentReviews.slice(-12).reverse(),
    },
    analytics: buildAnalytics(tradeJournal.getAllClosed()),
    chart: dd.chart,
    serverOffsetMs: dd.serverOffsetMs,
    fib: config.sleeves.some((sl) => sl.strategy === 'fibSweep') ? dd.fib : null,
    apiVersion: 4,
    alertsSent: notifier.sent.slice(-15).reverse(),
    today: dd.today,
    fx: dd.fx,
    health: {
      bridge: dd.bridge,
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      node: process.version,
      lastCycleAt: botSnap.lastCycleAt,
      cycleSeconds: config.cycleIntervalSeconds,
    },
  };
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function send(res: http.ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

function json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8', extra);
}

function redirect(res: http.ServerResponse, to: string, extra: Record<string, string> = {}): void {
  res.writeHead(302, { Location: to, ...SECURITY_HEADERS, ...extra });
  res.end();
}

function page(name: string): string {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

/** JSON body, max 10 KB */
function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 10240) {
        reject(new ActionError('Body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(new ActionError('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** POSTs must come from our own page: JSON + custom header (+ same Origin when the browser sends one) */
function sameSite(req: http.IncomingMessage): boolean {
  if (req.headers['x-fnb'] !== '1') return false;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function handlePost(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  if (!sameSite(req)) return json(res, 403, { error: 'Forbidden' });

  if (pathname === '/api/login') {
    const ip = clientIp(req);
    const wait = lockedFor(ip);
    if (wait > 0) return json(res, 429, { error: `Too many wrong attempts — try again in ${Math.ceil(wait / 60000)} min` });
    const body = await readJson(req);
    if (!authEnabled()) return json(res, 200, { ok: true });
    const ok = checkCredentials(body.user, body.password);
    recordLogin(ip, ok);
    if (!ok) {
      logger.warn(`🔐 Dashboard login failed from ${ip}`);
      return json(res, 401, { error: 'Wrong username or password' });
    }
    logger.info(`🔐 Dashboard login from ${ip}`);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, makeSessionToken()) });
  }

  if (pathname === '/api/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(req) });

  if (!isAuthorized(req)) return json(res, 401, { error: 'Login required' });
  const body = await readJson(req);

  if (pathname === '/api/control') return json(res, 200, { ok: true, control: setTrading(body.tradingEnabled) });
  if (pathname === '/api/positions/modify') return json(res, 200, { ok: true, ...(await modifyLevels(body)) });
  if (pathname === '/api/orders') return json(res, 200, { ok: true, ...(await placeManualOrder(body)) });
  if (pathname === '/api/positions/close') return json(res, 200, { ok: true, ...(await closePosition(body)) });

  json(res, 404, { error: 'Not found' });
}

export function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;

  if (p === '/healthz') return json(res, 200, { ok: true });

  if (req.method === 'POST') {
    handlePost(req, res, p).catch((error) => {
      if (error instanceof ActionError) return json(res, error.status, { error: error.message });
      logger.error('Dashboard action failed', error);
      json(res, 500, { error: (error as Error).message || 'Internal error' });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', 'text/plain');

  try {
    const authed = isAuthorized(req);
    if (p === '/login' || p === '/login.html') {
      if (authed && authEnabled()) return redirect(res, '/');
      return send(res, 200, page('login.html'), 'text/html; charset=utf-8');
    }
    if (p === '/logout') return redirect(res, '/login', { 'Set-Cookie': clearCookie(req) });
    if (!authed) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'Login required' });
      return redirect(res, '/login');
    }
    if (p === '/api/status') return json(res, 200, buildStatus());
    if (p === '/' || p === '/index.html') return send(res, 200, page('index.html'), 'text/html; charset=utf-8');
    send(res, 404, 'Not Found', 'text/plain');
  } catch (error) {
    logger.error('Dashboard request failed', error);
    send(res, 500, 'Internal Server Error', 'text/plain');
  }
}

export class DashboardServer {
  private server: http.Server | null = null;

  start(): void {
    if (!config.dashboardEnabled || this.server) return;

    dashboardData.start();
    this.server = http.createServer(handleRequest);
    this.server.on('error', (error) => {
      logger.error(`Dashboard server error (port ${config.dashboardPort})`, error);
    });
    this.server.listen(config.dashboardPort, config.dashboardHost, () => {
      const auth = config.dashboardUser && config.dashboardPassword ? 'password protected' : 'NO PASSWORD';
      logger.info(`🌐 Dashboard on http://${config.dashboardHost}:${config.dashboardPort} (${auth})`);
      if (auth === 'NO PASSWORD') {
        logger.warn('⚠️ Set DASHBOARD_USER and DASHBOARD_PASSWORD in .env before exposing the dashboard publicly');
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      dashboardData.stop();
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      this.server = null;
    });
  }
}

export const dashboardServer = new DashboardServer();
