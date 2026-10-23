import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { Calculator } from '../../src/utils/calculator';
import { isWithinTradingSession } from '../../src/utils/time';
import { EntrySignalGenerator } from '../../src/strategies/entrySignalGenerator';
import { CandleData, PriceData, MarketDataSource } from '../../src/api/market';
import { GroqClient, GroqUnavailableError } from '../../src/api/groq';
import { notifier } from '../../src/services/notifier';
import { TradeMonitor, OpenTrade } from '../../src/services/tradeMonitor';
import { TradeExecutor } from '../../src/services/tradeExecutor';
import { Mt5BridgeClient } from '../../src/api/mt5Bridge';

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

async function startServer(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const GOLD_SPEC = { contractSize: 100, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01 };

describe('Calculator.calculateLots (floor to volume step)', () => {
  it('sizes exactly when the stop fits the step', () => {
    expect(Calculator.calculateLots(45, 4000, 3991, GOLD_SPEC)).toEqual({ lots: 0.05, units: 5, risk: 45 });
  });
  it('rounds DOWN so risk never exceeds the limit', () => {
    const r = Calculator.calculateLots(45, 4000, 3993, GOLD_SPEC); // raw 0.0643
    expect(r.lots).toBe(0.06);
    expect(r.risk).toBeLessThanOrEqual(45);
  });
  it('returns 0 lots when even the minimum lot risks too much', () => {
    expect(Calculator.calculateLots(5, 4000, 3990, GOLD_SPEC).lots).toBe(0);
  });
});

describe('London session (Europe/London, DST-aware)', () => {
  it('uses BST before 25 Oct 2026 and GMT after', () => {
    expect(isWithinTradingSession(new Date('2026-10-23T07:30:00Z'))).toBe(true); // 08:30 BST
    expect(isWithinTradingSession(new Date('2026-10-23T10:45:00Z'))).toBe(false); // 11:45 BST
    expect(isWithinTradingSession(new Date('2026-10-27T07:30:00Z'))).toBe(false); // 07:30 GMT
    expect(isWithinTradingSession(new Date('2026-10-27T08:00:00Z'))).toBe(true); // 08:00 GMT = 13:30 IST
    expect(isWithinTradingSession(new Date('2026-10-27T11:29:00Z'))).toBe(true);
    expect(isWithinTradingSession(new Date('2026-10-27T11:30:00Z'))).toBe(false); // 17:00 IST
  });
  it('is closed at weekends', () => {
    expect(isWithinTradingSession(new Date('2026-10-24T09:00:00Z'))).toBe(false);
  });
});

/** 30 closed 1H candles ranging 3990–4010 with a mild uptrend into the last bar */
function rangeCandles(lastClose: number, prevClose: number = 4005): CandleData[] {
  const start = Date.UTC(2026, 9, 26, 0);
  const candles: CandleData[] = [];
  for (let i = 0; i < 28; i++) {
    const open = i % 2 === 0 ? 3995 : 4005;
    const close = i % 2 === 0 ? 4005 : 3995;
    candles.push({ timestamp: new Date(start + i * 3600e3), open, high: 4010, low: 3990, close, closed: true });
  }
  // rising closes for the price-action trend
  candles.push({ timestamp: new Date(start + 28 * 3600e3), open: 3998, high: 4008, low: 3996, close: prevClose, closed: true });
  candles.push({
    timestamp: new Date(start + 29 * 3600e3),
    open: prevClose,
    high: Math.max(lastClose, prevClose) + 2,
    low: prevClose - 3,
    close: lastClose,
    closed: true,
  });
  return candles;
}

const quote = (bid: number, spreadPips = 3): PriceData => ({
  pair: 'XAUUSD',
  bid,
  ask: parseFloat((bid + spreadPips * 0.1).toFixed(2)),
  spread: spreadPips,
  timestamp: new Date(),
});

const params = { minAtrPips: 50, maxSpreadPips: 8, slMinAtr: 0.5, slMaxAtr: 1.5, rewardRatio: 2, rangeBars: 24, usePriceAction: true };

describe('EntrySignalGenerator (candle-close breakout)', () => {
  it('BUYs when a closed candle breaks the range and price holds', () => {
    const candles = rangeCandles(4016);
    const s = EntrySignalGenerator.generateTradeSignal({ pair: 'XAUUSD', quote: quote(4017), candles, atrPips: 200 }, params);
    expect(s.signal).toBe('BUY');
    const dist = s.entryPrice - s.stopLoss;
    expect(dist).toBeGreaterThanOrEqual(10 - 0.01); // 0.5 × ATR($20)
    expect(dist).toBeLessThanOrEqual(30 + 0.01); // 1.5 × ATR
    expect(s.takeProfit - s.entryPrice).toBeCloseTo(dist * 2, 1);
    expect(s.candleTime).toBe(candles[candles.length - 1].timestamp.toISOString());
  });

  it('ignores a forming candle (no close yet)', () => {
    const candles = rangeCandles(4005);
    candles.push({ timestamp: new Date(), open: 4005, high: 4030, low: 4004, close: 4025, closed: false });
    const s = EntrySignalGenerator.generateTradeSignal({ pair: 'XAUUSD', quote: quote(4025), candles, atrPips: 200 }, params);
    expect(s.signal).toBe('SKIP');
    expect(s.reasoning).toMatch(/No candle close beyond range/);
  });

  it('skips when price fell back inside the range', () => {
    const s = EntrySignalGenerator.generateTradeSignal(
      { pair: 'XAUUSD', quote: quote(4008), candles: rangeCandles(4016), atrPips: 200 },
      params
    );
    expect(s.reasoning).toMatch(/fell back/);
  });

  it('applies ATR and spread filters', () => {
    const c = rangeCandles(4016);
    expect(EntrySignalGenerator.generateTradeSignal({ pair: 'XAUUSD', quote: quote(4017), candles: c, atrPips: 30 }, params).reasoning).toMatch(/ATR/);
    expect(EntrySignalGenerator.generateTradeSignal({ pair: 'XAUUSD', quote: quote(4017, 12), candles: c, atrPips: 200 }, params).reasoning).toMatch(/Spread/);
  });
});

describe('GroqClient two-key failover', () => {
  const ok = { choices: [{ message: { content: '{"decision":"BUY","reasoning":"ok","confidence":0.8,"riskAssessment":"low"}' } }] };

  it('switches to key #2 on 429 and alerts', async () => {
    const srv = await startServer((req, _b, res) => {
      if (req.headers.authorization === 'Bearer gsk_one') json(res, 429, { error: { message: 'rate limit' } });
      else json(res, 200, ok);
    });
    try {
      const client = new GroqClient(['gsk_one', 'gsk_two'], 'test-model', 1, 1, srv.url);
      const before = notifier.sent.length;
      const d = await client.analyzeTradeOpportunity('x');
      expect(d.decision).toBe('BUY');
      expect(d.keyIndex).toBe(2);
      expect(client.getStatus().activeKey).toBe(2);
      expect(notifier.sent.slice(before).some((n) => /Switched to key #2/.test(n.text))).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('retries a transient 500 on the same key', async () => {
    let calls = 0;
    const srv = await startServer((_r, _b, res) => (++calls === 1 ? json(res, 500, {}) : json(res, 200, ok)));
    try {
      const d = await new GroqClient(['gsk_one'], 'test-model', 2, 1, srv.url).analyzeTradeOpportunity('x');
      expect(d.keyIndex).toBe(1);
      expect(calls).toBe(2);
    } finally {
      await srv.close();
    }
  });

  it('throws GroqUnavailableError when every key fails', async () => {
    const srv = await startServer((_r, _b, res) => json(res, 429, {}));
    try {
      await expect(new GroqClient(['gsk_a', 'gsk_b'], 'm', 1, 1, srv.url).analyzeTradeOpportunity('x')).rejects.toBeInstanceOf(
        GroqUnavailableError
      );
    } finally {
      await srv.close();
    }
  });

  it('is unconfigured without real keys', () => {
    expect(new GroqClient(['', 'your_groq_api_key_here']).isConfigured()).toBe(false);
  });
});

describe('TradeMonitor persistence', () => {
  it('restores open trades after a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-'));
    const trade: OpenTrade = {
      tradeId: 'PAPER_1', pair: 'XAUUSD', type: 'BUY', entryPrice: 4000, currentPrice: 4000, quantity: 5,
      stopLoss: 3991, takeProfit: 4018, pnl: 0, pnlPercent: 0, openedAt: new Date('2026-10-26T08:00:00Z'),
    };
    new TradeMonitor(dir).registerTrade(trade);
    const restored = new TradeMonitor(dir).restore();
    expect(restored).toHaveLength(1);
    expect(restored[0].openedAt).toBeInstanceOf(Date);
    expect(restored[0].takeProfit).toBe(4018);
  });
});

describe('TradeExecutor LIVE via bridge', () => {
  const signal = {
    pair: 'XAUUSD', signal: 'BUY' as const, entryPrice: 4000.3, stopLoss: 3991.3, takeProfit: 4018.3, riskRewardRatio: 2,
    confidence: 0.8, reasoning: '', candleTime: null, meta: null,
    components: {
      breakout: { detected: true, direction: 'UP' as const, breakoutPrice: 4000, yesterdayHigh: 3999, yesterdayLow: 3980, strength: 10, confidence: 0.5 },
      priceAction: { pattern: 'X', direction: 'UP' as const, strength: 50, confidence: 0.5, description: '' },
      supportResistance: { support: null, resistance: null },
    },
  };
  const market = (simulated: boolean): MarketDataSource =>
    ({
      isSimulated: simulated,
      name: simulated ? 'SIMULATED' : 'MT5',
      getSymbolSpec: async () => ({ ...GOLD_SPEC, digits: 2 }),
    }) as unknown as MarketDataSource;

  it('places a real order with floored lots and SL/TP', async () => {
    let sent: Record<string, unknown> = {};
    const srv = await startServer((req, body, res) => {
      expect(req.headers.authorization).toBe('Bearer tok');
      sent = JSON.parse(body);
      json(res, 200, { retcode: 10009, comment: 'Done', order: 777, deal: 778, volume: 0.05, price: 4000.4, ticket: 777 });
    });
    try {
      const ex = new TradeExecutor(false, market(false), new Mt5BridgeClient(srv.url, 'tok', 2000));
      const r = await ex.executeTrade(signal);
      expect(r.success).toBe(true);
      expect(r.tradeId).toBe('MT5_777');
      expect(sent).toMatchObject({ symbol: 'XAUUSD', side: 'BUY', volume: 0.05, sl: 3991.3, tp: 4018.3 });
    } finally {
      await srv.close();
    }
  });

  it('refuses live orders on the simulated feed', async () => {
    const r = await new TradeExecutor(false, market(true)).executeTrade(signal);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/DATA_SOURCE=mt5/);
  });
});

