/**
 * Background data for the dashboard, refreshed off the request path so /api/status stays instant:
 *  - MT5 account (balance, equity, margin, leverage) + every MT5 position (bot and manual)
 *  - price chart candles (M15 / H1 / H4), today's range and change
 *  - start-of-day balance (FundedNext daily loss is measured from it)
 *  - USD→INR rate (shown next to USD amounts)
 *  - upcoming US news + current blackout
 *  - bridge latency / last error
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { marketClient, CandleData } from '../api/market';
import { mt5Bridge, BridgeAccount, BridgePosition } from '../api/mt5Bridge';
import { newsCalendar, NewsEvent } from '../strategies/news';
import { PAIR_LIST } from '../constants/pairs';
import { tradeJournal } from './tradeJournal';
import { tradeMonitor } from './tradeMonitor';

export type ChartTf = 'M15' | 'H1' | 'H4';

export interface DashboardDataSnapshot {
  account: (BridgeAccount & { source: 'MT5' | 'computed'; marginLevel: number | null; floating: number }) | null;
  positions: BridgePosition[];
  dayStart: { date: string; balance: number; equity: number } | null;
  chart: Record<ChartTf, { time: string; open: number; high: number; low: number; close: number }[]>;
  today: { open: number; high: number; low: number; change: number; changePct: number } | null;
  news: { upcoming: { at: string; title: string }[]; blackout: string | null; feed: { feedEvents: number; fetchedAt: string | null; error: string } };
  fx: { usdInr: number | null; fetchedAt: string | null };
  bridge: { ok: boolean; latencyMs: number | null; lastError: string | null; updatedAt: string | null };
  /** MT5 bar times are broker server time written as UTC: subtract this to get real UTC */
  serverOffsetMs: number;
}

const CHART_BARS: Record<ChartTf, number> = { M15: 160, H1: 160, H4: 120 };

export class DashboardData {
  private snap: DashboardDataSnapshot = {
    account: null,
    positions: [],
    dayStart: null,
    chart: { M15: [], H1: [], H4: [] },
    today: null,
    news: { upcoming: [], blackout: null, feed: newsCalendar.status },
    fx: { usdInr: null, fetchedAt: null },
    bridge: { ok: false, latencyMs: null, lastError: null, updatedAt: null },
    serverOffsetMs: 0,
  };
  private timers: NodeJS.Timeout[] = [];
  private fxFetchedAt = 0;
  private readonly dayFile = path.join(config.dataDir, 'day-start.json');

  constructor() {
    try {
      if (fs.existsSync(this.dayFile)) this.snap.dayStart = JSON.parse(fs.readFileSync(this.dayFile, 'utf8'));
    } catch {
      this.snap.dayStart = null;
    }
  }

  get snapshot(): DashboardDataSnapshot {
    return this.snap;
  }

  start(): void {
    if (this.timers.length) return;
    const safe = (fn: () => Promise<void>) => () => void fn().catch((e) => logger.debug(`dashboard data: ${(e as Error).message}`));
    safe(() => this.refreshFast())();
    safe(() => this.refreshSlow())();
    this.timers.push(setInterval(safe(() => this.refreshFast()), 5000));
    this.timers.push(setInterval(safe(() => this.refreshSlow()), 60000));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Every 5 s: account, positions */
  private async refreshFast(): Promise<void> {
    if (marketClient.isSimulated) {
      this.snap.account = this.computedAccount();
      this.snap.positions = [];
      this.snap.bridge = { ok: true, latencyMs: null, lastError: null, updatedAt: new Date().toISOString() };
      this.trackDayStart(this.snap.account.balance, this.snap.account.equity);
      return;
    }
    const t0 = Date.now();
    try {
      const [acc, positions] = await Promise.all([mt5Bridge.account(), mt5Bridge.positions()]);
      const floating = positions.reduce((s, p) => s + p.profit + (p.swap || 0), 0);
      this.snap.account = {
        ...acc,
        source: 'MT5',
        marginLevel: acc.margin > 0 ? (acc.equity / acc.margin) * 100 : null,
        floating: parseFloat(floating.toFixed(2)),
      };
      this.snap.positions = positions;
      this.snap.bridge = { ok: true, latencyMs: Date.now() - t0, lastError: null, updatedAt: new Date().toISOString() };
      this.trackDayStart(acc.balance, acc.equity);
    } catch (error) {
      this.snap.bridge = { ...this.snap.bridge, ok: false, lastError: (error as Error).message, updatedAt: new Date().toISOString() };
    }
  }

  /** Every 60 s: chart candles, today's range, news, FX */
  private async refreshSlow(): Promise<void> {
    const pair = PAIR_LIST[0];
    if (!marketClient.isSimulated) {
      try {
        const q = await marketClient.getCurrentPrice(pair);
        this.snap.serverOffsetMs = Math.round((q.timestamp.getTime() - Date.now()) / 1800000) * 1800000;
      } catch {
        // keep previous
      }
    }
    for (const tf of Object.keys(CHART_BARS) as ChartTf[]) {
      try {
        const bars = await marketClient.getCandles(pair, tf, CHART_BARS[tf]);
        this.snap.chart[tf] = bars.map((b: CandleData) => ({ time: b.timestamp.toISOString(), open: b.open, high: b.high, low: b.low, close: b.close }));
      } catch {
        // keep previous candles
      }
    }
    try {
      const d1 = await marketClient.getCandles(pair, 'D1', 2);
      const today = d1[d1.length - 1];
      const prev = d1[d1.length - 2];
      if (today) {
        const ref = prev?.close ?? today.open;
        this.snap.today = {
          open: today.open,
          high: today.high,
          low: today.low,
          change: parseFloat((today.close - ref).toFixed(2)),
          changePct: parseFloat((((today.close - ref) / ref) * 100).toFixed(2)),
        };
      }
    } catch {
      // keep previous
    }
    try {
      const upcoming: NewsEvent[] = await newsCalendar.upcoming(48);
      this.snap.news = {
        upcoming: upcoming.map((e) => ({ at: e.at.toISOString(), title: e.title })),
        blackout: await newsCalendar.check(new Date()),
        feed: newsCalendar.status,
      };
    } catch {
      // keep previous
    }
    if (Date.now() - this.fxFetchedAt > 6 * 3600000) {
      try {
        const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
        const data = (await res.json()) as { rates?: Record<string, number> };
        if (data.rates?.INR) this.snap.fx = { usdInr: data.rates.INR, fetchedAt: new Date().toISOString() };
        this.fxFetchedAt = Date.now();
      } catch {
        this.fxFetchedAt = Date.now() - 5 * 3600000; // retry in 1 h
      }
    }
  }

  /** Paper / simulated mode: account numbers from the journal */
  private computedAccount(): NonNullable<DashboardDataSnapshot['account']> {
    const realized = tradeJournal.getSummary().totalPnL;
    const floating = tradeMonitor.calculateTotalPnL();
    const balance = config.accountBalance + realized;
    return {
      login: 0,
      server: 'paper',
      currency: 'USD',
      balance,
      equity: balance + floating,
      margin: 0,
      freeMargin: balance + floating,
      leverage: 0,
      tradeAllowed: true,
      source: 'computed',
      marginLevel: null,
      floating,
    };
  }

  /** First balance seen on each broker/bot day = the base FundedNext's daily loss counts from */
  private trackDayStart(balance: number, equity: number): void {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
    if (this.snap.dayStart?.date === date) return;
    this.snap.dayStart = { date, balance, equity };
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(this.dayFile, JSON.stringify(this.snap.dayStart));
    } catch {
      // non-critical
    }
  }
}

export const dashboardData = new DashboardData();
