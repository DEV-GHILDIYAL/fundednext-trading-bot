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