describe('Strategy params', () => {
  it('converts the 24h range to candles per timeframe', () => {
    const { rangeBarsFor } = jest.requireActual('../../src/strategies/entrySignalGenerator');
    expect(rangeBarsFor('H1', 24)).toBe(24);
    expect(rangeBarsFor('M30', 24)).toBe(48);
    expect(rangeBarsFor('M15', 24)).toBe(96);
  });

  it('skips the price-action check when usePriceAction is false', () => {
    // Bearish recent closes → price action DOWN, but the breakout is UP
    const c = rangeCandles(4016);
    for (let i = c.length - 6; i < c.length - 1; i++) c[i].close = 4000 - (i - (c.length - 6));
    c[c.length - 2].close = 3995;
    const withPa = EntrySignalGenerator.generateTradeSignal({ pair: 'XAUUSD', quote: quote(4017), candles: c, atrPips: 200 }, params);
    const noPa = EntrySignalGenerator.generateTradeSignal(
      { pair: 'XAUUSD', quote: quote(4017), candles: c, atrPips: 200 },
      { ...params, usePriceAction: false }
    );
    expect(withPa.signal).toBe('SKIP');
    expect(noPa.signal).toBe('BUY');
  });
});

describe('Indicators', () => {
  const { ema, rsi } = jest.requireActual('../../src/strategies/indicators');
  it('EMA seeds with the SMA and follows the formula', () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e[1]).toBeNaN();
    expect(e[2]).toBeCloseTo(2);
    expect(e[3]).toBeCloseTo(3); // 4*0.5 + 2*0.5
    expect(e[4]).toBeCloseTo(4);
  });
  it('RSI is 100 on a straight rise and 0 on a straight fall', () => {
    expect(rsi(Array.from({ length: 20 }, (_, i) => i), 14)[19]).toBe(100);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 20 - i), 14)[19]).toBeCloseTo(0);
  });
});

