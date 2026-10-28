/**
 * Dashboard actions: trading ON/OFF and manual SL/TP changes.
 */
import { logger } from '../utils/logger';
import { control, ControlState } from '../services/control';
import { alerts } from '../services/alerts';
import { tradeMonitor } from '../services/tradeMonitor';
import { tradeExecutor } from '../services/tradeExecutor';
import { mt5Bridge } from '../api/mt5Bridge';
import { marketClient } from '../api/market';
import { getPairSpec } from '../constants/pairs';

export class ActionError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
  }
}

export function setTrading(enabled: unknown): ControlState {
  if (typeof enabled !== 'boolean') throw new ActionError('tradingEnabled must be true or false');
  const before = control.tradingEnabled;
  const state = control.setTrading(enabled, 'dashboard');
  if (before !== enabled) {
    logger.warn(enabled ? '▶️ Trading switched ON from the dashboard' : '⏸️ Trading switched OFF from the dashboard — no new trades');
    alerts.tradingSwitched(enabled);
  }
  return state;
}

/**
 * Checks new SL/TP for a position: numbers, on the right side of the current price, and not absurdly far
 * (fat-finger guard: within 15% of the price). Returns an error message or null.
 */
export function validateLevels(side: 'BUY' | 'SELL', sl: number, tp: number, bid: number, ask: number): string | null {
  if (!Number.isFinite(sl) || !Number.isFinite(tp) || sl <= 0 || tp <= 0) return 'SL and TP must be positive numbers';
  const mid = (bid + ask) / 2;
  if (Math.abs(sl - mid) > mid * 0.15 || Math.abs(tp - mid) > mid * 0.15) return 'SL/TP more than 15% away from the price — typo?';
  if (side === 'BUY') {
    if (sl >= bid) return `BUY: stop loss must be below the current bid ${bid.toFixed(2)}`;
    if (tp <= ask) return `BUY: take profit must be above the current ask ${ask.toFixed(2)}`;
  } else {
    if (sl <= ask) return `SELL: stop loss must be above the current ask ${ask.toFixed(2)}`;
    if (tp >= bid) return `SELL: take profit must be below the current bid ${bid.toFixed(2)}`;
  }
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function modifyLevels(body: { ticket?: unknown; sl?: unknown; tp?: unknown }): Promise<{ ticket: number | string; sl: number; tp: number; risk: number | null }> {
  const sl = round2(Number(body.sl));
  const tp = round2(Number(body.tp));
  const ticketRaw = body.ticket;
  if (ticketRaw === undefined || ticketRaw === null || ticketRaw === '') throw new ActionError('ticket missing');

  const live = !tradeExecutor.isDryRun && !marketClient.isSimulated;
  if (live) {
    const ticket = Number(ticketRaw);
    if (!Number.isInteger(ticket) || ticket <= 0) throw new ActionError('ticket must be a number');
    const pos = (await mt5Bridge.positions()).find((p) => p.ticket === ticket);
    if (!pos) throw new ActionError(`Position ${ticket} is not open any more`, 404);
    const q = await marketClient.getCurrentPrice(pos.symbol);
    const err = validateLevels(pos.side, sl, tp, q.bid, q.ask);
    if (err) throw new ActionError(err);
    try {
      await mt5Bridge.modify(ticket, sl, tp);
    } catch (error) {
      throw new ActionError((error as Error).message.replace(/^MT5 bridge POST \/modify failed: /, 'MT5: '), 502);
    }
    const trade = tradeMonitor.getOpenTrades().find((t) => t.ticket === ticket);
    if (trade) tradeMonitor.setLevels(trade.tradeId, sl, tp);
    const contract = getPairSpec(pos.symbol).contractSize;
    const risk = round2((pos.side === 'BUY' ? pos.priceOpen - sl : sl - pos.priceOpen) * pos.volume * contract);
    alerts.levelsChanged({ ticket, side: pos.side, entry: pos.priceOpen, oldSl: pos.sl, oldTp: pos.tp, sl, tp, risk });
    logger.info(`✏️ Position ${ticket} SL ${pos.sl} → ${sl}, TP ${pos.tp} → ${tp} (dashboard)`);
    return { ticket, sl, tp, risk };
  }

  // paper mode: bot-tracked trade by ticket or tradeId
  const trade = tradeMonitor.getOpenTrades().find((t) => String(t.ticket) === String(ticketRaw) || t.tradeId === String(ticketRaw));
  if (!trade) throw new ActionError(`Trade ${String(ticketRaw)} is not open any more`, 404);
  const q = await marketClient.getCurrentPrice(trade.pair);
  const err = validateLevels(trade.type, sl, tp, q.bid, q.ask);
  if (err) throw new ActionError(err);
  const old = { sl: trade.stopLoss, tp: trade.takeProfit };
  tradeMonitor.setLevels(trade.tradeId, sl, tp);
  const risk = round2((trade.type === 'BUY' ? trade.entryPrice - sl : sl - trade.entryPrice) * trade.quantity);
  alerts.levelsChanged({ ticket: trade.ticket ?? 0, side: trade.type, entry: trade.entryPrice, oldSl: old.sl, oldTp: old.tp, sl, tp, risk });
  return { ticket: trade.ticket ?? trade.tradeId, sl, tp, risk };
}
