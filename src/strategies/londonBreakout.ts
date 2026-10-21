import { logger } from '../utils/logger';
import { Calculator } from '../utils/calculator';

export interface BreakoutSignal {
  detected: boolean;
  direction: 'UP' | 'DOWN' | null;
  breakoutPrice: number;
  yesterdayHigh: number;
  yesterdayLow: number;
  strength: number; // 0-100
  confidence: number; // 0-1
}

export class LondonBreakoutDetector {
  /**
   * Detect London Breakout: Price breaks above yesterday's high or below yesterday's low
   */
  static detectBreakout(
    currentPrice: number,
    yesterdayHigh: number,
    yesterdayLow: number,
    closeAboveHigh: boolean,
    closeBelowLow: boolean
  ): BreakoutSignal {
    const breakoutAboveHigh = closeAboveHigh && currentPrice > yesterdayHigh;
    const breakoutBelowLow = closeBelowLow && currentPrice < yesterdayLow;

    const detected = breakoutAboveHigh || breakoutBelowLow;
    const direction = breakoutAboveHigh ? 'UP' : breakoutBelowLow ? 'DOWN' : null;

    // Calculate breakout strength (distance from breakout level in pips)
    let strength = 0;
    let breakoutPrice = 0;

    if (breakoutAboveHigh) {
      const pips = Calculator.calculatePips(yesterdayHigh, currentPrice);
      strength = Math.min(pips * 2, 100); // Max 100
      breakoutPrice = currentPrice;
    } else if (breakoutBelowLow) {
      const pips = Calculator.calculatePips(yesterdayLow, currentPrice);
      strength = Math.min(pips * 2, 100); // Max 100
      breakoutPrice = currentPrice;
    }

    const confidence = detected ? Math.min(strength / 100, 1) : 0;

    const signal: BreakoutSignal = {
      detected,
      direction,
      breakoutPrice,
      yesterdayHigh,
      yesterdayLow,
      strength: parseFloat(strength.toFixed(2)),
      confidence: parseFloat(confidence.toFixed(2)),
    };

    logger.debug('Breakout detection completed', {
      detected,
      direction,
      strength: signal.strength,
    });

    return signal;
  }

  /**
   * Check if breakout is confirmed (candle closed above/below)
   */
  static isBreakoutConfirmed(
    candleOpen: number,
    candleClose: number,
    breakoutLevel: number,
    direction: 'UP' | 'DOWN'
  ): boolean {
    if (direction === 'UP') {
      return candleClose > breakoutLevel && candleOpen <= breakoutLevel;
    } else {
      return candleClose < breakoutLevel && candleOpen >= breakoutLevel;
    }
  }

  /**
   * Validate breakout is not a false breakout (wick)
   */
  static validateBreakoutQuality(
    high: number,
    low: number,
    close: number,
    breakoutDirection: 'UP' | 'DOWN'
  ): boolean {
    const bodySize = Math.abs(close - (close > breakoutDirection === 'UP' ? low : high));
    const wickSize =
      breakoutDirection === 'UP'
        ? Math.abs(high - close)
        : Math.abs(low - close);

    // Body should be larger than wick (no wicks)
    const isQualityBreakout = bodySize > wickSize * 0.5;

    logger.debug('Breakout quality validated', {
      bodySize,
      wickSize,
      isQuality: isQualityBreakout,
    });

    return isQualityBreakout;
  }

  /**
   * Calculate range width for breakout setup
   */
  static calculateRangeWidth(high: number, low: number): number {
    const width = Calculator.calculatePips(low, high);
    logger.debug('Range width calculated', { width: `${width} pips` });
    return width;
  }

  /**
   * Determine entry price after breakout confirmation
   */
  static calculateEntryPrice(
    breakoutLevel: number,
    direction: 'UP' | 'DOWN'
  ): number {
    // Entry on slight pullback or at breakout level
    const pullbackPips = 5; // 5 pips pullback
    const entry =
      direction === 'UP'
        ? breakoutLevel - pullbackPips * 0.0001
        : breakoutLevel + pullbackPips * 0.0001;

    return parseFloat(entry.toFixed(5));
  }
}