describe('Strategy library: trendPullback', () => {
  const { computeIndicators } = jest.requireActual('../../src/strategies/indicators');
  const { evaluateStrategy, isSignal } = jest.requireActual('../../src/strategies/library');

  it('buys a pullback to EMA20 in an uptrend and clamps the stop by ATR', () => {
    const candles: CandleData[] = [];
    const t0 = Date.UTC(2026, 0, 1);
    let p = 3000;
    for (let i = 0; i < 260; i++) {
      p += 1.5; // steady uptrend
      candles.push({ timestamp: new Date(t0 + i * 3600e3), open: p - 1, high: p + 3, low: p - 4, close: p, closed: true });
    }
    const ind0 = computeIndicators(candles);
    const i = candles.length - 1;
    // last candle dips to EMA20 and closes back above it (bullish)
    const e20 = ind0.ema20[i - 1];
    candles[i] = { ...candles[i], open: e20 + 1, low: e20 - 1, high: e20 + 8, close: e20 + 6 };
    const ind = computeIndicators(candles);
    const q = { pair: 'XAUUSD', bid: candles[i].close, ask: candles[i].close + 0.3, spread: 3, timestamp: new Date() };
    const r = evaluateStrategy('trendPullback', {
      pair: 'XAUUSD', candles, i, ind, quote: q, tfMinutes: 60, rewardRatio: 2, slMinAtr: 0.5, slMaxAtr: 1.5,
      minAtrPips: 10, maxSpreadPips: 8, breakout: { ...params }, toUtc: (d: Date) => d,
    });
    expect(isSignal(r)).toBe(true);
    if (isSignal(r)) {
      expect(r.side).toBe('BUY');
      const dist = r.entryPrice - r.stopLoss;
      const a = ind.atr14[i];
      expect(dist).toBeGreaterThanOrEqual(a * 0.5 - 0.01);
      expect(dist).toBeLessThanOrEqual(a * 1.5 + 0.01);
      expect(r.takeProfit - r.entryPrice).toBeCloseTo(dist * 2, 1);
    }
  });
});

