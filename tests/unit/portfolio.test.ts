import { parseSleeves } from '../../src/config';
import { CandleData } from '../../src/api/market';
import { computeIndicators } from '../../src/strategies/indicators';
import { evaluateStrategy, isSignal, dailyAtr, LibContext, StrategyName } from '../../src/strategies/library';
import { builtInEvents, newsBlackout, nyTimeToUtc, isFomcDay, NewsCalendar, NewsIndex } from '../../src/strategies/news';
import { monteCarloPass } from '../../src/utils/monteCarlo';
import { defaultStrategyParams } from '../../src/strategies/entrySignalGenerator';

const FALLBACK = { strategy: 'breakout' as const, timeframe: 'H1' as const, rewardRatio: 2, sessionStart: 480, sessionEnd: 690 };

describe('parseSleeves (STRATEGIES)', () => {
  it('parses the portfolio with default sessions per strategy', () => {
    const s = parseSleeves('asianBreakout:M30:2, volBreakout:M30:2, nyOpenBreakout:M15:1.5, insideDayBreakout:H1:2', FALLBACK);
    expect(s.map((x) => x.id)).toEqual(['asianBreakout:M30', 'volBreakout:M30', 'nyOpenBreakout:M15', 'insideDayBreakout:H1']);
    expect(s[0]).toMatchObject({ sessionStart: 8 * 60, sessionEnd: 11 * 60 + 30, rewardRatio: 2 });
    expect(s[1]).toMatchObject({ sessionStart: 60, sessionEnd: 21 * 60 });
    expect(s[2]).toMatchObject({ sessionStart: 0, sessionEnd: 24 * 60, rewardRatio: 1.5 });
  });
  it('accepts an explicit session and skips invalid items', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = parseSleeves('asianBreakout:M30:2:07:30-10:00, bogus:M5:2, volBreakout:X1:2', FALLBACK);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ sessionStart: 450, sessionEnd: 600 });
    warn.mockRestore();
  });
  it('falls back to STRATEGY/ENTRY_TIMEFRAME when empty', () => {
    expect(parseSleeves('', FALLBACK)).toEqual([{ ...FALLBACK, id: 'breakout:H1' }]);
  });
});

