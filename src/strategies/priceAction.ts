import { logger } from '../utils/logger';
import { CandleData } from '../api/market';

export interface PriceActionSignal {
  pattern: string;
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  strength: number; // 0-100
  confidence: number; // 0-1
  description: string;
}

export class PriceActionAnalyzer {
  /**
   * Analyze trend direction (1H timeframe)
   */
  static analyzeTrend(candles: CandleData[], period: number = 5): 'UP' | 'DOWN' | 'RANGING' {
    if (candles.length < period) return 'RANGING';

    const recentCandles = candles.slice(-period);
    let upCount = 0;
    let downCount = 0;

    for (let i = 1; i < recentCandles.length; i++) {
      if (recentCandles[i].close > recentCandles[i - 1].close) {
        upCount++;
      } else if (recentCandles[i].close < recentCandles[i - 1].close) {
        downCount++;
      }
    }

    const trend = upCount > downCount ? 'UP' : downCount > upCount ? 'DOWN' : 'RANGING';

    logger.debug('Trend analyzed', { trend, upCount, downCount });

    return trend;
  }

  /**
   * Check for pin bar pattern (rejection candle)
   */
  static detectPinBar(candle: CandleData): boolean {
    const bodySize = Math.abs(candle.close - candle.open);
    const totalSize = candle.high - candle.low;

    if (totalSize === 0) return false;

    const bodyPercent = (bodySize / totalSize) * 100;
    const wickPercent = ((totalSize - bodySize) / totalSize) * 100;

    // Pin bar: small body (< 30%) and long wick (> 60%)
    const isPinBar = bodyPercent < 30 && wickPercent > 60;

    logger.debug('Pin bar detection', {
      isPinBar,
      bodyPercent: bodyPercent.toFixed(1),
      wickPercent: wickPercent.toFixed(1),
    });

    return isPinBar;
  }

  /**
   * Check for engulfing pattern
   */
  static detectEngulfing(
    previousCandle: CandleData,
    currentCandle: CandleData
  ): 'BULLISH' | 'BEARISH' | null {
    const prevBody = Math.abs(previousCandle.close - previousCandle.open);
    const currBody = Math.abs(currentCandle.close - currentCandle.open);

    // Bullish engulfing: current close > prev open AND current open < prev close
    if (
      currentCandle.close > previousCandle.open &&
      currentCandle.open < previousCandle.close &&
      currBody > prevBody
    ) {
      logger.debug('Bullish engulfing detected');
      return 'BULLISH';
    }

    // Bearish engulfing: current close < prev open AND current open > prev close
    if (
      currentCandle.close < previousCandle.open &&
      currentCandle.open > previousCandle.close &&
      currBody > prevBody
    ) {
      logger.debug('Bearish engulfing detected');
      return 'BEARISH';
    }

    return null;
  }

  /**
   * Check for inside bar pattern
   */
  static detectInsideBar(
    previousCandle: CandleData,
    currentCandle: CandleData
  ): boolean {
    const isInside =
      currentCandle.high < previousCandle.high &&
      currentCandle.low > previousCandle.low;

    logger.debug('Inside bar detection', { isInside });

    return isInside;
  }

  /**
   * Calculate momentum (price velocity)
   */
  static calculateMomentum(candles: CandleData[], period: number = 5): number {
    if (candles.length < period + 1) return 0;

    const currentClose = candles[candles.length - 1].close;
    const previousClose = candles[candles.length - period - 1].close;

    const momentum = currentClose - previousClose;
    const momentumPips = momentum / 0.0001;

    logger.debug('Momentum calculated', { momentumPips: momentumPips.toFixed(1) });

    return parseFloat(momentumPips.toFixed(2));
  }

  /**
   * Analyze market volatility using range
   */
  static analyzeVolatility(candles: CandleData[], period: number = 10): number {
    if (candles.length < period) return 0;

    const ranges = candles
      .slice(-period)
      .map((c) => (c.high - c.low) / 0.0001); // in pips

    const averageRange = ranges.reduce((a, b) => a + b, 0) / period;

    logger.debug('Volatility analyzed', { averageRange: averageRange.toFixed(1) });

    return parseFloat(averageRange.toFixed(2));
  }

  /**
   * Generate composite price action signal
   */
  static generateSignal(candles: CandleData[], atrPips: number): PriceActionSignal {
    const trend = this.analyzeTrend(candles);
    const lastCandle = candles[candles.length - 1];
    const previousCandle = candles[candles.length - 2];

    const isPinBar = this.detectPinBar(lastCandle);
    const engulfing = this.detectEngulfing(previousCandle, lastCandle);
    const isInsideBar = this.detectInsideBar(previousCandle, lastCandle);
    const momentum = this.calculateMomentum(candles);
    const volatility = this.analyzeVolatility(candles);

    let signal: PriceActionSignal;

    if (engulfing === 'BULLISH' && trend === 'UP') {
      signal = {
        pattern: 'BULLISH_ENGULFING_UPTREND',
        direction: 'UP',
        strength: 75,
        confidence: 0.8,
        description: 'Strong bullish continuation pattern in uptrend',
      };
    } else if (engulfing === 'BEARISH' && trend === 'DOWN') {
      signal = {
        pattern: 'BEARISH_ENGULFING_DOWNTREND',
        direction: 'DOWN',
        strength: 75,
        confidence: 0.8,
        description: 'Strong bearish continuation pattern in downtrend',
      };
    } else if (isPinBar && trend === 'UP') {
      signal = {
        pattern: 'PIN_BAR_UPTREND',
        direction: 'UP',
        strength: 60,
        confidence: 0.7,
        description: 'Pin bar rejection in uptrend',
      };
    } else if (isPinBar && trend === 'DOWN') {
      signal = {
        pattern: 'PIN_BAR_DOWNTREND',
        direction: 'DOWN',
        strength: 60,
        confidence: 0.7,
        description: 'Pin bar rejection in downtrend',
      };
    } else if (isInsideBar && volatility < atrPips * 0.5) {
      signal = {
        pattern: 'INSIDE_BAR_CONTRACTION',
        direction: trend === 'UP' ? 'UP' : 'DOWN',
        strength: 50,
        confidence: 0.6,
        description: 'Inside bar with potential breakout',
      };
    } else {
      signal = {
        pattern: trend === 'RANGING' ? 'RANGING' : 'CONTINUATION',
        direction: trend === 'RANGING' ? 'NEUTRAL' : trend,
        strength: 40,
        confidence: 0.5,
        description: `Market in ${trend} ${trend === 'RANGING' ? 'range' : 'trend'}`,
      };
    }

    logger.info('Price action signal generated', {
      pattern: signal.pattern,
      direction: signal.direction,
      strength: signal.strength,
    });

    return signal;
  }
}
