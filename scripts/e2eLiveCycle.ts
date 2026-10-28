/**
 * End-to-end check of the LIVE order path against the MOCK MT5 bridge (bridge/app.py with BRIDGE_MOCK=1).
 * Runs the real bot code: executor → bridge order → MT5 position (SL/TP) → broker closes at TP / SL →
 * bot sync → journal, risk counters, Telegram text. Never point this at the real bridge.
 *
 *   cd bridge && BRIDGE_MOCK=1 BRIDGE_TOKEN=e2e uvicorn app:app --port 8766 &
 *   E2E_BRIDGE_URL=http://127.0.0.1:8766 E2E_BRIDGE_TOKEN=e2e npx ts-node scripts/e2eLiveCycle.ts
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

const url = process.env.E2E_BRIDGE_URL || 'http://127.0.0.1:8766';
const token = process.env.E2E_BRIDGE_TOKEN || 'e2etoken';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
Object.assign(process.env, {
  DATA_SOURCE: 'mt5',
  MT5_BRIDGE_URL: url,
  MT5_BRIDGE_TOKEN: token,
  DRY_RUN: 'false',
  DATA_DIR: dataDir,
  LOG_DIR: dataDir,
  STRATEGIES: 'fibSweep:M5:2',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_CHAT_ID: '',
  LOG_LEVEL: 'warn',
});

/* eslint-disable @typescript-eslint/no-var-requires */
const { mt5Bridge } = require('../src/api/mt5Bridge');
const { marketClient } = require('../src/api/market');
const { tradeExecutor } = require('../src/services/tradeExecutor');
const { tradeMonitor } = require('../src/services/tradeMonitor');
const { tradeJournal } = require('../src/services/tradeJournal');
const { riskManager } = require('../src/services/riskManager');
const { notifier } = require('../src/services/notifier');
const { alerts } = require('../src/services/alerts');
const { bot } = require('../src/bot/bot');
const { EntrySignalGenerator } = require('../src/strategies/entrySignalGenerator');

let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function mockPrice(price: number): Promise<void> {
  await fetch(`${url}/mock/price`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ price }) });
}

async function cycle(side: 'BUY' | 'SELL', outcome: 'TP' | 'SL'): Promise<void> {
  console.log(`\n${side} → ${outcome}`);
  const q = await marketClient.getCurrentPrice('XAUUSD');
  const entry = side === 'BUY' ? q.ask : q.bid;
  // fibSweep geometry: SL 9.23 away, TP 16.46 away (1:1.78 — the case that was refused on 26 Oct)
  const sl = side === 'BUY' ? entry - 9.23 : entry + 9.23;
  const tp = side === 'BUY' ? entry + 16.46 : entry - 16.46;
  const base = EntrySignalGenerator.skipSignal('XAUUSD', '', new Date().toISOString());
  const signal = {
    ...base,
    signal: side,
    entryPrice: +entry.toFixed(2),
    stopLoss: +sl.toFixed(2),
    takeProfit: +tp.toFixed(2),
    riskRewardRatio: 2,
    reasoning: '[fibSweep] e2e test',
  };

  const res = await tradeExecutor.executeTrade(signal);
  check(res.success === true, 'order accepted by executor + bridge', res.success ? `ticket ${res.ticket}, ${res.lots} lot @ ${res.executedPrice}` : res.error ?? res.message);
  if (!res.success) return;
  check(res.lots === 0.04, 'lot size = floor($45 / ($9.23 × 100 oz), 0.01)', `${res.lots} lot, risk $${res.riskAmount}`);
  check(res.riskAmount <= 45.5, 'actual risk ≤ $45 (+ fill slippage)', `$${res.riskAmount}`);

  const trade = {
    tradeId: res.tradeId, pair: 'XAUUSD', type: side, entryPrice: res.executedPrice, currentPrice: res.executedPrice,
    quantity: res.quantity, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, pnl: 0, pnlPercent: 0,
    openedAt: new Date(Date.now() - 60000), ticket: res.ticket, lots: res.lots, riskAmount: res.riskAmount, sleeve: 'fibSweep:M5',
  };
  tradeMonitor.registerTrade(trade);
  tradeJournal.recordOpen(trade);
  riskManager.recordTradeOpened();
  alerts.tradeOpened(trade, { lots: res.lots, risk: res.riskAmount, confidence: 0.78 });
  check(/opened · fibSweep M5/.test(notifier.sent[notifier.sent.length - 1].text), 'Telegram "opened" alert built');

  const pos = (await mt5Bridge.positions()).find((p: { ticket: number }) => p.ticket === res.ticket);
  check(!!pos, 'position visible in MT5');
  if (pos) {
    check(Math.abs(pos.sl - signal.stopLoss) < 0.01 && Math.abs(pos.tp - signal.takeProfit) < 0.01, 'SL/TP set on the MT5 position', `SL ${pos.sl} TP ${pos.tp}`);
    check(pos.volume === res.lots && pos.side === side, 'side + volume match');
  }

  // broker hits TP / SL
  const hit = outcome === 'TP' ? (side === 'BUY' ? tp + 0.5 : tp - 0.5) : side === 'BUY' ? sl - 0.5 : sl + 0.5;
  await mockPrice(hit);
  await mt5Bridge.positions(); // mock processes stops on the next call
  await bot.syncLivePositions();

  check(tradeMonitor.getOpenTrades().length === 0, 'bot noticed the broker closed the position');
  const closed = tradeJournal.getAllClosed().find((t: { tradeId: string }) => t.tradeId === res.tradeId);
  check(!!closed, 'trade written to the journal');
  if (closed) {
    const want = outcome === 'TP' ? 'TAKE_PROFIT' : 'STOP_LOSS';
    check(closed.reason === want, `close reason ${want}`, closed.reason);
    check(outcome === 'TP' ? closed.pnl > 60 : closed.pnl < -30, `P&L sign/size (${outcome})`, `$${closed.pnl}`);
    check(closed.sleeve === 'fibSweep:M5', 'strategy recorded on the trade (used by the 2-trades/day rule)');
  }
  const last = notifier.sent[notifier.sent.length - 1].text;
  check(outcome === 'TP' ? /Take profit hit/.test(last) : /Stop loss hit/.test(last), 'Telegram "closed" alert built', last.split('\n')[0]);
  await mockPrice(entry); // reset price
}

async function main(): Promise<void> {
  console.log(`E2E live cycle against MOCK bridge ${url} (data dir ${dataDir})`);
  const h = await mt5Bridge.health();
  if (!h.mock) {
    console.error('Refusing to run: this bridge is NOT the mock. Never test against the real account.');
    process.exit(2);
  }
  check(tradeExecutor.isDryRun === false, 'executor in LIVE mode');
  await cycle('SELL', 'TP');
  await cycle('BUY', 'SL');
  const rs = riskManager.getStatus();
  check(rs.tradesExecuted === 2, 'risk manager counted 2 trades today', `${rs.tradesExecuted}`);
  check(rs.wins === 1 && rs.losses === 1, 'wins/losses counted', `W ${rs.wins} L ${rs.losses}`);
  console.log(`\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E crashed:', e);
  process.exit(1);
});
