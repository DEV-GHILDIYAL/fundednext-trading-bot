import { ValidationError } from './errors';
import { PAIR_LIST, isTradingPair } from '../constants/pairs';

export class Validator {
  static validateApiKeys(apiKey: string, fieldName: string): void {
    if (!apiKey || apiKey.trim() === '' || apiKey.includes('your_')) {
      throw new ValidationError(
        `${fieldName} is not configured. Please add it to .env file.`,
        fieldName
      );
    }
  }

  static validatePrice(price: number, fieldName: string = 'Price'): void {
    if (price <= 0 || !isFinite(price)) {
      throw new ValidationError(`${fieldName} must be a positive number`, fieldName);
    }
  }

  static validateQuantity(quantity: number, fieldName: string = 'Quantity'): void {
    if (!(quantity > 0) || !Number.isFinite(quantity)) {
      throw new ValidationError(
        `${fieldName} must be greater than 0`,
        fieldName
      );
    }
  }

  static validateRiskAmount(
    riskAmount: number,
    accountBalance: number,
    maxRiskPercent: number = 1
  ): void {
    const maxRisk = accountBalance * (maxRiskPercent / 100);
    if (riskAmount > maxRisk) {
      throw new ValidationError(
        `Risk amount ($${riskAmount}) exceeds maximum allowed ($${maxRisk.toFixed(2)})`
      );
    }
  }

  static validateTradingPair(pair: string): void {
    if (!isTradingPair(pair)) {
      throw new ValidationError(
        `${pair} is not a supported trading pair. Valid pairs: ${PAIR_LIST.join(', ')}`
      );
    }
  }

  static validateStopLoss(
    entryPrice: number,
    stopLossPrice: number,
    type: 'BUY' | 'SELL'
  ): void {
    const isValidBuy = type === 'BUY' && stopLossPrice < entryPrice;
    const isValidSell = type === 'SELL' && stopLossPrice > entryPrice;

    if (!isValidBuy && !isValidSell) {
      throw new ValidationError(
        `Invalid stop loss. For ${type}, SL must be ${type === 'BUY' ? 'below' : 'above'} entry price`
      );
    }
  }

  static validateTakeProfit(
    entryPrice: number,
    takeProfitPrice: number,
    type: 'BUY' | 'SELL'
  ): void {
    const isValidBuy = type === 'BUY' && takeProfitPrice > entryPrice;
    const isValidSell = type === 'SELL' && takeProfitPrice < entryPrice;

    if (!isValidBuy && !isValidSell) {
      throw new ValidationError(
        `Invalid take profit. For ${type}, TP must be ${type === 'BUY' ? 'above' : 'below'} entry price`
      );
    }
  }

  static validateRRRatio(ratio: number, expected: number = 2, tolerance: number = 0.02): void {
    if (!Number.isFinite(ratio) || Math.abs(ratio - expected) > tolerance) {
      throw new ValidationError(
        `Risk-Reward ratio must be 1:${expected} (got 1:${Number.isFinite(ratio) ? ratio.toFixed(2) : 'invalid'})`
      );
    }
  }

  /**
   * Reward/risk sanity check for strategies whose TP is not exactly ratio × SL
   * (e.g. fibSweep measures risk with a 1-point buffer, so the real ratio is ~1.6–1.9 at "1:2").
   */
  static validateRRRange(ratio: number, min: number, max: number): void {
    if (!Number.isFinite(ratio) || ratio < min || ratio > max) {
      throw new ValidationError(
        `Risk-Reward ratio 1:${Number.isFinite(ratio) ? ratio.toFixed(2) : 'invalid'} outside the allowed 1:${min}–1:${max}`
      );
    }
  }

  static validateTime(hour: number, minute: number): void {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new ValidationError(`Invalid time: ${hour}:${minute}`);
    }
  }
}
