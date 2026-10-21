import { logger } from '../utils/logger';
import { LondonBreakoutDetector, BreakoutSignal } from './londonBreakout';
import { SupportResistanceCalculator, SRLevel } from './supportResistance';
import { PriceActionAnalyzer, PriceActionSignal } from './priceAction';
import { CandleData, PriceData } from '../api/market';
import { Validator } from '../utils/validator';

export interface TradeSignal {
  pair: string;
  signal: 'BUY' | 'SELL' | 'SKIP';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  confidence: number; // 0-1
  reasoning: string;
  components: {
    breakout: BreakoutSignal;
    priceAction: PriceActionSignal;
    supportResistance: { support: SRLevel | null; resistance: SRLevel | null };
  };
}

export class EntrySignalGenerator {
  /**
   * Generate complete trade signal combining all strategy components
   */
  static generateTradeSignal(
    pair: string,
    currentPrice: PriceData,
    yesterdayHigh: number,
    yesterdayLow: number,
    candles: CandleData[],
    atrPips: number
  ): TradeSignal {
    logger.info(`🔍 Generating trade signal for ${pair}`);

    try {
      Validator.validatePrice(currentPrice.bid, 'Current Price');
      Validator.validateTradingPair(pair);
    } catch (error) {
      logger.error('Signal generation validation failed:', error);
      return this.skipSignal(pair, 'Validation failed');
    }

    // Component 1: Breakout Detection
    const breakoutSignal = LondonBreakoutDetector.detectBreakout(
      currentPrice.bid,
      yesterdayHigh,
      yesterdayLow,
      currentPrice.bid > yesterdayHigh,
      currentPrice.bid < yesterdayLow
    );

    // Component 2: Price Action Analysis
    const priceActionSignal = PriceActionAnalyzer.generateSignal(candles, atrPips);

    // Component 3: Support & Resistance
    const srLevels = SupportResistanceCalculator.findLocalLevels(candles);
    const nearestLevels = SupportResistanceCalculator.findNearestLevels(
      currentPrice.bid,
      srLevels
    );

    // Component 4: Combine all signals
    const signal = this.combineSignals(
      pair,
      currentPrice.bid,
      breakoutSignal,
      priceActionSignal,
      nearestLevels,
      yesterdayHigh,
      yesterdayLow
    );

    if (signal.signal !== 'SKIP') {
      // Validate trade setup
      const validation = SupportResistanceCalculator.validateEntryAgainstSR(
        signal.entryPrice,
        nearestLevels.support?.level || yesterdayLow,
        nearestLevels.resistance?.level || yesterdayHigh,
        signal.signal
      );

      if (!validation.valid) {
        logger.warn(`Invalid entry setup: ${validation.reason}`);
        return this.skipSignal(pair, validation.reason);
      }
    }

    signal.components = {
      breakout: breakoutSignal,
      priceAction: priceActionSignal,
      supportResistance: nearestLevels,
    };

    logger.info(`✅ Signal generated: ${signal.signal}`, {
      confidence: signal.confidence,
      rrRatio: signal.riskRewardRatio,
    });

    return signal;
  }

  /**
   * Combine all signal components into one decision
   */
  private static combineSignals(
    pair: string,
    currentPrice: number,
    breakout: BreakoutSignal,
    priceAction: PriceActionSignal,
    srLevels: { support: SRLevel | null; resistance: SRLevel | null },
    yesterdayHigh: number,
    yesterdayLow: number
  ): TradeSignal {
    // Base decision on breakout + price action alignment
    const breakoutConfirmed = breakout.detected && breakout.direction !== null;
    const priceActionAligned =
      (breakout.direction === 'UP' && priceAction.direction === 'UP') ||
      (breakout.direction === 'DOWN' && priceAction.direction === 'DOWN');

    if (!breakoutConfirmed) {
      return this.skipSignal(pair, 'No breakout detected');
    }

    if (!priceActionAligned) {
      return this.skipSignal(pair, 'Price action not aligned with breakout');
    }

    // Generate entry, SL, TP
    const direction = breakout.direction! as 'UP' | 'DOWN';
    const entryPrice = direction === 'UP' ? currentPrice : currentPrice;

    const supportLevel = srLevels.support?.level || yesterdayLow;
    const resistanceLevel = srLevels.resistance?.level || yesterdayHigh;

    const stopLoss = SupportResistanceCalculator.calculateStopLoss(
      entryPrice,
      supportLevel,
      resistanceLevel,
      direction === 'UP' ? 'BUY' : 'SELL'
    );

    // Calculate TP for 1:2 ratio
    const riskDistance = Math.abs(entryPrice - stopLoss);
    const targetDistance = riskDistance * 2;
    const takeProfit =
      direction === 'UP'
        ? entryPrice + targetDistance
        : entryPrice - targetDistance;

    const rrRatio = targetDistance / riskDistance;
    const confidence = Math.min(
      (breakout.confidence + (priceActionAligned ? 0.1 : 0)) * 0.9,
      1
    );

    const reasoning =
      `${direction === 'UP' ? 'Buy' : 'Sell'} breakout on ${pair}. ` +
      `Breakout strength: ${breakout.strength}/100. ` +
      `Pattern: ${priceAction.pattern}. ` +
      `R:R Ratio: 1:${rrRatio.toFixed(2)}`;

    return {
      pair,
      signal: direction === 'UP' ? 'BUY' : 'SELL',
      entryPrice: parseFloat(entryPrice.toFixed(5)),
      stopLoss: parseFloat(stopLoss.toFixed(5)),
      takeProfit: parseFloat(takeProfit.toFixed(5)),
      riskRewardRatio: parseFloat(rrRatio.toFixed(2)),
      confidence: parseFloat(confidence.toFixed(2)),
      reasoning,
      components: {
        breakout,
        priceAction,
        supportResistance: srLevels,
      },
    };
  }

  /**
   * Generate skip signal
   */
  private static skipSignal(pair: string, reason: string): TradeSignal {
    return {
      pair,
      signal: 'SKIP',
      entryPrice: 0,
      stopLoss: 0,
      takeProfit: 0,
      riskRewardRatio: 0,
      confidence: 0,
      reasoning: `Skipped: ${reason}`,
      components: {
        breakout: {
          detected: false,
          direction: null,
          breakoutPrice: 0,
          yesterdayHigh: 0,
          yesterdayLow: 0,
          strength: 0,
          confidence: 0,
        },
        priceAction: {
          pattern: 'SKIP',
          direction: 'NEUTRAL',
          strength: 0,
          confidence: 0,
          description: reason,
        },
        supportResistance: {
          support: null,
          resistance: null,
        },
      },
    };
  }
}