describe('Strategy library: educator strategies', () => {
  const { computeIndicators } = jest.requireActual('../../src/strategies/indicators');
  const { evaluateStrategy, isSignal, STRATEGY_NAMES } = jest.requireActual('../../src/strategies/library');
  const ctxFor = (candles: CandleData[], extra: Record<string, unknown> = {}) => {
    const i = candles.length - 1;
    const q = { pair: 'XAUUSD', bid: candles[i].close, ask: candles[i].close + 0.3, spread: 3, timestamp: new Date() };
    return {
      pair: 'XAUUSD', candles, i, ind: computeIndicators(candles), quote: q, tfMinutes: 60, rewardRatio: 2,
      slMinAtr: 0.5, slMaxAtr: 2, minAtrPips: 10, maxSpreadPips: 8, breakout: { ...params }, toUtc: (d: Date) => d, ...extra,
    };
  };
  const flat = (n: number, start = Date.UTC(2026, 0, 5)): CandleData[] =>
    Array.from({ length: n }, (_, k) => {
      const base = 4000 + Math.sin(k / 3) * 5;
      return { timestamp: new Date(start + k * 3600e3), open: base, high: base + 4, low: base - 4, close: base + 1, closed: true };
    });

  it('exposes all 17 strategies', () => {
    expect(STRATEGY_NAMES).toHaveLength(17);
  });

  it('turtle20 buys the first close above the 20-bar high with a 2×ATR stop', () => {
    const c = flat(240);
    const last = c[c.length - 1];
    c[c.length - 1] = { ...last, open: 4004, high: 4030, close: 4028 };
    const ctx = ctxFor(c);
    const r = evaluateStrategy('turtle20', ctx);
    expect(isSignal(r)).toBe(true);
    if (isSignal(r)) {
      expect(r.side).toBe('BUY');
      expect(r.entryPrice - r.stopLoss).toBeCloseTo(Math.min(2 * ctx.ind.atr14[ctx.i], 2 * ctx.ind.atr14[ctx.i]) + 0.3, 0);
    }
  });

  it('volBreakout triggers once per day beyond open + 0.5 × yesterday range', () => {
    const c = flat(240); // hourly → 10 days
    const i = c.length - 1;
    const day = c[i].timestamp.toISOString().slice(0, 10);
    let first = i;
    while (serverDayOf(c[first - 1]) === day) first--;
    // make every earlier bar of today stay near the open
    for (let j = first; j < i; j++) c[j] = { ...c[j], close: c[first].open };
    c[i] = { ...c[i], high: c[first].open + 20, close: c[first].open + 15 };
    const r = evaluateStrategy('volBreakout', ctxFor(c));
    expect(isSignal(r) && r.side).toBe('BUY');
    // a second breakout the same day is ignored
    c[i - 1] = { ...c[i - 1], close: c[first].open + 12 };
    expect(isSignal(evaluateStrategy('volBreakout', ctxFor(c)))).toBe(false);
  });

  it('ICT Silver Bullet only trades inside its NY windows', () => {
    const c = flat(240);
    const r = evaluateStrategy('ictSilverBullet', ctxFor(c, { toUtc: () => new Date('2026-01-14T18:00:00Z') })); // 13:00 NY
    expect(isSignal(r)).toBe(false);
    if (!isSignal(r)) expect(r.skip).toMatch(/Outside/);
  });

  function serverDayOf(x: CandleData): string {
    return x.timestamp.toISOString().slice(0, 10);
  }
});

