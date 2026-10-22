import fs from 'fs';
import os from 'os';
import path from 'path';
import { TradeJournal } from '../../src/services/tradeJournal';
import { OpenTrade } from '../../src/services/tradeMonitor';

const trade = (id: string, openedAt: Date): OpenTrade => ({
  tradeId: id, pair: 'EURUSD', type: 'BUY', entryPrice: 1.1, currentPrice: 1.1, quantity: 6000,
  stopLoss: 1.095, takeProfit: 1.11, pnl: 0, pnlPercent: 0, openedAt,
});

describe('TradeJournal', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('persists trades and reloads them after restart', () => {
    const j1 = new TradeJournal(dir);
    j1.recordOpen(trade('A', new Date()));
    j1.recordClose('A', 1.095, -30, 'STOP_LOSS');
    j1.recordOpen(trade('B', new Date()));
    j1.recordClose('B', 1.11, 60, 'TAKE_PROFIT');

    const j2 = new TradeJournal(dir);
    const summary = j2.getSummary();
    expect(summary.totalTrades).toBe(2);
    expect(summary.totalPnL).toBe(30);
    expect(summary.winRate).toBe(50);
    expect(j2.getClosedTrades()[0].tradeId).toBe('B');
    expect(j2.getEquityCurve().map((p) => p.equity)).toEqual([-30, 30]);
  });

  it('counts only today\'s trades (including still-open ones) for risk restore', () => {
    const j = new TradeJournal(dir);
    j.recordOpen(trade('OLD', new Date('2020-01-01T08:00:00Z')));
    j.recordClose('OLD', 1.095, -30, 'STOP_LOSS');
    j.recordOpen(trade('T1', new Date()));
    j.recordClose('T1', 1.095, -30, 'STOP_LOSS');
    j.recordOpen(trade('T2', new Date()));

    const today = j.getTodayStats();
    expect(today.trades).toBe(2);
    expect(today.realizedPnL).toBe(-30);
    expect(today.losses).toBe(1);
  });

  it('ignores corrupted lines', () => {
    fs.writeFileSync(path.join(dir, 'trades.jsonl'), 'not json\n');
    expect(() => new TradeJournal(dir)).not.toThrow();
  });
});
