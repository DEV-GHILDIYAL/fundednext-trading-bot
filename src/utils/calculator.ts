import { logger } from './logger';

export class Calculator {
  /**
   * Calculate position size based on risk amount and stop loss distance
   */
  static calculatePositionSize(
    riskAmount: number,
    entryPrice: number,
    stopLossPrice: number,
    pipValue: number = 0.0001
  ): number {
    const pipDistance = Math.abs((entryPrice - stopLossPrice) / pipValue);
    if (pipDistance <= 0) {
      logger.error('Invalid pip distance:', { entryPrice, stopLossPrice });
      return 0;
    }

    const positionSize = (riskAmount * 10000) / (pipDistance * 1);
    logger.debug('Position size calculated', {
      riskAmount,
      pipDistance,
      positionSize: positionSize.toFixed(2),
    });

    return parseFloat(positionSize.toFixed(2));
  }

  /**
   * Calculate take profit price for 1:2 reward ratio
   */
  static calculateTakeProfit(
    entryPrice: number,
    stopLossPrice: number,
    type: 'BUY' | 'SELL',
    ratio: number = 2
  ): number {
    const riskDistance = Math.abs(entryPrice - stopLossPrice);
    const targetDistance = riskDistance * ratio;

    const tp =
      type === 'BUY'
        ? entryPrice + targetDistance
        : entryPrice - targetDistance;

    logger.debug('Take profit calculated', {
      entryPrice,
      stopLossPrice,
      type,
      ratio,
      tp: tp.toFixed(5),
    });

    return parseFloat(tp.toFixed(5));
  }

  /**
   * Calculate pip distance
   */
  static calculatePips(price1: number, price2: number): number {
    const pips = Math.abs((price1 - price2) / 0.0001);
    return parseFloat(pips.toFixed(1));
  }

  /**
   * Calculate profit/loss
   */
  static calculatePnL(
    entryPrice: number,
    exitPrice: number,
    quantity: number,
    type: 'BUY' | 'SELL'
  ): number {
    const priceDiff =
      type === 'BUY' ? exitPrice - entryPrice : entryPrice - exitPrice;
    const pnl = priceDiff * quantity * 10000;
    return parseFloat(pnl.toFixed(2));
  }

  /**
   * Calculate win rate
   */
  static calculateWinRate(winTrades: number, totalTrades: number): number {
    if (totalTrades === 0) return 0;
    const rate = (winTrades / totalTrades) * 100;
    return parseFloat(rate.toFixed(2));
  }

  /**
   * Calculate risk reward ratio
   */
  static calculateRRRatio(
    riskAmount: number,
    rewardAmount: number
  ): number {
    if (riskAmount <= 0) return 0;
    const ratio = rewardAmount / riskAmount;
    return parseFloat(ratio.toFixed(2));
  }

  /**
   * Calculate spread in pips
   */
  static calculateSpread(bid: number, ask: number): number {
    const spread = (ask - bid) / 0.0001;
    return parseFloat(spread.toFixed(1));
  }
}
