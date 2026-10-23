import { logger } from '../utils/logger';
import { BreakoutSignal } from './londonBreakout';
import { SupportResistanceCalculator, SRLevel } from './supportResistance';
import { PriceActionAnalyzer, PriceActionSignal } from './priceAction';
import { CandleData, PriceData } from '../api/market';
import { Validator } from '../utils/validator';
import { getPairSpec, roundPrice } from '../constants/pairs';
import { config } from '../config';

export interface TradeSignal {
  pair: string;
  signal: 'BUY' | 'SELL' | 'SKIP';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  confidence: number; // 0-1
  reasoning: string;
  /** Open time of the closed candle that produced the signal (one signal per candle) */
  candleTime: string | null;
  meta: {
    rangeHigh: number;
    rangeLow: number;
    atrPips: number;
    spreadPips: number;
    slDistance: number;
  } | null;
  components: {
    breakout: BreakoutSignal;
    priceAction: PriceActionSignal;
    supportResistance: { support: SRLevel | null; resistance: SRLevel | null };
  };
}

export interface SignalInput {
  pair: string;
  quote: PriceData;
  /** 1H candles, oldest first. A forming last bar (closed === false) is ignored. */
  candles: CandleData[];
  atrPips: number;
  /** Range to break. Omit to use the 24 closed candles before the breakout candle. */
  range?: { high: number; low: number };
}

export interface StrategyParams {
  minAtrPips: number;
  maxSpreadPips: number;
  slMinAtr: number;
  slMaxAtr: number;
  rewardRatio: number;
}

export const RANGE_CANDLES = 24;
export const MIN_CLOSED_CANDLES = RANGE_CANDLES + 2;
const SR_SEARCH_RANGE_PIPS = 50;

export function defaultStrategyParams(): StrategyParams {
  return {
    minAtrPips: config.minAtrPips,
    maxSpreadPips: config.maxSpreadPips,
    slMinAtr: config.slMinAtr,
    slMaxAtr: config.slMaxAtr,
    rewardRatio: config.profitRatio,
  };
}

/**
 * London breakout on candle CLOSE:
 *   1. last closed 1H candle closes beyond the range (first close beyond it),
 *   2. price is still beyond the level now,
 *   3. volatility (ATR) and spread filters pass,
 *   4. price action agrees and there is no S/R level directly in the way.
 * Stop goes beyond the nearest S/R (or the range), clamped to [slMinAtr, slMaxAtr] × ATR.
 * Take profit = rewardRatio × stop distance.
 */
