import { Calculator } from '../../src/utils/calculator';

describe('Calculator', () => {
  describe('calculatePositionSize', () => {
    it('should calculate correct position size', () => {
      const positionSize = Calculator.calculatePositionSize(30, 1.0950, 1.0900);
      expect(positionSize).toBeGreaterThan(0);
    });
  });

  describe('calculateTakeProfit', () => {
    it('should calculate TP for 1:2 ratio on BUY', () => {
      const tp = Calculator.calculateTakeProfit(1.0950, 1.0900, 'BUY', 2);
      expect(tp).toBeGreaterThan(1.0950);
    });

    it('should calculate TP for 1:2 ratio on SELL', () => {
      const tp = Calculator.calculateTakeProfit(1.0950, 1.1000, 'SELL', 2);
      expect(tp).toBeLessThan(1.0950);
    });
  });

  describe('calculatePips', () => {
    it('should calculate pips correctly', () => {
      const pips = Calculator.calculatePips(1.1000, 1.0950);
      expect(pips).toBe(50);
    });
  });

  describe('calculateWinRate', () => {
    it('should calculate win rate correctly', () => {
      const rate = Calculator.calculateWinRate(70, 100);
      expect(rate).toBe(70);
    });
  });
});