describe('Supertrend EA', () => {
  const { supertrend, adx } = jest.requireActual('../../src/strategies/indicators');
  const mk = (closes: number[]): CandleData[] =>
    closes.map((c, k) => ({ timestamp: new Date(Date.UTC(2026, 0, 5, 10) + k * 900e3), open: c - 0.5, high: c + 1, low: c - 1, close: c, closed: true }));

  it('Supertrend is up in a rising market and flips down after a crash', () => {
    const up = Array.from({ length: 60 }, (_, k) => 4000 + k * 2);
    const st = supertrend(mk(up), 10, 3);
    expect(st.dir[59]).toBe(1);
    expect(st.line[59]).toBeLessThan(up[59]);
    const crash = [...up, ...Array.from({ length: 10 }, (_, k) => up[59] - 20 - k * 5)];
    expect(supertrend(mk(crash), 10, 3).dir[69]).toBe(-1);
  });

  it('ADX is high and +DI leads in a steady uptrend', () => {
    const a = adx(mk(Array.from({ length: 80 }, (_, k) => 4000 + k * 2)), 14);
    expect(a.adx[79]).toBeGreaterThan(22);
    expect(a.pdi[79]).toBeGreaterThan(a.mdi[79]);
  });
});

describe('XAUUSD EMA Breakout EA (emaRangeBreakout)', () => {
  const { computeIndicators } = jest.requireActual('../../src/strategies/indicators');
  const { evaluateStrategy, isSignal } = jest.requireActual('../../src/strategies/library');
  // 5-minute bars on a server-time Monday, last bar closes at 10:00 server (inside 8–12)
  const bars = (lastClose: number, hourOfLastOpen = 9, minuteOfLastOpen = 55): CandleData[] => {
    const end = Date.UTC(2026, 0, 5, hourOfLastOpen, minuteOfLastOpen);
    return Array.from({ length: 40 }, (_, k) => {
      const t = new Date(end - (39 - k) * 300e3);
      const last = k === 39;
      const o = 4000;
      return { timestamp: t, open: o, high: last ? Math.max(o, lastClose) + 0.5 : 4003, low: last ? Math.min(o, lastClose) - 0.5 : 3997, close: last ? lastClose : 4001, closed: true };
    });
  };
  const run = (c: CandleData[], htfDir: number | undefined) => {
    const i = c.length - 1;
    return evaluateStrategy('emaRangeBreakout', {
      pair: 'XAUUSD', candles: c, i, ind: computeIndicators(c),
      quote: { pair: 'XAUUSD', bid: c[i].close, ask: c[i].close + 0.3, spread: 3, timestamp: new Date() },
      tfMinutes: 5, rewardRatio: 2, slMinAtr: 0.5, slMaxAtr: 2, minAtrPips: 10, maxSpreadPips: 8,
      breakout: { ...params }, toUtc: (d: Date) => d, htfDir,
    });
  };

  it('buys a close above the 10-bar high when the HTF is above EMA200, SL below range − 0.5 ATR, TP 2R', () => {
    const c = bars(4006);
    const r = run(c, 1);
    expect(isSignal(r)).toBe(true);
    if (isSignal(r)) {
      expect(r.side).toBe('BUY');
      expect(r.stopLoss).toBeLessThan(3997);
      expect(r.takeProfit - r.entryPrice).toBeCloseTo(2 * (r.entryPrice - r.stopLoss), 1);
    }
  });

  it('ignores breakouts against the HTF trend and outside server sessions', () => {
    expect(isSignal(run(bars(4006), -1))).toBe(false);
    expect(isSignal(run(bars(4006, 12, 30), 1))).toBe(false); // 12:35 server → between sessions
  });
});
