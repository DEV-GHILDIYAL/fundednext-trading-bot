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

  /**
   * Lot size for a fixed $ risk, rounded DOWN to the broker's volume step so the
   * real risk never exceeds `riskAmount`. Returns lots = 0 when even the minimum
   * lot would risk more than allowed.
   */
  static calculateLots(
    riskAmount: number,
    entryPrice: number,
    stopLossPrice: number,
    spec: { contractSize: number; volumeMin: number; volumeMax: number; volumeStep: number }
  ): { lots: number; units: number; risk: number } {
    const stopDistance = Math.abs(entryPrice - stopLossPrice);
    if (stopDistance <= 0 || !Number.isFinite(stopDistance) || spec.volumeStep <= 0) return { lots: 0, units: 0, risk: 0 };
    const rawLots = riskAmount / stopDistance / spec.contractSize;
    const steps = Math.floor(rawLots / spec.volumeStep + 1e-9);
    const stepDecimals = Math.max(0, Math.ceil(-Math.log10(spec.volumeStep) - 1e-9));
    let lots = parseFloat((steps * spec.volumeStep).toFixed(stepDecimals));
    if (lots < spec.volumeMin) return { lots: 0, units: 0, risk: 0 };
    lots = Math.min(lots, spec.volumeMax);
    const units = lots * spec.contractSize;
    return { lots, units: parseFloat(units.toFixed(4)), risk: parseFloat((units * stopDistance).toFixed(2)) };
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
