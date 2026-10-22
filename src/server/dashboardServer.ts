import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { logger, getRecentLogs } from '../utils/logger';
import { getZonedTime, formatClock, isWithinTradingSession } from '../utils/time';
import { bot } from '../bot/bot';
import { marketClient } from '../api/market';
import { tradeExecutor } from '../services/tradeExecutor';
import { tradeMonitor } from '../services/tradeMonitor';
import { riskManager } from '../services/riskManager';
import { tradeJournal } from '../services/tradeJournal';
import { getPairSpec } from '../constants/pairs';
import { Calculator } from '../utils/calculator';

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const pad = (n: number): string => String(n).padStart(2, '0');

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
    dataSource: marketClient.isSimulated ? 'SIMULATED' : 'LIVE',
    bot: {
      enabled: config.botEnabled,
      cycleSeconds: config.cycleIntervalSeconds,
      ...bot.getSnapshot(),
    },
    session: {
      open: isWithinTradingSession(),
      opens: `${pad(config.londonOpenHour)}:${pad(config.londonOpenMinute)}`,
      closes: `${pad(config.londonCloseHour)}:${pad(config.londonCloseMinute)}`,
      days: 'Mon–Fri',
    },
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
    logs: getRecentLogs(60),
  };
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!config.dashboardUser || !config.dashboardPassword) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  return safeEqual(decoded.slice(0, sep), config.dashboardUser) && safeEqual(decoded.slice(sep + 1), config.dashboardPassword);
}

function send(res: http.ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

export function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/healthz') {
    send(res, 200, JSON.stringify({ ok: true }), 'application/json');
    return;
  }

  if (req.method !== 'GET') {
    send(res, 405, 'Method Not Allowed', 'text/plain');
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="FundedNext Bot", charset="UTF-8"' });
    res.end('Authentication required');
    return;
  }

  try {
    if (url.pathname === '/api/status') {
      send(res, 200, JSON.stringify(buildStatus()), 'application/json; charset=utf-8');
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
      send(res, 200, html, 'text/html; charset=utf-8');
      return;
    }

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
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      this.server = null;
    });
  }
}

export const dashboardServer = new DashboardServer();
