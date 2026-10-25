import { CandleData } from '../../src/api/market';
import { computeIndicators } from '../../src/strategies/indicators';
import { evaluateStrategy, isSignal, LibContext, LibResult } from '../../src/strategies/library';
import { defaultStrategyParams } from '../../src/strategies/entrySignalGenerator';
import { majorNewsDays, builtInEvents } from '../../src/strategies/news';

// 8 Oct 2026 (Thu). IST = UTC + 5:30 → IST hh:mm candle opens at UTC hh:mm − 5:30
const DAY = Date.UTC(2026, 9, 8);
const istMs = (h: number, m: number) => DAY + (h * 60 + m - 330) * 60000;
const bar = (h: number, m: number, o: number, hi: number, lo: number, c: number): CandleData => ({
  timestamp: new Date(istMs(h, m)), open: o, high: hi, low: lo, close: c, volume: 1, closed: true,
});

/** 00:00 → 19:45 IST: range 11:30–12:30 with body high 4125.415 / low 4115.265, quiet inside candles otherwise */
function baseDay(): CandleData[] {
  const c: CandleData[] = [];
  for (let m = 0; m < 19 * 60 + 50; m += 5) {
    const h = Math.floor(m / 60), mm = m % 60;
    if (m >= 11 * 60 + 30 && m <= 12 * 60 + 30) {
      const k = (m - (11 * 60 + 30)) / 5;
      if (k === 0) c.push(bar(h, mm, 4115.265, 4116.5, 4114.0, 4118.0)); // body low
      else if (k === 6) c.push(bar(h, mm, 4120.0, 4127.0, 4119.5, 4125.415)); // body high
      else c.push(bar(h, mm, 4119.0, 4122.0, 4117.0, 4120.5));
    } else c.push(bar(h, mm, 4120.0, 4123.0, 4118.0, 4121.0));
  }
  return c;
}

/** The PDF example candles (19:50 → 20:05) */
const EXAMPLE = [
  bar(19, 50, 4130.465, 4136.39, 4129.755, 4133.4), // wick beyond, close inside — not a sweep yet
  bar(19, 55, 4133.405, 4137.42, 4133.03, 4137.175), // close beyond — leg starts
  bar(20, 0, 4136.985, 4140.48, 4134.235, 4140.14), // close beyond, leg high 4140.48
  bar(20, 5, 4140.185, 4140.26, 4130.535, 4130.885), // wick beyond + close inside — ENTRY
];

function ctx(candles: CandleData[], extra: Partial<LibContext> = {}): LibContext {
  const last = candles[candles.length - 1].close;
  return {
    pair: 'XAUUSD',
    candles,
    i: candles.length - 1,
    ind: computeIndicators(candles),
    quote: { pair: 'XAUUSD', bid: last, ask: last + 0.3, spread: 3, timestamp: new Date() },
    tfMinutes: 5,
    rewardRatio: 2,
    slMinAtr: 0.5,
    slMaxAtr: 2,
    minAtrPips: 0,
    maxSpreadPips: 8,
    breakout: defaultStrategyParams(),
    toUtc: (d) => d,
    ...extra,
  };
}
const why = (r: LibResult) => (isSignal(r) ? `${r.side} signal` : r.skip);

describe('fibSweep (PDF example, 8 Oct 2026)', () => {
  it('reproduces the SHORT at 20:05 with SL 4142.48 and TP 4109.695', () => {
    const r = evaluateStrategy('fibSweep', ctx([...baseDay(), ...EXAMPLE]));
    expect(isSignal(r)).toBe(true);
    if (!isSignal(r)) return;
    expect(r.side).toBe('SELL');
    expect(r.entryPrice).toBeCloseTo(4130.885, 1); // MT5 gold has 2 decimals
    expect(r.stopLoss).toBeCloseTo(4142.48, 1);
    expect(r.takeProfit).toBeCloseTo(4109.695, 1);
    expect(r.reason).toMatch(/2=4135\.56 \/ −1=4105\.12/);
  });

  it('ignores a wick beyond the line when no candle has closed beyond it (19:50)', () => {
    expect(why(evaluateStrategy('fibSweep', ctx([...baseDay(), EXAMPLE[0]])))).toMatch(/No sweep yet/);
  });

  it('does not enter while the sweep leg is still closing beyond the line', () => {
    expect(why(evaluateStrategy('fibSweep', ctx([...baseDay(), ...EXAMPLE.slice(0, 3)])))).toMatch(/2: sweep leg running/);
  });

  it('first trade TP → no more trades today', () => {
    const c = [...baseDay(), ...EXAMPLE, bar(20, 10, 4130, 4131, 4109.0, 4110)]; // TP hit
    // a fresh LONG sweep of the −1 line afterwards
    c.push(bar(20, 15, 4110, 4111, 4106, 4108), bar(20, 20, 4108, 4108.5, 4100, 4101), bar(20, 25, 4101, 4107, 4099, 4106));
    expect(why(evaluateStrategy('fibSweep', ctx(c)))).toMatch(/First trade hit TP/);
  });

  it('first trade SL → takes a second setup', () => {
    const c = [...baseDay(), ...EXAMPLE, bar(20, 10, 4131, 4143, 4130, 4141)]; // SL 4142.48 hit
    c.push(bar(20, 15, 4141, 4141.5, 4133, 4134)); // back inside → armed
    c.push(bar(20, 20, 4134, 4139, 4133.5, 4138)); // close beyond → leg
    c.push(bar(20, 25, 4138, 4138.5, 4131, 4132)); // wick beyond + close inside → entry #2
    const r = evaluateStrategy('fibSweep', ctx(c));
    expect(isSignal(r) && r.side).toBe('SELL');
    expect(isSignal(r) ? r.reason : '').toMatch(/trade 2\/2/);
  });

  it('nothing before 14:30 IST or after 21:00 IST', () => {
    const early = baseDay().filter((b) => b.timestamp.getTime() < istMs(14, 25));
    expect(why(evaluateStrategy('fibSweep', ctx(early)))).toMatch(/14:30/);
    const late = [...baseDay(), ...EXAMPLE];
    for (let m = 20 * 60 + 10; m <= 21 * 60; m += 5) late.push(bar(Math.floor(m / 60), m % 60, 4121, 4123, 4119, 4121));
    expect(why(evaluateStrategy('fibSweep', ctx(late)))).toMatch(/21:00/);
  });

  it('skips NFP / CPI / PPI / FOMC days', () => {
    expect(why(evaluateStrategy('fibSweep', ctx([...baseDay(), ...EXAMPLE], { newsDay: 'Major US news day (CPI)' })))).toMatch(/CPI/);
    const days = majorNewsDays(builtInEvents(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-31T00:00:00Z')));
    expect(days.get('2026-10-02')).toMatch(/Payrolls/); // NFP 18:00 IST
    expect(days.get('2026-10-14')).toBe('CPI');
    expect(days.get('2026-10-15')).toBe('PPI');
    expect(days.get('2026-10-28')).toMatch(/FOMC/); // 14:00 ET = 23:30 IST, same date
  });
});
