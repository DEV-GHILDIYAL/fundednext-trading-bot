import { LondonBreakoutDetector } from '../../src/strategies/londonBreakout';
import { SupportResistanceCalculator } from '../../src/strategies/supportResistance';
import { PriceActionAnalyzer } from '../../src/strategies/priceAction';
import { CandleData } from '../../src/api/market';

describe('Strategy Tests', () => {
  describe('LondonBreakoutDetector', () => {
    it('should detect upside breakout', () => {
      const signal = LondonBreakoutDetector.detectBreakout(
        1.1000, // current price
        1.0950, // yesterday high
        1.0900, // yesterday low
        true, // close above high
        false // close below low
      );

      expect(signal.detected).toBe(true);
      expect(signal.direction).toBe('UP');
      expect(signal.confidence).toBeGreaterThan(0);
    });

    it('should detect downside breakout', () => {
      const signal = LondonBreakoutDetector.detectBreakout(
        1.0800,
        1.0950,
        1.0900,
        false,
        true
      );

      expect(signal.detected).toBe(true);
      expect(signal.direction).toBe('DOWN');
    });

    it('should not detect breakout without confirmation', () => {
      const signal = LondonBreakoutDetector.detectBreakout(
        1.0940,
        1.0950,
        1.0900,
        false,
        false
      );

      expect(signal.detected).toBe(false);
    });
  });

  describe('SupportResistanceCalculator', () => {
    it('should calculate pivot points', () => {
      const pivots = SupportResistanceCalculator.calculatePivotPoints(
        1.1000,
        1.0900,
        1.0950
      );

      expect(pivots.pp).toBeGreaterThan(0);
      expect(pivots.r1).toBeGreaterThan(pivots.pp);
      expect(pivots.s1).toBeLessThan(pivots.pp);
    });

    it('should validate entry within S/R range', () => {
      const validation = SupportResistanceCalculator.validateEntryAgainstSR(
        1.0950,
        1.0900,
        1.1000,
        'BUY'
      );

      expect(validation.valid).toBe(true);
    });

    it('should reject entry outside S/R range', () => {
      const validation = SupportResistanceCalculator.validateEntryAgainstSR(
        1.1100,
        1.0900,
        1.1000,
        'BUY'
      );

      expect(validation.valid).toBe(false);
    });
  });

  describe('PriceActionAnalyzer', () => {
    const mockCandles: CandleData[] = [
      {
        timestamp: new Date('2026-10-21T08:00:00'),
        open: 1.0900,
        high: 1.0920,
        low: 1.0890,
        close: 1.0910,
      },
      {
        timestamp: new Date('2026-10-21T09:00:00'),
        open: 1.0910,
        high: 1.0930,
        low: 1.0900,
        close: 1.0925,
      },
      {
        timestamp: new Date('2026-10-21T10:00:00'),
        open: 1.0925,
        high: 1.0950,
        low: 1.0920,
        close: 1.0945,
      },
    ];

    it('should analyze uptrend', () => {
      const trend = PriceActionAnalyzer.analyzeTrend(mockCandles);
      expect(trend).toBe('UP');
    });

    it('should calculate momentum', () => {
      const momentum = PriceActionAnalyzer.calculateMomentum(mockCandles);
      expect(momentum).toBeGreaterThan(0);
    });

    it('should analyze volatility', () => {
      const volatility = PriceActionAnalyzer.analyzeVolatility(mockCandles);
      expect(volatility).toBeGreaterThan(0);
    });
  });
});
