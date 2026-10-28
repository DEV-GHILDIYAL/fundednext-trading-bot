import { Calculator } from '../../src/utils/calculator';
import { RiskManager } from '../../src/services/riskManager';
import { TradeMonitor } from '../../src/services/tradeMonitor';
import { getZonedTime, isWithinTradingSession } from '../../src/utils/time';
import { config } from '../../src/config';
import { Validator } from '../../src/utils/validator';

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
  it('detects stop loss and take profit after the minimum hold', () => {
    const monitor = new TradeMonitor(null);
    const units = Calculator.calculatePositionSize(30, 1.1, 1.095);
    monitor.registerTrade({
      tradeId: 'T1', pair: 'EURUSD', type: 'BUY', entryPrice: 1.1, currentPrice: 1.1,
      quantity: units, stopLoss: 1.095, takeProfit: 1.11, pnl: 0, pnlPercent: 0,
      openedAt: new Date(Date.now() - 31_000),
    });
    expect(monitor.updateTradePrice('T1', { bid: 1.1005, ask: 1.1006 })).toBeNull();
    expect(monitor.updateTradePrice('T1', { bid: 1.111, ask: 1.1111 })).toBe('TAKE_PROFIT');
    expect(monitor.updateTradePrice('T1', { bid: 1.094, ask: 1.0941 })).toBe('STOP_LOSS');
  });

  it('refuses to close a trade before the 30 second minimum', () => {
    const monitor = new TradeMonitor(null);
    const units = Calculator.calculatePositionSize(config.riskPerTrade, 1.1, 1.095);
    monitor.registerTrade({
      tradeId: 'T2', pair: 'EURUSD', type: 'BUY', entryPrice: 1.1, currentPrice: 1.1,
      quantity: units, stopLoss: 1.095, takeProfit: 1.11, pnl: 0, pnlPercent: 0,
      openedAt: new Date(),
    });
    // SL/TP would be hit, but the Quick Strike guard defers the exit.
    expect(monitor.updateTradePrice('T2', { bid: 1.111, ask: 1.1111 })).toBeNull();
    expect(monitor.updateTradePrice('T2', { bid: 1.094, ask: 1.0941 })).toBeNull();

    // After 30s the original TP is honoured even if price has recovered.
    const trade = monitor.getTradeStatus('T2');
    expect(trade).not.toBeNull();
    trade!.openedAt = new Date(Date.now() - 31_000);
    expect(monitor.updateTradePrice('T2', { bid: 1.1005, ask: 1.1006 })).toBe('TAKE_PROFIT');
  });
});

describe('FundedNext rules', () => {
  it('risks 0.75% of the account balance', () => {
    expect(config.riskPercent).toBe(0.75);
    expect(config.riskPerTrade).toBeCloseTo(config.accountBalance * 0.0075, 2);
  });

  it('uses the correct Stellar 2-Step target for the configured phase', () => {
    const expectedTarget = config.challengePhase === 2 ? 5 : 8;
    expect(config.profitTargetPercent).toBe(expectedTarget);
    expect(config.targetProfit).toBeCloseTo(config.accountBalance * (expectedTarget / 100), 2);
    expect(config.minTradingDaysPerPhase).toBe(5);
  });

  it('allows at most 3 trades per day', () => {
    expect(config.maxTradesPerDay).toBe(3);
  });

  it('enforces exactly 1:2 risk-reward', () => {
    expect(() => Validator.validateRRRatio(2)).not.toThrow();
    expect(() => Validator.validateRRRatio(2.01)).not.toThrow();
    expect(() => Validator.validateRRRatio(1.5)).toThrow();
    expect(() => Validator.validateRRRatio(3)).toThrow();
  });
});

describe('RiskManager', () => {
  it('allows three 0.75% losses, then blocks for the day', () => {
    const rm = new RiskManager();
    expect(rm.canPlaceTrade().allowed).toBe(true);
    rm.recordTradeOpened();
    rm.recordTradeClosed(-config.riskPerTrade);
    rm.recordTradeOpened();
    rm.recordTradeClosed(-config.riskPerTrade);
    expect(rm.canPlaceTrade().allowed).toBe(true);
    rm.recordTradeOpened();
    rm.recordTradeClosed(-config.riskPerTrade);
    expect(rm.canPlaceTrade().allowed).toBe(false);
  });

  it('blocks at the FundedNext daily loss limit', () => {
    const rm = new RiskManager();
    rm.recordTradeOpened();
    rm.recordTradeClosed(-config.maxDailyLoss);
    expect(rm.canPlaceTrade().allowed).toBe(false);
  });

  it('blocks at the FundedNext maximum loss limit', () => {
    const rm = new RiskManager();
    expect(rm.canPlaceTrade(0, -config.maxTotalLoss).allowed).toBe(false);
  });

  it('blocks after the profit target is reached', () => {
    const rm = new RiskManager();
    expect(rm.canPlaceTrade(0, config.targetProfit, config.minTradingDaysPerPhase).allowed).toBe(false);
  });

  it('allows one maintenance trade per day when target is hit before min days', () => {
    const rm = new RiskManager();
    expect(rm.canPlaceTrade(0, config.targetProfit, 0).allowed).toBe(true);
    rm.recordTradeOpened();
    expect(rm.canPlaceTrade(0, config.targetProfit, 0).allowed).toBe(false);
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
