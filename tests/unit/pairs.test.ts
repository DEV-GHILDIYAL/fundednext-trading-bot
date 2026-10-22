import { getPairSpec, isTradingPair, PAIR_LIST } from '../../src/constants/pairs';
import { Validator } from '../../src/utils/validator';

describe('Trading pair restrictions', () => {
  it('only allows XAUUSD for new trades', () => {
    expect(PAIR_LIST).toEqual(['XAUUSD']);
    expect(isTradingPair('XAUUSD')).toBe(true);
    expect(isTradingPair('EURUSD')).toBe(false);
    expect(isTradingPair('GBPUSD')).toBe(false);
  });

  it('rejects non-XAUUSD orders in the validator', () => {
    expect(() => Validator.validateTradingPair('XAUUSD')).not.toThrow();
    expect(() => Validator.validateTradingPair('EURUSD')).toThrow();
    expect(() => Validator.validateTradingPair('GBPUSD')).toThrow();
  });

  it('keeps known specs for historical journal entries', () => {
    expect(getPairSpec('EURUSD').pipSize).toBe(0.0001);
    expect(getPairSpec('GBPUSD').pipSize).toBe(0.0001);
    expect(getPairSpec('XAUUSD').pipSize).toBe(0.1);
  });
});