export class EntrySignalGenerator {
  static generateTradeSignal(input: SignalInput, params: StrategyParams = defaultStrategyParams()): TradeSignal {
    const { pair, quote, atrPips } = input;
    try {
      Validator.validateTradingPair(pair);
      Validator.validatePrice(quote.bid, 'Current Price');
    } catch (error) {
      logger.warn(`Signal validation failed for ${pair}`, error);
      return this.skipSignal(pair, 'Validation failed');
    }

    const spec = getPairSpec(pair);
    const closed = input.candles.filter((c) => c.closed !== false);
    if (closed.length < MIN_CLOSED_CANDLES) {
      return this.skipSignal(pair, `Not enough candles (${closed.length}/${MIN_CLOSED_CANDLES})`);
    }

    const breakoutCandle = closed[closed.length - 1];
    const prevCandle = closed[closed.length - 2];
    const rangeBars = closed.slice(-(RANGE_CANDLES + 1), -1);
    const rangeHigh = input.range?.high ?? Math.max(...rangeBars.map((c) => c.high));
    const rangeLow = input.range?.low ?? Math.min(...rangeBars.map((c) => c.low));
    const candleTime = breakoutCandle.timestamp.toISOString();

    // Filters
    if (atrPips < params.minAtrPips) {
      return this.skipSignal(pair, `ATR ${atrPips.toFixed(0)} < min ${params.minAtrPips} pips`, candleTime);
    }
    if (quote.spread > params.maxSpreadPips) {
      return this.skipSignal(pair, `Spread ${quote.spread} > max ${params.maxSpreadPips} pips`, candleTime);
    }

    // 1. Candle closed beyond the range (and the previous candle had not)
    const closedAbove = breakoutCandle.close > rangeHigh && prevCandle.close <= rangeHigh;
    const closedBelow = breakoutCandle.close < rangeLow && prevCandle.close >= rangeLow;
    if (!closedAbove && !closedBelow) {
      return this.skipSignal(pair, 'No candle close beyond range', candleTime);
    }
    const direction: 'UP' | 'DOWN' = closedAbove ? 'UP' : 'DOWN';
    const side: 'BUY' | 'SELL' = direction === 'UP' ? 'BUY' : 'SELL';
    const level = direction === 'UP' ? rangeHigh : rangeLow;
    const beyondPips = Math.abs(breakoutCandle.close - level) / spec.pipSize;
    const breakout: BreakoutSignal = {
      detected: true,
      direction,
      breakoutPrice: breakoutCandle.close,
      yesterdayHigh: rangeHigh,
      yesterdayLow: rangeLow,
      strength: parseFloat(Math.min(beyondPips * 2, 100).toFixed(2)),
      confidence: parseFloat(Math.min(beyondPips / 50, 1).toFixed(2)),
    };

    // 2. Price must still be beyond the broken level
    const stillBeyond = direction === 'UP' ? quote.bid > rangeHigh : quote.ask < rangeLow;
    if (!stillBeyond) {
      return this.skipSignal(pair, 'Price fell back inside the range', candleTime);
    }

    // 3. Price action agrees
    const priceAction = PriceActionAnalyzer.generateSignal(closed, atrPips, spec.pipSize);
    if (priceAction.direction !== direction) {
      return this.skipSignal(pair, `Price action ${priceAction.direction} vs breakout ${direction}`, candleTime);
    }

    // 4. Support / resistance
    const entryPrice = side === 'BUY' ? quote.ask : quote.bid;
    const srLevels = SupportResistanceCalculator.findLocalLevels(closed);
    const nearest = SupportResistanceCalculator.findNearestLevels(entryPrice, srLevels, SR_SEARCH_RANGE_PIPS * spec.pipSize);
    const validation = SupportResistanceCalculator.validateEntryAgainstSR(
      entryPrice,
      nearest.support?.level ?? 0,
      nearest.resistance?.level ?? Number.POSITIVE_INFINITY,
      side
    );
    if (!validation.valid) {
      return this.skipSignal(pair, validation.reason, candleTime);
    }

    // Stop: beyond S/R (fallback: other side of the range), clamped by ATR
    const structuralStop = SupportResistanceCalculator.calculateStopLoss(
      entryPrice,
      nearest.support?.level ?? rangeLow,
      nearest.resistance?.level ?? rangeHigh,
      side
    );
    const atrPrice = atrPips * spec.pipSize;
    const minDist = atrPrice * params.slMinAtr;
    const maxDist = atrPrice * params.slMaxAtr;
    let slDistance = Math.abs(entryPrice - structuralStop);
    const wrongSide = side === 'BUY' ? structuralStop >= entryPrice : structuralStop <= entryPrice;
    if (wrongSide || slDistance < minDist) slDistance = minDist;
    if (slDistance > maxDist) slDistance = maxDist;
    if (slDistance <= 0) {
      return this.skipSignal(pair, 'Invalid stop distance', candleTime);
    }

    const stopLoss = side === 'BUY' ? entryPrice - slDistance : entryPrice + slDistance;
    const takeProfit = side === 'BUY' ? entryPrice + slDistance * params.rewardRatio : entryPrice - slDistance * params.rewardRatio;
    const confidence = Math.min((breakout.confidence + priceAction.confidence) / 2, 1);

    const signal: TradeSignal = {
      pair,
      signal: side,
      entryPrice: roundPrice(pair, entryPrice),
      stopLoss: roundPrice(pair, stopLoss),
      takeProfit: roundPrice(pair, takeProfit),
      riskRewardRatio: params.rewardRatio,
      confidence: parseFloat(confidence.toFixed(2)),
      reasoning:
        `${side} ${pair}: 1H close ${breakoutCandle.close} beyond range ${rangeLow}–${rangeHigh}. ` +
        `ATR ${atrPips.toFixed(0)} pips, SL ${(slDistance / spec.pipSize).toFixed(0)} pips, pattern ${priceAction.pattern}. ` +
        `R:R 1:${params.rewardRatio}`,
      candleTime,
      meta: {
        rangeHigh,
        rangeLow,
        atrPips,
        spreadPips: quote.spread,
        slDistance: parseFloat(slDistance.toFixed(spec.digits)),
      },
      components: { breakout, priceAction, supportResistance: nearest },
    };

    logger.info(`🎯 Signal ${side} ${pair}`, {
      entry: signal.entryPrice,
      sl: signal.stopLoss,
      tp: signal.takeProfit,
      candle: candleTime,
    });
    return signal;
  }

  static skipSignal(pair: string, reason: string, candleTime: string | null = null): TradeSignal {
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
      candleTime,
      meta: null,
      components: {
        breakout: { detected: false, direction: null, breakoutPrice: 0, yesterdayHigh: 0, yesterdayLow: 0, strength: 0, confidence: 0 },
        priceAction: { pattern: 'SKIP', direction: 'NEUTRAL', strength: 0, confidence: 0, description: reason },
        supportResistance: { support: null, resistance: null },
      },
    };
  }
}
