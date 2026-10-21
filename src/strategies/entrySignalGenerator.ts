import { logger } from '../utils/logger';
import { LondonBreakoutDetector, BreakoutSignal } from './londonBreakout';
import { SupportResistanceCalculator, SRLevel } from './supportResistance';
import { PriceActionAnalyzer, PriceActionSignal } from './priceAction';
import { CandleData, PriceData } from '../api/market';
import { Validator } from '../utils/validator';
import { getPairSpec, roundPrice } from '../constants/pairs';

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

const SR_SEARCH_RANGE_PIPS = 50;
const REWARD_RATIO = 2;

export class EntrySignalGenerator {
  /**
   * Generate complete trade signal combining breakout + price action + S/R
   */
  static generateTradeSignal(
    pair: string,
    currentPrice: PriceData,
    yesterdayHigh: number,
    yesterdayLow: number,
    candles: CandleData[],
    atrPips: number
  ): TradeSignal {
    try {
      Validator.validateTradingPair(pair);
      Validator.validatePrice(currentPrice.bid, 'Current Price');
      Validator.validatePrice(yesterdayHigh, 'Yesterday High');
      Validator.validatePrice(yesterdayLow, 'Yesterday Low');
    } catch (error) {
      logger.warn(`Signal validation failed for ${pair}`, error);
      return this.skipSignal(pair, 'Validation failed');
    }

    const spec = getPairSpec(pair);
    const bid = currentPrice.bid;

    // 1. Breakout of previous range
    const breakout = LondonBreakoutDetector.detectBreakout(
      bid,
      yesterdayHigh,
      yesterdayLow,
      bid > yesterdayHigh,
      bid < yesterdayLow,
      spec.pipSize
    );

    if (!breakout.detected || breakout.direction === null) {
      return this.skipSignal(pair, 'No breakout detected');
    }

    // 2. Price action must agree with breakout direction
    const priceAction = PriceActionAnalyzer.generateSignal(candles, atrPips);
    if (priceAction.direction !== breakout.direction) {
      return this.skipSignal(pair, 'Price action not aligned with breakout');
    }

    // 3. Support / resistance around current price
    const srLevels = SupportResistanceCalculator.findLocalLevels(candles);
    const nearest = SupportResistanceCalculator.findNearestLevels(
      bid,
      srLevels,
      SR_SEARCH_RANGE_PIPS * spec.pipSize
    );

    const side: 'BUY' | 'SELL' = breakout.direction === 'UP' ? 'BUY' : 'SELL';
    const entryPrice = side === 'BUY' ? currentPrice.ask : currentPrice.bid;

    // Do not buy straight into resistance / sell into support.
    // Missing levels mean "no obstacle nearby".
    const validation = SupportResistanceCalculator.validateEntryAgainstSR(
      entryPrice,
      nearest.support?.level ?? 0,
      nearest.resistance?.level ?? Number.POSITIVE_INFINITY,
      side
    );
    if (!validation.valid) {
      return this.skipSignal(pair, validation.reason);
    }

    // Stop beyond nearest S/R, falling back to the broken range's opposite side
    const stopLoss = SupportResistanceCalculator.calculateStopLoss(
      entryPrice,
      nearest.support?.level ?? yesterdayLow,
      nearest.resistance?.level ?? yesterdayHigh,
      side
    );

    const riskDistance = Math.abs(entryPrice - stopLoss);
    if (riskDistance <= 0) {
      return this.skipSignal(pair, 'Invalid stop distance');
    }

    const takeProfit =
      side === 'BUY' ? entryPrice + riskDistance * REWARD_RATIO : entryPrice - riskDistance * REWARD_RATIO;
    const confidence = Math.min((breakout.confidence + 0.1) * 0.9, 1);

    const signal: TradeSignal = {
      pair,
      signal: side,
      entryPrice: roundPrice(pair, entryPrice),
      stopLoss: roundPrice(pair, stopLoss),
      takeProfit: roundPrice(pair, takeProfit),
      riskRewardRatio: REWARD_RATIO,
      confidence: parseFloat(confidence.toFixed(2)),
      reasoning:
        `${side} breakout on ${pair}. Strength ${breakout.strength}/100. ` +
        `Pattern ${priceAction.pattern}. R:R 1:${REWARD_RATIO}`,
      components: {
        breakout,
        priceAction,
        supportResistance: nearest,
      },
    };

    logger.info(`🎯 Signal ${side} ${pair}`, {
      entry: signal.entryPrice,
      sl: signal.stopLoss,
      tp: signal.takeProfit,
      confidence: signal.confidence,
    });

    return signal;
  }

  private static skipSignal(pair: string, reason: string): TradeSignal {
    logger.debug(`Skip ${pair}: ${reason}`);
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
        supportResistance: { support: null, resistance: null },
      },
    };
  }
}
