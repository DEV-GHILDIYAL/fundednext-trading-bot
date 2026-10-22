import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getZonedTime } from '../utils/time';
import type { OpenTrade } from './tradeMonitor';

interface OpenEntry {
  event: 'OPEN';
  tradeId: string;
  pair: string;
  type: 'BUY' | 'SELL';
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: string;
}

interface CloseEntry {
  event: 'CLOSE';
  tradeId: string;
  exitPrice: number;
  pnl: number;
  reason: string;
  closedAt: string;
}

type JournalEntry = OpenEntry | CloseEntry;

export interface ClosedTrade {
  tradeId: string;
  pair: string;
  type: 'BUY' | 'SELL';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  pnl: number;
  reason: string;
  openedAt: string;
  closedAt: string;
}

export interface DailyStats {
  trades: number;
  realizedPnL: number;
  wins: number;
  losses: number;
}

export interface JournalSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  bestTrade: number;
  worstTrade: number;
}

/**
 * Append-only trade journal (JSON Lines). Survives restarts and is the
 * source of truth for trade history shown on the dashboard.
 */
export class TradeJournal {
  private readonly file: string;
  private openEntries = new Map<string, OpenEntry>();
  private closed: ClosedTrade[] = [];

  constructor(dataDir: string = config.dataDir) {
    this.file = path.join(dataDir, 'trades.jsonl');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (error) {
      logger.warn('Trade journal: cannot create data directory', error);
    }
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.apply(JSON.parse(line) as JournalEntry);
        } catch {
          // skip corrupted line
        }
      }
      logger.info(`📒 Trade journal loaded: ${this.closed.length} closed trade(s)`);
    } catch (error) {
      logger.warn('Trade journal: failed to read file', error);
    }
  }

  private apply(entry: JournalEntry): void {
    if (entry.event === 'OPEN') {
      this.openEntries.set(entry.tradeId, entry);
      return;
    }
    const open = this.openEntries.get(entry.tradeId);
    if (!open) return;
    this.openEntries.delete(entry.tradeId);
    this.closed.push({
      tradeId: open.tradeId,
      pair: open.pair,
      type: open.type,
      entryPrice: open.entryPrice,
      exitPrice: entry.exitPrice,
      quantity: open.quantity,
      stopLoss: open.stopLoss,
      takeProfit: open.takeProfit,
      pnl: entry.pnl,
      reason: entry.reason,
      openedAt: open.openedAt,
      closedAt: entry.closedAt,
    });
  }

  private append(entry: JournalEntry): void {
    this.apply(entry);
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      logger.warn('Trade journal: failed to write entry', error);
    }
  }

  recordOpen(trade: OpenTrade): void {
    this.append({
      event: 'OPEN',
      tradeId: trade.tradeId,
      pair: trade.pair,
      type: trade.type,
      entryPrice: trade.entryPrice,
      quantity: trade.quantity,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      openedAt: trade.openedAt.toISOString(),
    });
  }

  recordClose(tradeId: string, exitPrice: number, pnl: number, reason: string): void {
    this.append({
      event: 'CLOSE',
      tradeId,
      exitPrice,
      pnl: parseFloat(pnl.toFixed(2)),
      reason,
      closedAt: new Date().toISOString(),
    });
  }

  /** Closed trades, newest first */
  getClosedTrades(limit: number = 100): ClosedTrade[] {
    return this.closed.slice(-limit).reverse();
  }

  /** Trades opened today (bot timezone) and P&L realized on them */
  getTodayStats(dateKey: string = getZonedTime().dateKey): DailyStats {
    const isToday = (iso: string): boolean => getZonedTime(new Date(iso)).dateKey === dateKey;
    const todaysClosed = this.closed.filter((t) => isToday(t.openedAt));
    const stillOpen = Array.from(this.openEntries.values()).filter((o) => isToday(o.openedAt)).length;

    return {
      trades: todaysClosed.length + stillOpen,
      realizedPnL: parseFloat(todaysClosed.reduce((sum, t) => sum + t.pnl, 0).toFixed(2)),
      wins: todaysClosed.filter((t) => t.pnl > 0).length,
      losses: todaysClosed.filter((t) => t.pnl < 0).length,
    };
  }

  private summarize(trades: ClosedTrade[]): JournalSummary {
    const pnls = trades.map((t) => t.pnl);
    const wins = pnls.filter((p) => p > 0).length;
    const losses = pnls.filter((p) => p < 0).length;
    return {
      totalTrades: pnls.length,
      wins,
      losses,
      winRate: pnls.length ? parseFloat(((wins / pnls.length) * 100).toFixed(1)) : 0,
      totalPnL: parseFloat(pnls.reduce((a, b) => a + b, 0).toFixed(2)),
      bestTrade: pnls.length ? Math.max(...pnls) : 0,
      worstTrade: pnls.length ? Math.min(...pnls) : 0,
    };
  }

  getSummary(): JournalSummary {
    return this.summarize(this.closed);
  }

  /**
   * P&L for the current FundedNext challenge phase. Trades are filtered by
   * opening date so a trade that closes after midnight still belongs to the
   * day it was placed. Empty `sinceDateKey` means the whole journal.
   */
  getPhaseSummary(sinceDateKey: string = config.phaseStartDate): JournalSummary {
    if (!sinceDateKey) return this.summarize(this.closed);
    const inPhase = this.closed.filter(
      (t) => getZonedTime(new Date(t.openedAt)).dateKey >= sinceDateKey
    );
    return this.summarize(inPhase);
  }

  /** Distinct calendar days (bot timezone) with at least one trade in this phase. */
  getTradingDays(sinceDateKey: string = config.phaseStartDate): number {
    const days = new Set<string>();
    const add = (iso: string): void => {
      const key = getZonedTime(new Date(iso)).dateKey;
      if (!sinceDateKey || key >= sinceDateKey) days.add(key);
    };
    for (const trade of this.closed) add(trade.openedAt);
    for (const entry of this.openEntries.values()) add(entry.openedAt);
    return days.size;
  }

  /** Cumulative realized P&L after each closed trade (oldest first) */
  getEquityCurve(limit: number = 500): { time: string; equity: number }[] {
    let equity = 0;
    const points = this.closed.map((t) => {
      equity += t.pnl;
      return { time: t.closedAt, equity: parseFloat(equity.toFixed(2)) };
    });
    return points.slice(-limit);
  }
}

export const tradeJournal = new TradeJournal();
