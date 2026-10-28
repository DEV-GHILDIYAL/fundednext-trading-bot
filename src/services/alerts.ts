/**
 * Telegram messages that matter, in one place:
 *   startup (max once per 15 min) · trade opened · trade closed · today's Fib levels (12:40 IST)
 *   daily summary (23:30 IST) · data feed down ≥3 min on a weekday / recovered · limits hit
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { notifier } from './notifier';
import { tradeJournal } from './tradeJournal';
import { tradeMonitor, OpenTrade } from './tradeMonitor';
import { riskManager } from './riskManager';
import { dashboardData } from './dashboardData';
import { getZonedTime, formatClock } from '../utils/time';

const usd = (n: number, sign = false) => {
  const s = sign && n > 0 ? '+' : n < 0 ? '−' : '';
  return `${s}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const ist = (d: Date = new Date()) => `${formatClock(getZonedTime(d, 'Asia/Kolkata'))} IST`;
const dur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const strategyName = (sleeve?: string) => (sleeve ? sleeve.replace(':', ' ') : 'bot');

function phaseLine(): string {
  const pnl = tradeJournal.getPhaseSummary().totalPnL;
  const pct = Math.max(0, (pnl / config.targetProfit) * 100);
  return `${usd(pnl, true)} / ${usd(config.targetProfit)} (${pct.toFixed(0)}%)`;
}

function balance(): number {
  return dashboardData.snapshot.account?.balance ?? config.accountBalance + tradeJournal.getSummary().totalPnL;
}

const STATE_FILE = () => path.join(config.dataDir, 'notify-state.json');
function readState(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
  } catch {
    return {};
  }
}
function writeState(s: Record<string, number>): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify(s));
  } catch {
    // non-critical
  }
}

export const alerts = {
  /** "Bot online" — skipped when the bot restarted less than 15 min ago (deploys, crashes) */
  startup(mode: string, account: string, strategies: string): void {
    const state = readState();
    if (Date.now() - (state.startup ?? 0) < 15 * 60000) return;
    writeState({ ...state, startup: Date.now() });
    void notifier.card('info', {
      title: 'Bot online',
      rows: [
        ['Mode', mode],
        ['Account', account],
        ['Strategy', strategies],
        ['Risk / trade', `${usd(config.riskPerTrade)} (${config.riskPercent}%)`],
        ['Open trades', tradeMonitor.getOpenTrades().length],
      ],
    });
  },

  tradeOpened(trade: OpenTrade, opts: { lots?: number; risk?: number; confidence?: number; reason?: string }): void {
    const risk = opts.risk ?? config.riskPerTrade;
    const reward = Math.abs(trade.takeProfit - trade.entryPrice) * trade.quantity;
    void notifier.card('info', {
      title: `${trade.type === 'BUY' ? '📈 BUY' : '📉 SELL'} opened · ${strategyName(trade.sleeve)}`,
      rows: [
        ['Entry', trade.entryPrice.toFixed(2)],
        ['Stop loss', `${trade.stopLoss.toFixed(2)} (${Math.abs(trade.entryPrice - trade.stopLoss).toFixed(2)} away)`],
        ['Take profit', `${trade.takeProfit.toFixed(2)} (${Math.abs(trade.takeProfit - trade.entryPrice).toFixed(2)} away)`],
        ['Size', `${(opts.lots ?? trade.lots ?? 0).toFixed(2)} lot`],
        ['Risk → reward', `${usd(risk)} → ${usd(reward)} (1:${(reward / risk).toFixed(1)})`],
        ...(opts.confidence !== undefined ? ([['Groq', `approved (${opts.confidence.toFixed(2)})`]] as [string, string][]) : []),
        ...(trade.ticket ? ([['Ticket', trade.ticket]] as [string, number][]) : []),
      ],
      note: opts.reason,
    });
  },

  tradeClosed(trade: OpenTrade, exitPrice: number, pnl: number, reason: string): void {
    const risk = trade.riskAmount && trade.riskAmount > 0 ? trade.riskAmount : config.riskPerTrade;
    const r = pnl / risk;
    const label = /TAKE_PROFIT|TP/i.test(reason) ? 'Take profit hit' : /STOP_LOSS|SL/i.test(reason) ? 'Stop loss hit' : (reason.includes('_') ? reason.replace(/_/g, ' ').toLowerCase() : reason);
    const today = riskManager.getStatus();
    void notifier.card(pnl >= 0 ? 'success' : 'warn', {
      title: `${pnl >= 0 ? '✅' : '❌'} ${label} · ${usd(pnl, true)} (${r >= 0 ? '+' : ''}${r.toFixed(2)}R)`,
      rows: [
        ['Trade', `${trade.type} ${strategyName(trade.sleeve)}`],
        ['Entry → exit', `${trade.entryPrice.toFixed(2)} → ${exitPrice.toFixed(2)}`],
        ['Duration', dur(Date.now() - trade.openedAt.getTime())],
        ['Today', `${usd(today.dailyLossAmount, true)} · W ${today.wins} / L ${today.losses}`],
        ['Balance', usd(balance())],
        ['Phase target', phaseLine()],
        ['Trading days', `${tradeJournal.getTradingDays()} / ${config.minTradingDaysPerPhase}`],
      ],
    });
  },

  /** 12:40 IST: today's Fib Sweep lines (only when fibSweep runs) */
  fibLevels(newsDay: string | null, late: { title: string; at: Date; closeAt: Date } | null = null): void {
    if (!config.sleeves.some((s) => s.strategy === 'fibSweep')) return;
    const f = dashboardData.snapshot.fib;
    const today = getZonedTime(new Date(), 'Asia/Kolkata').dateKey;
    if (newsDay) {
      void notifier.card('warn', { title: 'No trading today', rows: [['Reason', newsDay]], note: 'Fib Sweep skips NFP / CPI / PPI / FOMC days.' });
      return;
    }
    if (!f || f.date !== today || !f.complete) return;
    void notifier.card('info', {
      title: "Today's Fib Sweep levels",
      rows: [
        ['Range (11:30–12:30)', `${f.bodyLow.toFixed(2)} – ${f.bodyHigh.toFixed(2)} ($${f.range.toFixed(2)})`],
        ['SHORT line (Fib 2)', f.upper.toFixed(2)],
        ['LONG line (Fib −1)', f.lower.toFixed(2)],
        ['Entries', '14:30 – 21:00 IST'],
        ...(late ? ([['News tonight', `${late.title} ${ist(late.at)}`], ['Auto-close', `open trade closes at ${ist(late.closeAt)}`]] as [string, string][]) : []),
      ],
    });
  },

  /** 23:30 IST weekdays */
  dailySummary(): void {
    const stats = tradeJournal.getTodayStats();
    const open = tradeMonitor.getOpenTrades();
    const floating = tradeMonitor.calculateTotalPnL();
    void notifier.card(stats.realizedPnL >= 0 ? 'success' : 'warn', {
      title: `Daily summary · ${getZonedTime(new Date(), 'Asia/Kolkata').dateKey}`,
      rows: [
        ['Trades', stats.trades === 0 ? 'none (no valid setup)' : `${stats.trades} · W ${stats.wins} / L ${stats.losses}`],
        ['Realized P&L', usd(stats.realizedPnL, true)],
        ...(open.length ? ([['Open', `${open.length} trade(s), floating ${usd(floating, true)}`]] as [string, string][]) : []),
        ['Balance', usd(balance())],
        ['Phase target', phaseLine()],
        ['Trading days', `${tradeJournal.getTradingDays()} / ${config.minTradingDaysPerPhase}`],
      ],
    });
  },

  /** A valid setup that was NOT traded (Groq rejected it) — so the user knows the bot saw it */
  setupSkipped(sleeve: string, side: string, entry: number, reason: string): void {
    void notifier.card('warn', {
      title: `Setup skipped · ${side} ${strategyName(sleeve)}`,
      rows: [['Price', entry.toFixed(2)]],
      note: reason.slice(0, 400),
    });
  },

  feedDown(minutes: number, error: string): void {
    void notifier.card('error', { title: 'MT5 connection lost', rows: [['Down for', `${minutes} min`], ['Since', ist(new Date(Date.now() - minutes * 60000))]], note: error }, 'feed-down', 30 * 60000);
  },

  feedRecovered(downMs: number): void {
    notifier.reset('feed-down');
    void notifier.card('success', { title: 'MT5 connection restored', rows: [['Downtime', dur(downMs)]] });
  },
};