describe('news blackout', () => {
  it('converts New York time with DST', () => {
    expect(nyTimeToUtc('2026-07-03', 8, 30).toISOString()).toBe('2026-07-03T12:30:00.000Z'); // EDT
    expect(nyTimeToUtc('2026-12-04', 8, 30).toISOString()).toBe('2026-12-04T13:30:00.000Z'); // EST
  });
  it('schedules NFP on the first Friday and FOMC days', () => {
    const ev = builtInEvents(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-31T00:00:00Z'));
    expect(ev.some((e) => e.title === 'Non-Farm Payrolls' && e.at.toISOString() === '2026-10-02T12:30:00.000Z')).toBe(true);
    expect(ev.some((e) => e.title === 'FOMC statement' && e.at.toISOString() === '2026-10-28T18:00:00.000Z')).toBe(true);
    expect(isFomcDay('2026-10-28')).toBe(true);
  });
  it('blocks 15 min before to 30 min after (60 after FOMC)', () => {
    const ev = [{ at: new Date('2026-10-02T12:30:00Z'), title: 'Non-Farm Payrolls' }, { at: new Date('2026-10-28T18:00:00Z'), title: 'FOMC statement' }];
    expect(newsBlackout(new Date('2026-10-02T12:14:00Z'), ev)).toBeNull();
    expect(newsBlackout(new Date('2026-10-02T12:16:00Z'), ev)).toMatch(/Non-Farm/);
    expect(newsBlackout(new Date('2026-10-02T13:00:00Z'), ev)).toMatch(/Non-Farm/);
    expect(newsBlackout(new Date('2026-10-02T13:01:00Z'), ev)).toBeNull();
    expect(newsBlackout(new Date('2026-10-28T18:55:00Z'), ev)).toMatch(/FOMC/);
    expect(new NewsIndex(ev).check(new Date('2026-10-28T18:55:00Z'))).toMatch(/FOMC/);
  });
  it('merges the live feed (USD high impact) and survives a feed outage', async () => {
    const cal = new NewsCalendar('x', async () => [
      { title: 'CPI m/m', country: 'USD', impact: 'High', date: '2026-10-14T08:30:00-04:00' },
      { title: 'German ZEW', country: 'EUR', impact: 'High', date: '2026-10-14T05:00:00-04:00' },
    ]);
    expect(await cal.check(new Date('2026-10-14T12:40:00Z'))).toMatch(/CPI/);
    expect(await cal.check(new Date('2026-10-14T09:00:00Z'))).toBeNull();
    const down = new NewsCalendar('x', async () => {
      throw new Error('offline');
    });
    expect(await down.check(new Date('2026-10-02T12:35:00Z'))).toMatch(/Non-Farm/); // built-in still applies
    expect(down.status.error).toBe('offline');
  });
});

// ─── strategy fixtures ───
function bar(t: number, o: number, h: number, l: number, c: number): CandleData {
  return { timestamp: new Date(t), open: o, high: h, low: l, close: c, volume: 1, closed: true };
}

/** Daily candles: 45 days of range 20 ending the day before `todayUtc` */
function dailySeries(todayUtc: number, last?: Partial<CandleData>): CandleData[] {
  const out: CandleData[] = [];
  for (let k = 45; k >= 1; k--) {
    const t = todayUtc - k * 86400000;
    out.push(bar(t, 3000, 3010, 2990, 3000 + (k % 2 ? 2 : -2)));
  }
  if (last) Object.assign(out[out.length - 1], last);
  return out;
}

function ctxFor(candles: CandleData[], tfMinutes: number, daily: CandleData[], extra: Partial<LibContext> = {}): LibContext {
  const i = candles.length - 1;
  const next = candles[i].close;
  return {
    pair: 'XAUUSD',
    candles,
    i,
    ind: computeIndicators(candles),
    quote: { pair: 'XAUUSD', bid: next, ask: next + 0.3, spread: 3, timestamp: new Date() },
    tfMinutes,
    rewardRatio: 2,
    slMinAtr: 0.5,
    slMaxAtr: 2,
    minAtrPips: 0,
    maxSpreadPips: 8,
    breakout: defaultStrategyParams(),
    toUtc: (d) => d, // fixture bars are UTC
    daily: { candles: daily, idx: daily.length - 1 },
    ...extra,
  };
}

describe('nyOpenBreakout', () => {
  const day = Date.UTC(2026, 9, 22); // Thu 22 Oct 2026, EDT → 08:30 NY = 12:30 UTC
  function series(breakClose: number): CandleData[] {
    const c: CandleData[] = [];
    const start = day - 3 * 86400000;
    for (let t = start; t < day + 12.5 * 3600000; t += 15 * 60000) {
      const w = Math.sin(t / 3.6e6) * 2;
      c.push(bar(t, 3000 + w, 3002 + w, 2998 + w, 3000 - w));
    }
    // opening range 12:30–13:30 UTC: 2995–3005
    for (let k = 0; k < 4; k++) c.push(bar(day + 12.5 * 3600000 + k * 900000, 3000, 3005, 2995, 3001));
    c.push(bar(day + 13.5 * 3600000, 3001, 3004, 2998, 3002)); // inside
    c.push(bar(day + 13.75 * 3600000, 3002, breakClose + 1, 3001, breakClose)); // closes 14:00 UTC = 10:00 NY
    return c;
  }
  it('buys the first close above the range + 5%, stop at the other side (capped by D1 ATR)', () => {
    const r = evaluateStrategy('nyOpenBreakout', ctxFor(series(3008), 15, dailySeries(day)));
    expect(isSignal(r)).toBe(true);
    if (!isSignal(r)) return;
    expect(r.side).toBe('BUY');
    expect(r.stopLoss).toBeCloseTo(3008.3 - 12, 1); // other side 2995 is 13.3 away → capped at 0.6 × D1 ATR (20) = 12
    expect(r.takeProfit - r.entryPrice).toBeCloseTo(2 * (r.entryPrice - r.stopLoss), 1);
  });
  it('ignores a close inside the 5% buffer', () => {
    expect(isSignal(evaluateStrategy('nyOpenBreakout', ctxFor(series(3005.3), 15, dailySeries(day))))).toBe(false);
  });
  it('skips when the range is too wide vs D1 ATR (filters on) but trades with filters off', () => {
    const tinyDaily = dailySeries(day).map((d) => ({ ...d, high: d.open + 2, low: d.open - 2, close: d.open })); // D1 ATR ≈ 4
    const on = evaluateStrategy('nyOpenBreakout', ctxFor(series(3008), 15, tinyDaily));
    expect(isSignal(on)).toBe(false);
    expect(isSignal(on) ? '' : on.skip).toMatch(/NY range/);
    expect(isSignal(evaluateStrategy('nyOpenBreakout', ctxFor(series(3008), 15, tinyDaily, { useFilters: false })))).toBe(true);
  });
  it('respects a news blackout', () => {
    const r = evaluateStrategy('nyOpenBreakout', ctxFor(series(3008), 15, dailySeries(day), { newsBlock: 'News blackout: CPI' }));
    expect(isSignal(r) ? '' : r.skip).toMatch(/CPI/);
  });
});

describe('insideDayBreakout', () => {
  const today = Date.UTC(2026, 9, 22);
  function h1(closeLast: number): CandleData[] {
    const c: CandleData[] = [];
    for (let t = today - 12 * 86400000; t < today + 10 * 3600000; t += 3600000) {
      const w = Math.sin(t / 7.2e6) * 2;
      c.push(bar(t, 3000 + w, 3003 + w, 2997 + w, 3000 - w));
    }
    c.push(bar(today + 10 * 3600000, 3003, closeLast + 1, 3002, closeLast));
    return c;
  }
  // yesterday: inside day 2996–3006, close 3005 (above SMA5 ≈ 3000)
  const daily = dailySeries(today, { open: 2999, high: 3006, low: 2996, close: 3005 });
  it('buys a close above yesterday high + 0.1 ATR when yesterday was an inside day', () => {
    const atr14 = dailyAtr({ candles: daily, idx: daily.length - 1 }, 14);
    const r = evaluateStrategy('insideDayBreakout', ctxFor(h1(3006 + 0.1 * atr14 + 0.5), 60, daily));
    expect(isSignal(r)).toBe(true);
    if (!isSignal(r)) return;
    expect(r.side).toBe('BUY');
    expect(r.entryPrice - r.stopLoss).toBeCloseTo(atr14, 1);
  });
  it('does nothing when yesterday was a normal day', () => {
    const normal = dailySeries(today);
    const r = evaluateStrategy('insideDayBreakout', ctxFor(h1(3020), 60, normal));
    expect(isSignal(r) ? '' : r.skip).toMatch(/not an inside day/);
  });
});

describe('asianBreakout range filter', () => {
  it('skips an Asian range wider than 0.8 × D1 ATR', () => {
    const day = Date.UTC(2026, 9, 22); // London BST → 07:00 London = 06:00 UTC
    const c: CandleData[] = [];
    for (let t = day - 6 * 86400000; t < day; t += 1800000) {
      const w = Math.sin(t / 3.6e6) * 2;
      c.push(bar(t, 3000 + w, 3002 + w, 2998 + w, 3000 - w));
    }
    for (let t = day; t < day + 6 * 3600000; t += 1800000) c.push(bar(t, 3000, 3015, 2985, 3000)); // range 30 (> 0.8 × 20)
    c.push(bar(day + 6 * 3600000, 3000, 3014, 2999, 3012));
    c.push(bar(day + 6.5 * 3600000, 3012, 3020, 3011, 3018)); // closes above 3015
    const r = evaluateStrategy('asianBreakout' as StrategyName, ctxFor(c, 30, dailySeries(day)));
    expect(isSignal(r) ? '' : r.skip).toMatch(/Asian range .* > 0.8/);
    expect(isSignal(evaluateStrategy('asianBreakout', ctxFor(c, 30, dailySeries(day), { useFilters: false })))).toBe(true);
  });
});

describe('monteCarloPass', () => {
  it('always passes with only winners and never with only losers', () => {
    expect(monteCarloPass([2, 2, 2], 10.7, 13.3, 500).pass).toBe(1);
    expect(monteCarloPass([-1, -1], 10.7, 13.3, 500).pass).toBe(0);
  });
  it('gives better odds to a positive edge than to no edge', () => {
    const edge = monteCarloPass([2, -1, -1, 2, -1, 2, -1, -1, 2, -1], 10.7, 13.3, 4000).pass; // +0.2R/trade
    const none = monteCarloPass([2, -1, -1, -1, 2, -1, -1, 2, -1, -1, 2, -1], 10.7, 13.3, 4000).pass; // 0R
    expect(edge).toBeGreaterThan(none);
  });
});
