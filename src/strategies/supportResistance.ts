import { logger } from '../utils/logger';
import { CandleData } from '../api/market';

export interface SRLevel {
  level: number;
  type: 'SUPPORT' | 'RESISTANCE';
  strength: number; // 0-100 (how many times touched)
  touches: number; // Number of touches
  breakoutProbability: number; // 0-1
}

export class SupportResistanceCalculator {
  /**
   * Calculate pivot points (Daily PP)
   */
  static calculatePivotPoints(
    high: number,
    low: number,
    close: number
  ): { pp: number; r1: number; r2: number; s1: number; s2: number } {
    const pp = (high + low + close) / 3;
    const r1 = 2 * pp - low;
    const r2 = pp + (high - low);
    const s1 = 2 * pp - high;
    const s2 = pp - (high - low);

    logger.debug('Pivot points calculated', {
      pp: pp.toFixed(5),
      r1: r1.toFixed(5),
      s1: s1.toFixed(5),
    });

    return {
      pp: parseFloat(pp.toFixed(5)),
      r1: parseFloat(r1.toFixed(5)),
      r2: parseFloat(r2.toFixed(5)),
      s1: parseFloat(s1.toFixed(5)),
      s2: parseFloat(s2.toFixed(5)),
    };
  }

  /**
   * Find local support/resistance levels from recent candles
   */
  static findLocalLevels(candles: CandleData[], sensitivity: number = 5): SRLevel[] {
    const levels: Map<number, SRLevel> = new Map();

    // Identify local highs and lows
    for (let i = sensitivity; i < candles.length - sensitivity; i++) {
      const current = candles[i];
      let isLocalHigh = true;
      let isLocalLow = true;

      // Check previous and next candles
      for (let j = i - sensitivity; j <= i + sensitivity; j++) {
        if (j === i) continue;
        if (candles[j].high > current.high) isLocalHigh = false;
        if (candles[j].low < current.low) isLocalLow = false;
      }

      // Register local high as resistance
      if (isLocalHigh) {
        const level = parseFloat(current.high.toFixed(5));
        const existing = levels.get(level) || {
          level,
          type: 'RESISTANCE',
          strength: 0,
          touches: 0,
          breakoutProbability: 0.5,
        };
        existing.touches++;
        existing.strength = Math.min(existing.touches * 20, 100);
        levels.set(level, existing);
      }

      // Register local low as support
      if (isLocalLow) {
        const level = parseFloat(current.low.toFixed(5));
        const existing = levels.get(level) || {
          level,
          type: 'SUPPORT',
          strength: 0,
          touches: 0,
          breakoutProbability: 0.5,
        };
        existing.touches++;
        existing.strength = Math.min(existing.touches * 20, 100);
        levels.set(level, existing);
      }
    }

    const srLevels = Array.from(levels.values()).sort(
      (a, b) => b.strength - a.strength
    );

    logger.debug('Local S/R levels found', { count: srLevels.length });

    return srLevels;
  }

  /**
   * Calculate stop loss below support or above resistance
   */
  static calculateStopLoss(
    entryPrice: number,
    supportLevel: number,
    resistanceLevel: number,
    direction: 'BUY' | 'SELL'
  ): number {
    let sl = 0;

    if (direction === 'BUY') {
      // For buy, SL below support
      const buffer = (entryPrice - supportLevel) * 0.1; // 10% below support
      sl = supportLevel - buffer;
    } else {
      // For sell, SL above resistance
      const buffer = (resistanceLevel - entryPrice) * 0.1; // 10% above resistance
      sl = resistanceLevel + buffer;
    }

    return parseFloat(sl.toFixed(5));
  }

  /**
   * Validate entry against S/R levels
   */
  static validateEntryAgainstSR(
    entryPrice: number,
    supportLevel: number,
    resistanceLevel: number,
    direction: 'BUY' | 'SELL'
  ): { valid: boolean; reason: string } {
    if (direction === 'BUY') {
      if (entryPrice < supportLevel) {
        return { valid: false, reason: 'Entry below support level' };
      }
      if (entryPrice > resistanceLevel) {
        return { valid: false, reason: 'Entry above resistance level' };
      }
      return { valid: true, reason: 'Entry within valid range' };
    } else {
      if (entryPrice > resistanceLevel) {
        return { valid: false, reason: 'Entry above resistance level' };
      }
      if (entryPrice < supportLevel) {
        return { valid: false, reason: 'Entry below support level' };
      }
      return { valid: true, reason: 'Entry within valid range' };
    }
  }

  /**
   * Calculate nearest support/resistance levels
   */
  static findNearestLevels(
    currentPrice: number,
    srLevels: SRLevel[],
    range: number = 0.005 // 50 pips
  ): { support: SRLevel | null; resistance: SRLevel | null } {
    const supports = srLevels
      .filter((l) => l.type === 'SUPPORT' && l.level < currentPrice)
      .filter((l) => Math.abs(l.level - currentPrice) <= range)
      .sort((a, b) => b.level - a.level);

    const resistances = srLevels
      .filter((l) => l.type === 'RESISTANCE' && l.level > currentPrice)
      .filter((l) => Math.abs(l.level - currentPrice) <= range)
      .sort((a, b) => a.level - b.level);

    return {
      support: supports[0] || null,
      resistance: resistances[0] || null,
    };
  }
}
