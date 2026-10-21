import { Calculator } from '../../src/utils/calculator';
import { RiskManager } from '../../src/services/riskManager';
import { TradeMonitor } from '../../src/services/tradeMonitor';
import { getZonedTime, isWithinTradingSession } from '../../src/utils/time';

describe('Position sizing & P&L', () => {
  it('loses exactly the risk amount at the stop (EURUSD)', () => {
    const units = Calculator.calculatePositionSize(30, 1.095, 1.09);
    expect(Calculator.calculatePnL(1.095, 1.09, units, 'BUY')).toBeCloseTo(-30, 1);
  });

  it('loses exactly the risk amount at the stop (XAUUSD)', () => {
    const units = Calculator.calculatePositionSize(30, 2650, 2665);
    expect(Calculator.calculatePnL(2650, 2665, units, 'SELL')).toBeCloseTo(-30, 1);
  });

  it('returns 0 size for zero stop distance', () => {
    expect(Calculator.calculatePositionSize(30, 1.1, 1.1)).toBe(0);
  });
});

describe('TradeMonitor', () => {
  it('detects stop loss and take profit', () => {
    const monitor = new TradeMonitor();
    const units = Calculator.calculatePositionSize(30, 1.1, 1.095);
    monitor.registerTrade({
      tradeId: 'T1', pair: 'EURUSD', type: 'BUY', entryPrice: 1.1, currentPrice: 1.1,
      quantity: units, stopLoss: 1.095, takeProfit: 1.11, pnl: 0, pnlPercent: 0, openedAt: new Date(),
    });
    expect(monitor.updateTradePrice('T1', { bid: 1.1005, ask: 1.1006 })).toBeNull();
    expect(monitor.updateTradePrice('T1', { bid: 1.111, ask: 1.1111 })).toBe('TAKE_PROFIT');
    expect(monitor.updateTradePrice('T1', { bid: 1.094, ask: 1.0941 })).toBe('STOP_LOSS');
  });
});

describe('RiskManager', () => {
  it('blocks new trades after the safety buffer is hit', () => {
    const rm = new RiskManager();
    expect(rm.canPlaceTrade().allowed).toBe(true);
    rm.recordTradeOpened();
    rm.recordTradeClosed(-30);
    rm.recordTradeOpened();
    rm.recordTradeClosed(-30);
    expect(rm.canPlaceTrade().allowed).toBe(true);
    expect(rm.canPlaceTrade(-15).allowed).toBe(false); // -75 incl. unrealized
  });

  it('blocks after max trades per day', () => {
    const rm = new RiskManager();
    rm.recordTradeOpened();
    rm.recordTradeOpened();
    rm.recordTradeOpened();
    expect(rm.canPlaceTrade().allowed).toBe(false);
    rm.resetDaily();
    expect(rm.canPlaceTrade().allowed).toBe(true);
  });
});

describe('Timezone handling', () => {
  it('converts UTC to IST', () => {
    const t = getZonedTime(new Date('2026-10-22T08:00:00Z'), 'Asia/Kolkata');
    expect(t.hour).toBe(13);
    expect(t.minute).toBe(30);
  });

  it('is in session at 14:00 IST on a weekday and not on Saturday', () => {
    expect(isWithinTradingSession(new Date('2026-10-22T08:30:00Z'))).toBe(true); // Thu 14:00 IST
    expect(isWithinTradingSession(new Date('2026-10-24T08:30:00Z'))).toBe(false); // Sat
    expect(isWithinTradingSession(new Date('2026-10-22T02:00:00Z'))).toBe(false); // 07:30 IST
  });
});
