/**
 * Dashboard actions: trading ON/OFF, manual SL/TP changes, manual BUY/SELL and close.
 *
 * Manual trades use their own magic number (MT5_MAGIC + 1), so the bot never adopts, counts or
 * journals them — the bot keeps trading its strategy independently. Two shared rules still apply:
 * no hedging (opposite directions at the same time) and the FundedNext loss limits.
 */
import { config } from '../config';
import { logger } from '../utils/logger';
import { serverToUtc } from '../utils/time';
import { dashboardData } from '../services/dashboardData';
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

export const MANUAL_MAGIC = config.mt5Magic + 1;
export const MANUAL_MAX_LOTS = 1;
const SYMBOL = 'XAUUSD';

function requireLive(): void {
  if (tradeExecutor.isDryRun || marketClient.isSimulated) throw new ActionError('Manual trading needs the live MT5 connection (DRY_RUN=false, DATA_SOURCE=mt5)');
}

/** Loss room left today and overall, from live MT5 equity */
export function lossRoom(): { daily: number; total: number } | null {
  const snap = dashboardData.snapshot;
  const acc = snap.account;
  if (!acc) return null;
  const dayStart = snap.dayStart?.balance ?? acc.balance;
  return {
    daily: round2(acc.equity - (dayStart - config.maxDailyLoss)),
    total: round2(acc.equity - (config.accountBalance - config.maxTotalLoss)),
  };
}

/** Pure checks for a manual order. Returns an error message or null. */
export function validateManualOrder(
  o: { side: unknown; lots: number; sl: number; tp: number },
  q: { bid: number; ask: number },
  openSides: ('BUY' | 'SELL')[],
  room: { daily: number; total: number } | null,
  contract = 100
): string | null {
  if (o.side !== 'BUY' && o.side !== 'SELL') return 'side must be BUY or SELL';
  if (!Number.isFinite(o.lots) || o.lots < 0.01 || o.lots > MANUAL_MAX_LOTS) return `Lots must be 0.01 – ${MANUAL_MAX_LOTS}`;
  if (Math.abs(o.lots * 100 - Math.round(o.lots * 100)) > 1e-6) return 'Lots in steps of 0.01';
  const lv = validateLevels(o.side, o.sl, o.tp, q.bid, q.ask);
  if (lv) return lv;
  const opposite = o.side === 'BUY' ? 'SELL' : 'BUY';
  if (openSides.includes(opposite)) return `A ${opposite} position is open — opposite trades at the same time (hedging) are not allowed`;
  const entry = o.side === 'BUY' ? q.ask : q.bid;
  const risk = Math.abs(entry - o.sl) * o.lots * contract;
  if (room) {
    if (risk >= room.daily) return `Risk $${risk.toFixed(2)} would break today's loss limit (room $${room.daily.toFixed(2)})`;
    if (risk >= room.total) return `Risk $${risk.toFixed(2)} would break the max loss limit (room $${room.total.toFixed(2)})`;
  }
  return null;
}

export async function placeManualOrder(body: { side?: unknown; lots?: unknown; sl?: unknown; tp?: unknown }): Promise<{ ticket: number; side: string; lots: number; price: number; sl: number; tp: number; risk: number }> {
  requireLive();
  const side = body.side;
  const lots = round2(Number(body.lots));
  const sl = round2(Number(body.sl));
  const tp = round2(Number(body.tp));
  const q = await marketClient.getCurrentPrice(SYMBOL);
  const positions = await mt5Bridge.positions();
  const err = validateManualOrder({ side, lots, sl, tp }, q, positions.map((p) => p.side), lossRoom(), getPairSpec(SYMBOL).contractSize);
  if (err) throw new ActionError(err);
  const s = side as 'BUY' | 'SELL';
  let res;
  try {
    res = await mt5Bridge.order({ symbol: SYMBOL, side: s, volume: lots, sl, tp, magic: MANUAL_MAGIC, comment: 'manual' });
  } catch (error) {
    throw new ActionError((error as Error).message.replace(/^MT5 bridge POST \/order failed: /, 'MT5: '), 502);
  }
  const price = res.price || (s === 'BUY' ? q.ask : q.bid);
  const ticket = res.ticket ?? res.order;
  const risk = round2(Math.abs(price - sl) * lots * getPairSpec(SYMBOL).contractSize);
  logger.info(`🖐️ Manual ${s} ${lots} ${SYMBOL} @ ${price} SL ${sl} TP ${tp} (ticket ${ticket}, dashboard)`);
  alerts.manualOpened({ ticket, side: s, lots, price, sl, tp, risk });
  return { ticket, side: s, lots, price, sl, tp, risk };
}

export async function closePosition(body: { ticket?: unknown }): Promise<{ ticket: number; profit: number }> {
  requireLive();
  const ticket = Number(body.ticket);
  if (!Number.isInteger(ticket) || ticket <= 0) throw new ActionError('ticket must be a number');
  const pos = (await mt5Bridge.positions()).find((p) => p.ticket === ticket);
  if (!pos) throw new ActionError(`Position ${ticket} is not open any more`, 404);
  const ageSec = (Date.now() - serverToUtc(new Date(pos.time)).getTime()) / 1000;
  if (Number.isFinite(ageSec) && ageSec < config.minTradeDurationSeconds) {
    throw new ActionError(`FundedNext rule: keep a trade at least ${config.minTradeDurationSeconds}s — wait ${Math.ceil(config.minTradeDurationSeconds - ageSec)}s more`);
  }
  try {
    await mt5Bridge.close(ticket);
  } catch (error) {
    throw new ActionError((error as Error).message.replace(/^MT5 bridge POST \/close failed: /, 'MT5: '), 502);
  }
  const profit = round2(pos.profit + (pos.swap || 0));
  const byBot = pos.magic === config.mt5Magic;
  logger.info(`🖐️ Position ${ticket} closed from the dashboard (${byBot ? 'bot' : 'manual'} trade, ~$${profit})`);
  // bot trades: the bot's own sync records the close in the journal from MT5 history
  if (!byBot) alerts.manualClosed({ ticket, side: pos.side, lots: pos.volume, entry: pos.priceOpen, exit: pos.priceCurrent, profit });
  return { ticket, profit };
}
