export class Calculator {
  /**
   * Position size in UNITS (not lots) so that hitting the stop loses exactly `riskAmount`.
   * Valid for USD-quoted symbols (EURUSD, GBPUSD, XAUUSD): P&L(USD) = priceDiff * units.
   */
  static calculatePositionSize(riskAmount: number, entryPrice: number, stopLossPrice: number): number {
    const stopDistance = Math.abs(entryPrice - stopLossPrice);
    if (stopDistance <= 0 || !Number.isFinite(stopDistance)) return 0;
    return parseFloat((riskAmount / stopDistance).toFixed(4));
  }

  /** Convert units to lots for a given contract size (100000 for FX, 100 for gold) */
  static unitsToLots(units: number, contractSize: number): number {
    return parseFloat((units / contractSize).toFixed(2));
  }

  static calculateTakeProfit(
    entryPrice: number,
    stopLossPrice: number,
    type: 'BUY' | 'SELL',
    ratio: number = 2
  ): number {
    const targetDistance = Math.abs(entryPrice - stopLossPrice) * ratio;
    const tp = type === 'BUY' ? entryPrice + targetDistance : entryPrice - targetDistance;
    return parseFloat(tp.toFixed(5));
  }

  static calculatePips(price1: number, price2: number, pipSize: number = 0.0001): number {
    return parseFloat(Math.abs((price1 - price2) / pipSize).toFixed(1));
  }

  /** P&L in USD for a position of `units` */
  static calculatePnL(entryPrice: number, exitPrice: number, units: number, type: 'BUY' | 'SELL'): number {
    const priceDiff = type === 'BUY' ? exitPrice - entryPrice : entryPrice - exitPrice;
    return parseFloat((priceDiff * units).toFixed(2));
  }

  static calculateWinRate(winTrades: number, totalTrades: number): number {
    if (totalTrades === 0) return 0;
    return parseFloat(((winTrades / totalTrades) * 100).toFixed(2));
  }

  static calculateRRRatio(riskAmount: number, rewardAmount: number): number {
    if (riskAmount <= 0) return 0;
    return parseFloat((rewardAmount / riskAmount).toFixed(2));
  }

  static calculateSpread(bid: number, ask: number, pipSize: number = 0.0001): number {
    return parseFloat(((ask - bid) / pipSize).toFixed(1));
  }
}
