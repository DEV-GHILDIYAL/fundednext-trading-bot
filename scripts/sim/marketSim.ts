/**
 * Market simulator: runs the REAL bot (strategy, Groq gate, risk, executor, position sync, journal, alerts)
 * against a fake MT5 broker and a fake clock — a whole trading day in seconds.
 *
 *   npm run sim                 # every scenario (each in its own process), summary table
 *   npm run sim -- S4           # one scenario, with its trade list and alerts
 *
 * The fake broker builds M5 candles (history + the scenario day: 11:30–12:30 IST range, sweeps, trends,
 * noise), serves ticks / candles / account / positions like the bridge, fills market orders, closes positions
 * at SL/TP from the intrabar price path, and can inject outages and order rejections. Groq is stubbed per
 * scenario (approve / reject / down). Nothing touches the network or a real account.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ───────────────────────────── fake clock (installed before the bot is loaded) ─────────────────────────────
const RealDate = Date;
let NOW = RealDate.UTC(2026, 9, 29, 7, 0);
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW);
    else super(...(args as [number]));
  }
  static now(): number {
    return NOW;
  }
}
const MIN = 60000;
const IST = 330 * MIN;
const istAt = (day: string, hhmm: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return RealDate.UTC(y, m - 1, d, h, mi) - IST;
};
const istLabel = (utc: number): string => new RealDate(utc + IST).toISOString().slice(11, 16);
const istDay = (utc: number): string => new RealDate(utc + IST).toISOString().slice(0, 10);

/** NY-close broker clock: UTC+3 while New York is on DST, else UTC+2 (same rule as src/utils/time.ts) */
function brokerOffset(utc: number): number {
  const y = new RealDate(utc).getUTCFullYear();
  const nthSunday = (month: number, n: number) => {
    const first = new RealDate(RealDate.UTC(y, month, 1)).getUTCDay();
    return RealDate.UTC(y, month, 1 + ((7 - first) % 7) + (n - 1) * 7, 7); // 02:00 ET ≈ 06:00–07:00 UTC
  };
  const dst = utc >= nthSunday(2, 2) && utc < nthSunday(10, 1);
  return (dst ? 3 : 2) * 3600000;
}
const serverIso = (utc: number): string => new RealDate(utc + brokerOffset(utc)).toISOString();

// ───────────────────────────── market builder ─────────────────────────────
interface Bar {
  t: number; // UTC open
  o: number;
  h: number;
  l: number;
  c: number;
  path: 'HL' | 'LH'; // which extreme is reached first inside the bar
}
const M5 = 5 * MIN;
const L = 4000; // range body low
const H = 4010; // range body high
const R = H - L;
const U = L + 2 * R; // Fib 2  → SHORT line (4020)
const D = L - R; // Fib −1 → LONG line (3990)

class Market {
  bars: Bar[] = [];
  t = 0;
  price = 4005;
  private seed: number;
  constructor(seed: number) {
    this.seed = seed;
  }
  rnd(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  gauss(): number {
    return Math.sqrt(-2 * Math.log(this.rnd() + 1e-12)) * Math.cos(2 * Math.PI * this.rnd());
  }
  private weekend(t: number): boolean {
    const d = new RealDate(t + brokerOffset(t)).getUTCDay();
    return d === 0 || d === 6;
  }
  bar(o: number, h: number, l: number, c: number, path?: 'HL' | 'LH'): this {
    while (this.weekend(this.t)) this.t += M5;
    const r = (v: number) => Math.round(v * 100) / 100;
    this.bars.push({ t: this.t, o: r(o), h: r(Math.max(h, o, c)), l: r(Math.min(l, o, c)), c: r(c), path: path ?? (c >= o ? 'LH' : 'HL') });
    this.t += M5;
    this.price = c;
    return this;
  }
  /** Linear move to `target` until `untilUtc` with noise (σ per bar) — small wicks */
  drift(target: number, untilUtc: number, noise = 0.25): this {
    const n = Math.max(1, Math.round((untilUtc - this.t) / M5));
    const start = this.price;
    for (let k = 1; k <= n; k++) {
      const o = this.price;
      const c = start + ((target - start) * k) / n + (k < n ? noise * this.gauss() : 0);
      this.bar(o, Math.max(o, c) + Math.abs(this.gauss()) * 0.3, Math.min(o, c) - Math.abs(this.gauss()) * 0.3, c);
    }
    return this;
  }
  history(fromUtc: number, toUtc: number, vol = 1.1): this {
    this.t = fromUtc;
    while (this.t < toUtc) {
      if (this.weekend(this.t)) {
        this.t += M5;
        continue;
      }
      const o = this.price;
      const c = o + vol * this.gauss() + (4005 - o) * 0.002;
      this.bar(o, Math.max(o, c) + Math.abs(this.gauss()) * 0.6, Math.min(o, c) - Math.abs(this.gauss()) * 0.6, c);
    }
    return this;
  }
  /** 11:30–12:30 IST: 13 candles whose BODIES span exactly L..H */
  range(day: string): this {
    this.drift(4003, istAt(day, '11:30'), 0.2);
    const closes = [4000, 4004, 4006, 4003, 4007, 4005, 4010, 4006, 4004, 4007, 4003, 4006, 4005];
    for (const c of closes) {
      const o = this.price;
      this.bar(o, Math.max(o, c) + 0.6, Math.min(o, c) - 0.6, c);
    }
    return this;
  }
  /** Close beyond Fib 2, one more close beyond, then wick beyond + close back inside → SHORT signal */
  sweepShort(atUtc: number): this {
    this.drift(U - 3, atUtc, 0.15);
    this.bar(U - 3, U + 2.5, U - 3.2, U + 1.5);
    this.bar(U + 1.5, U + 4, U + 0.8, U + 3);
    this.bar(U + 3, U + 3.5, U - 2.6, U - 2, 'HL');
    return this;
  }
  sweepLong(atUtc: number): this {
    this.drift(D + 3, atUtc, 0.15);
    this.bar(D + 3, D + 3.2, D - 2.5, D - 1.5, 'HL');
    this.bar(D - 1.5, D - 0.8, D - 4, D - 3, 'HL');
    this.bar(D - 3, D + 2.6, D - 3.5, D + 2, 'LH');
    return this;
  }
  /** Price along the intrabar path at time `at` (bar open → first extreme → second extreme → close) */
  priceAt(at: number): number {
    const b = this.barAt(at);
    if (!b) return this.price;
    const p = Math.min(1, Math.max(0, (at - b.t) / M5));
    const [e1, e2] = b.path === 'HL' ? [b.h, b.l] : [b.l, b.h];
    const pts = [b.o, e1, e2, b.c];
    const seg = Math.min(2, Math.floor(p * 3));
    const f = p * 3 - seg;
    return pts[seg] + (pts[seg + 1] - pts[seg]) * f;
  }
  barAt(at: number): Bar | undefined {
    let lo = 0;
    let hi = this.bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = this.bars[mid];
      if (at < b.t) hi = mid - 1;
      else if (at >= b.t + M5) lo = mid + 1;
      else return b;
    }
    return undefined;
  }
  /** Candles up to now: closed bars + the forming one (partial high/low), aggregated for H1 / D1 */
  candles(tf: string, count: number, start = 0): { time: string; open: number; high: number; low: number; close: number; volume: number; closed: boolean }[] {
    const now = NOW;
    const upto: Bar[] = [];
    for (const b of this.bars) {
      if (b.t > now) break;
      if (b.t + M5 <= now) upto.push(b);
      else {
        // forming bar: path so far
        const steps = 12;
        let h = b.o;
        let l = b.o;
        for (let k = 0; k <= steps; k++) {
          const at = b.t + ((now - b.t) * k) / steps;
          const p = this.priceAt(at);
          h = Math.max(h, p);
          l = Math.min(l, p);
        }
        upto.push({ ...b, h, l, c: this.priceAt(now) });
      }
    }
    const sizes: Record<string, number> = { M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };
    const size = (sizes[tf] ?? 60) * MIN;
    const out: { t: number; o: number; h: number; l: number; c: number; closedAt: number }[] = [];
    for (const b of upto) {
      const srv = b.t + brokerOffset(b.t);
      const key = Math.floor(srv / size) * size;
      const last = out[out.length - 1];
      if (last && last.t === key) {
        last.h = Math.max(last.h, b.h);
        last.l = Math.min(last.l, b.l);
        last.c = b.c;
      } else out.push({ t: key, o: b.o, h: b.h, l: b.l, c: b.c, closedAt: key + size });
    }
    const nowSrv = now + brokerOffset(now);
    const sel = out.slice(Math.max(0, out.length - start - count), out.length - start);
    return sel.map((x) => ({
      time: new RealDate(x.t).toISOString(),
      open: x.o,
      high: +x.h.toFixed(2),
      low: +x.l.toFixed(2),
      close: +x.c.toFixed(2),
      volume: 100,
      closed: x.closedAt <= nowSrv,
    }));
  }
}

// ───────────────────────────── scenarios ─────────────────────────────
type GroqMode = 'approve' | 'reject' | 'down';
interface Scenario {
  name: string;
  title: string;
  day: string; // IST trading day
  seed?: number;
  build: (m: Market, day: string) => void;
  groq?: (call: number) => GroqMode;
  spread?: (utc: number) => number;
  outage?: [string, string];
  rejectOrder?: (call: number) => boolean;
  restartAt?: string;
  end?: string;
  /** extra .env values for this scenario */
  env?: Record<string, string>;
  expect: (r: SimResult) => [string, boolean][];
}

interface SimTrade {
  ticket: number;
  side: 'BUY' | 'SELL';
  openIst: string;
  entry: number;
  sl: number;
  tp: number;
  volume: number;
  exit?: number;
  closeIst?: string;
  reason?: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL_OR_BOT';
  profit?: number;
}
interface SimResult {
  name: string;
  trades: SimTrade[];
  journal: { side: string; reason: string; pnl: number }[];
  alerts: string[];
  violations: string[];
  errors: string[];
  groqCalls: number;
  orderCalls: number;
}

const WED = '2026-11-04'; // after US DST ended → server UTC+2
const THU = '2026-10-29'; // US DST → server UTC+3
const CPI = '2026-11-10'; // US CPI release day

const toTp = (m: Market, side: 'BUY' | 'SELL', minutes = 45) =>
  m.drift(side === 'SELL' ? U - 19 : D + 19, m.t + minutes * MIN, 0.2);
const toSl = (m: Market, side: 'BUY' | 'SELL', minutes = 30) =>
  m.drift(side === 'SELL' ? U + 9 : D - 9, m.t + minutes * MIN, 0.2);
const trades = (r: SimResult) => r.trades.length;
const has = (r: SimResult, re: RegExp) => r.alerts.some((a) => re.test(a));

const SCENARIOS: Scenario[] = [
  {
    name: 'S1',
    title: 'SHORT sweep → TP → done for the day (later LONG sweep ignored)',
    day: THU,
    build: (m, d) => {
      m.sweepShort(istAt(d, '15:00'));
      toTp(m, 'SELL');
      m.sweepLong(istAt(d, '19:00'));
      toTp(m, 'BUY');
    },
    expect: (r) => [
      ['exactly 1 trade', trades(r) === 1],
      ['it is a SELL closed at TP', r.trades[0]?.side === 'SELL' && r.trades[0]?.reason === 'TAKE_PROFIT'],
      ['profit ≈ +1.6–1.9R', (r.trades[0]?.profit ?? 0) > 60],
      ['Telegram: opened + TP alerts', has(r, /SELL opened/) && has(r, /Take profit hit/)],
    ],
  },
  {
    name: 'S2',
    title: '(2/day mode) SHORT → SL, then a fresh 2nd SHORT setup → TP',
    day: WED,
    env: { FIB_MAX_TRADES_PER_DAY: '2' },
    build: (m, d) => {
      m.sweepShort(istAt(d, '15:00'));
      toSl(m, 'SELL');
      m.drift(U - 4, m.t + 20 * MIN, 0.15); // back inside (a new setup must start fresh)
      m.sweepShort(istAt(d, '17:00'));
      toTp(m, 'SELL', 50);
    },
    expect: (r) => [
      ['2 trades', trades(r) === 2],
      ['first SL, second TP', r.trades[0]?.reason === 'STOP_LOSS' && r.trades[1]?.reason === 'TAKE_PROFIT'],
      ['day net positive', r.trades.reduce((a, t) => a + (t.profit ?? 0), 0) > 0],
    ],
  },
  {
    name: 'S3',
    title: '(2/day mode) Two stop-losses → third setup ignored',
    day: WED,
    env: { FIB_MAX_TRADES_PER_DAY: '2' },
    build: (m, d) => {
      m.sweepShort(istAt(d, '15:00'));
      toSl(m, 'SELL');
      m.drift(U - 4, m.t + 20 * MIN, 0.15);
      m.sweepShort(istAt(d, '17:00'));
      toSl(m, 'SELL');
      m.drift(U - 4, m.t + 20 * MIN, 0.15);
      m.sweepShort(istAt(d, '19:00')); // would be a 3rd trade
      toTp(m, 'SELL');
    },
    expect: (r) => [
      ['exactly 2 trades', trades(r) === 2],
      ['both SL', r.trades.every((t) => t.reason === 'STOP_LOSS')],
      ['day loss ≤ 2R ($90)', r.trades.reduce((a, t) => a + (t.profit ?? 0), 0) >= -91],
    ],
  },
  {
    name: 'S4',
    title: 'Groq rejects the first setup → later LONG is still traded (26 Oct bug)',
    day: THU,
    groq: (n) => (n === 1 ? 'reject' : 'approve'),
    build: (m, d) => {
      m.sweepShort(istAt(d, '15:00'));
      toTp(m, 'SELL'); // the untraded setup "would have" hit TP
      m.sweepLong(istAt(d, '18:30'));
      toTp(m, 'BUY');
    },
    expect: (r) => [
      ['Telegram "Setup skipped" for the rejected SHORT', has(r, /Setup skipped · SELL/)],
      ['exactly 1 trade: the LONG', trades(r) === 1 && r.trades[0]?.side === 'BUY'],
      ['LONG closed at TP', r.trades[0]?.reason === 'TAKE_PROFIT'],
    ],
  },
  {
    name: 'S5',
    title: 'Groq down (both keys fail) → no trade, alert sent',
    day: THU,
    groq: () => 'down',
    build: (m, d) => {
      m.sweepShort(istAt(d, '15:00'));
      toTp(m, 'SELL');
    },
    expect: (r) => [
      ['no trade (fail-closed)', trades(r) === 0],
      ['Telegram "Groq unavailable" alert', has(r, /Groq unavailable/)],
      ['Groq retried inside the entry window', r.groqCalls >= 2],
    ],
  },
  {
    name: 'S6',
    title: 'Broker rejects the first order → alert; later LONG still traded',
    day: THU,
    rejectOrder: (n) => n === 1,
    build: (m, d) => {
      m.sweepShort(istAt(d, '15:00'));
      toTp(m, 'SELL');
      m.sweepLong(istAt(d, '18:30'));
      toTp(m, 'BUY');
    },
    expect: (r) => [
      ['Telegram "Order … rejected"', has(r, /rejected/i)],
      ['1 trade: the LONG', trades(r) === 1 && r.trades[0]?.side === 'BUY'],
    ],
  },
  {
    name: 'S7',
    title: 'Spread spikes to $1.50 when the signal candle closes → retried, trades when spread normalises',
    day: WED,
    spread: (utc) => (utc >= istAt(WED, '15:15') && utc < istAt(WED, '15:16') ? 1.5 : 0.35),
    build: (m, d) => {
      m.sweepShort(istAt(d, '15:00'));
      toTp(m, 'SELL');
    },
    expect: (r) => [
      ['1 trade, opened after the spike', trades(r) === 1 && r.trades[0]?.openIst >= '15:16'],
      ['closed at TP', r.trades[0]?.reason === 'TAKE_PROFIT'],
    ],
  },
  {
    name: 'S8',
    title: 'US CPI day → no trading at all',
    day: CPI,
    build: (m, d) => {
      m.sweepShort(istAt(d, '15:00'));
      toTp(m, 'SELL');
      m.sweepLong(istAt(d, '19:00'));
      toTp(m, 'BUY');
    },
    expect: (r) => [
      ['no trades', trades(r) === 0],
      ['Telegram "No trading today" at 12:40', has(r, /No trading today/)],
    ],
  },
  {
    name: 'S9',
    title: 'Wick above the line but no close beyond first → not a sweep',
    day: WED,
    build: (m, d) => {
      m.drift(U - 3, istAt(d, '15:00'), 0.15);
      m.bar(U - 3, U + 3, U - 3.5, U - 1, 'HL'); // wick only
      m.drift(U - 12, m.t + 60 * MIN, 0.2);
    },
    expect: (r) => [['no trades', trades(r) === 0]],
  },
  {
    name: 'S10',
    title: 'One spike candle hits SL and TP → SL (high first)',
    day: WED,
    build: (m, d) => {
      m.sweepShort(istAt(d, '15:00'));
      m.bar(U - 2, U - 1.5, U - 2.6, U - 2.2);
      m.bar(U - 2.2, U + 8, U - 20, U - 15, 'HL');
      m.drift(U - 14, m.t + 30 * MIN);
    },
    expect: (r) => [
      ['1 trade', trades(r) === 1],
      ['closed at SL (broker hit the stop first)', r.trades[0]?.reason === 'STOP_LOSS'],
      ['journal agrees with the broker', r.journal[0]?.reason === 'STOP_LOSS'],
    ],
  },
  {
    name: 'S11',
    title: 'MT5 bridge down 10 min while a trade runs; TP hit during the outage',
    day: THU,
    outage: ['15:30', '15:40'],
    build: (m, d) => {
      m.sweepShort(istAt(d, '15:00'));
      m.drift(U - 3, istAt(d, '15:30'), 0.15);
      m.drift(U - 19, istAt(d, '15:38'), 0.1); // TP while the bridge is down
      m.drift(U - 15, m.t + 30 * MIN);
    },
    expect: (r) => [
      ['1 trade closed at TP', trades(r) === 1 && r.trades[0]?.reason === 'TAKE_PROFIT'],
      ['journal recorded the TP after reconnect', r.journal[0]?.reason === 'TAKE_PROFIT'],
      ['Telegram "connection lost" + "restored"', has(r, /connection lost/) && has(r, /connection restored/)],
    ],
  },
  {
    name: 'S12',
    title: 'Entry at 20:55 runs past 21:00 → TP at night; a 21:10 setup is ignored',
    day: WED,
    end: '23:59',
    build: (m, d) => {
      m.sweepShort(istAt(d, '20:40')); // signal candle closes 20:55
      m.drift(U - 1, istAt(d, '21:30'), 0.15);
      m.drift(U - 19, istAt(d, '22:10'), 0.15);
      m.sweepLong(istAt(d, '23:00'));
    },
    expect: (r) => [
      ['1 trade opened before 21:00', trades(r) === 1 && r.trades[0]?.openIst < '21:00'],
      ['closed at TP after 21:00', r.trades[0]?.reason === 'TAKE_PROFIT' && (r.trades[0]?.closeIst ?? '') > '21:00'],
    ],
  },
  {
    name: 'S13',
    title: 'Bot restarts while a trade is open → position adopted, TP recorded once',
    day: THU,
    restartAt: '15:45',
    build: (m, d) => {
      m.sweepShort(istAt(d, '15:00'));
      m.drift(U - 4, istAt(d, '16:00'), 0.15);
      toTp(m, 'SELL', 40);
      m.sweepLong(istAt(d, '19:00')); // done for the day after TP
      toTp(m, 'BUY');
    },
    expect: (r) => [
      ['1 trade only (no duplicate after restart)', trades(r) === 1],
      ['journal has exactly one TP close', r.journal.length === 1 && r.journal[0]?.reason === 'TAKE_PROFIT'],
    ],
  },
  {
    name: 'S14',
    title: '(1/day, live default) SHORT → SL, then a fresh setup → NOT traded',
    day: WED,
    build: (m, d) => {
      m.sweepShort(istAt(d, '15:00'));
      toSl(m, 'SELL');
      m.drift(U - 4, m.t + 20 * MIN, 0.15);
      m.sweepShort(istAt(d, '17:00'));
      toTp(m, 'SELL', 50);
    },
    expect: (r) => [
      ['exactly 1 trade (the SL)', trades(r) === 1 && r.trades[0]?.reason === 'STOP_LOSS'],
    ],
  },
];

// random market days: only invariants are checked
for (let k = 1; k <= 8; k++) {
  const days = ['2026-10-27', '2026-10-29', '2026-10-30', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-11', '2026-11-12'];
  SCENARIOS.push({
    name: `R${k}`,
    title: `Random market day #${k} (volatile walk + spikes) — invariants only`,
    day: days[k - 1],
    seed: 1000 + k * 77,
    groq: (n) => (n % 4 === 0 ? 'reject' : 'approve'),
    spread: (utc) => (Math.floor(utc / M5) % 37 === 0 ? 1.2 : 0.35),
    build: (m, d) => {
      let t = istAt(d, '14:30');
      while (t < istAt(d, '23:00')) {
        const target = m.price + m.gauss() * 6 + (m.rnd() < 0.08 ? (m.rnd() < 0.5 ? -15 : 15) : 0);
        t += (15 + Math.floor(m.rnd() * 45)) * MIN;
        m.drift(target, t, 1.2);
      }
    },
    expect: () => [],
  });
}

// ───────────────────────────── one scenario (child process) ─────────────────────────────
async function runOne(sc: Scenario): Promise<SimResult> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sim-${sc.name}-`));
  NOW = istAt(sc.day, '12:35');
  (global as unknown as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor;
  (global as unknown as { fetch: unknown }).fetch = async () => {
    throw new Error('offline (simulation)');
  };
  Object.assign(process.env, {
    DATA_SOURCE: 'mt5',
    MT5_BRIDGE_URL: 'http://sim.invalid',
    MT5_BRIDGE_TOKEN: 'sim',
    DRY_RUN: 'false',
    STRATEGIES: 'fibSweep:M5:2',
    MAX_OPEN_POSITIONS: '1',
    AI_REVIEW_ENABLED: 'true',
    GROQ_API_KEY: 'gsk_sim_key_1',
    GROQ_API_KEY_2: 'gsk_sim_key_2',
    NEWS_FILTER: 'true',
    DATA_DIR: dataDir,
    LOG_DIR: dataDir,
    LOG_LEVEL: 'error',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_ID: '',
    PHASE_START_DATE: sc.day,
    FIB_MAX_TRADES_PER_DAY: '1',
    ...(sc.env ?? {}),
  });

  /* eslint-disable @typescript-eslint/no-var-requires */
  const { mt5Bridge, BridgeError } = require('../../src/api/mt5Bridge');
  const { groqClient, GroqUnavailableError } = require('../../src/api/groq');
  const { bot } = require('../../src/bot/bot');
  const { tradeMonitor } = require('../../src/services/tradeMonitor');
  const { tradeJournal } = require('../../src/services/tradeJournal');
  const { riskManager } = require('../../src/services/riskManager');
  const { notifier } = require('../../src/services/notifier');
  const { alerts } = require('../../src/services/alerts');
  const { newsCalendar } = require('../../src/strategies/news');
  const { isAnySleeveInSession, isWeekend } = require('../../src/utils/time');

  // build the market
  const m = new Market(sc.seed ?? 42);
  m.history(istAt(sc.day, '00:00') - 16 * 86400000, istAt(sc.day, '10:00'));
  m.range(sc.day);
  m.drift(4006, istAt(sc.day, '14:30'), 0.2);
  sc.build(m, sc.day);
  m.drift(m.price, istAt(sc.day, '23:59') + 60 * MIN, 0.2);

  // fake broker
  const res: SimResult = { name: sc.name, trades: [], journal: [], alerts: [], violations: [], errors: [], groqCalls: 0, orderCalls: 0 };
  const open: SimTrade[] = [];
  let ticket = 5000;
  let lastStep = NOW;
  let realized = 0;
  const spread = (utc: number) => (sc.spread ? sc.spread(utc) : 0.35);
  const down = () => !!sc.outage && NOW >= istAt(sc.day, sc.outage[0]) && NOW < istAt(sc.day, sc.outage[1]);
  const guard = (what: string) => {
    if (down()) throw new BridgeError(`MT5 bridge GET ${what} failed: timeout of 10000ms exceeded`);
  };
  const processStops = () => {
    for (let at = lastStep + 10000; at <= NOW; at += 10000) {
      const bid = m.priceAt(at);
      const ask = bid + spread(at);
      for (const p of [...open]) {
        const buy = p.side === 'BUY';
        const px = buy ? bid : ask;
        const hitSl = buy ? px <= p.sl : px >= p.sl;
        const hitTp = buy ? px >= p.tp : px <= p.tp;
        if (!hitSl && !hitTp) continue;
        p.exit = hitSl ? p.sl : p.tp;
        p.reason = hitSl ? 'STOP_LOSS' : 'TAKE_PROFIT';
        p.closeIst = istLabel(at);
        p.profit = +((buy ? p.exit - p.entry : p.entry - p.exit) * p.volume * 100).toFixed(2);
        realized += p.profit;
        open.splice(open.indexOf(p), 1);
      }
    }
    lastStep = NOW;
  };
  const posDict = (p: SimTrade) => {
    const bid = m.priceAt(NOW);
    const cur = p.side === 'BUY' ? bid : bid + spread(NOW);
    return {
      ticket: p.ticket, symbol: 'XAUUSD', side: p.side, volume: p.volume, priceOpen: p.entry, priceCurrent: +cur.toFixed(2),
      sl: p.sl, tp: p.tp, profit: +((p.side === 'BUY' ? cur - p.entry : p.entry - cur) * p.volume * 100).toFixed(2),
      swap: 0, magic: 260101, comment: 'fn-bot', time: serverIso(NOW),
    };
  };
  Object.assign(mt5Bridge, {
    health: async () => ({ ok: !down(), mock: false, tradeAllowed: true }),
    account: async () => {
      guard('/account');
      const floating = open.reduce((a, p) => a + posDict(p).profit, 0);
      return { login: 1, server: 'Sim', currency: 'USD', balance: 6000 + realized, equity: 6000 + realized + floating, margin: 0, freeMargin: 6000, leverage: 100, tradeAllowed: true };
    },
    symbol: async () => ({ symbol: 'XAUUSD', digits: 2, point: 0.01, contractSize: 100, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01, stopsLevel: 0, spreadPoints: 35 }),
    tick: async () => {
      guard('/tick/XAUUSD');
      processStops();
      const bid = +m.priceAt(NOW).toFixed(2);
      return { symbol: 'XAUUSD', bid, ask: +(bid + spread(NOW)).toFixed(2), time: serverIso(NOW) };
    },
    candles: async (_s: string, tf: string, count: number, start = 0) => {
      guard('/candles');
      return m.candles(tf, count, start);
    },
    positions: async () => {
      guard('/positions');
      processStops();
      return open.map(posDict);
    },
    positionHistory: async (tk: number) => {
      guard('/history');
      const t = res.trades.find((x) => x.ticket === tk);
      if (!t || !t.reason) return { ticket: tk, closed: false };
      return { ticket: tk, closed: true, exitPrice: t.exit, exitReason: t.reason, exitTime: serverIso(NOW), profit: t.profit };
    },
    order: async (req: { side: 'BUY' | 'SELL'; volume: number; sl: number; tp: number }) => {
      if (down()) throw new BridgeError('MT5 bridge POST /order failed: timeout of 10000ms exceeded');
      res.orderCalls++;
      processStops();
      if (sc.rejectOrder?.(res.orderCalls)) throw new BridgeError('MT5 bridge POST /order failed: Order rejected: Invalid stops (10016)', 422);
      const bid = m.priceAt(NOW);
      const price = +(req.side === 'BUY' ? bid + spread(NOW) : bid).toFixed(2);
      if (req.side === 'BUY' ? !(req.sl < price && req.tp > price) : !(req.sl > price && req.tp < price)) {
        throw new BridgeError('MT5 bridge POST /order failed: Order rejected: Invalid stops (10016)', 422);
      }
      const t: SimTrade = { ticket: ++ticket, side: req.side, openIst: istLabel(NOW), entry: price, sl: req.sl, tp: req.tp, volume: req.volume };
      open.push(t);
      res.trades.push(t);
      return { retcode: 10009, comment: 'done', order: t.ticket, deal: t.ticket, volume: req.volume, price, ticket: t.ticket };
    },
    close: async (tk: number) => {
      const t = open.find((x) => x.ticket === tk);
      if (!t) throw new BridgeError('position not found', 404);
      const bid = m.priceAt(NOW);
      t.exit = +(t.side === 'BUY' ? bid : bid + spread(NOW)).toFixed(2);
      t.reason = 'MANUAL_OR_BOT';
      t.closeIst = istLabel(NOW);
      t.profit = +((t.side === 'BUY' ? t.exit - t.entry : t.entry - t.exit) * t.volume * 100).toFixed(2);
      realized += t.profit;
      open.splice(open.indexOf(t), 1);
      return { retcode: 10009, comment: 'done', order: tk, deal: tk, volume: t.volume, price: t.exit };
    },
  });

  // Groq stub
  groqClient.analyzeTradeOpportunity = async (prompt: string) => {
    res.groqCalls++;
    const mode = sc.groq ? sc.groq(res.groqCalls) : 'approve';
    if (mode === 'down') throw new GroqUnavailableError('All Groq keys failed (simulated outage)');
    const side = /Proposed side: (BUY|SELL)/.exec(prompt)?.[1] ?? 'SKIP';
    return mode === 'reject'
      ? { decision: 'SKIP', confidence: 0.35, reasoning: 'Looks like a genuine breakout, not a stop-run (simulated reject)', riskAssessment: '' }
      : { decision: side, confidence: 0.76, reasoning: 'Sweep rejected back inside the range (simulated approve)', riskAssessment: '' };
  };

  const b = bot as unknown as Record<string, unknown> & {
    monitorPositions: () => Promise<void>;
    scanAllPairs: () => Promise<void>;
    refreshQuotes: (s: string) => Promise<void>;
    markFeed: (ok: boolean, e?: unknown) => void;
    syncLivePositions: (adopt?: boolean) => Promise<void>;
  };
  b.isRunning = true;
  tradeMonitor.restore();

  const end = istAt(sc.day, sc.end ?? '23:35');
  let dayKey = istDay(NOW);
  let fibAlertSent = false;
  let summarySent = false;
  let restarted = false;
  const openedPerDay = new Map<string, number>();
  let seenTrades = 0;

  while (NOW <= end) {
    // cron-like jobs
    if (!fibAlertSent && NOW >= istAt(sc.day, '12:40')) {
      fibAlertSent = true;
      alerts.fibLevels(await newsCalendar.majorNewsDay(new Date()).catch(() => null));
    }
    if (!summarySent && NOW >= istAt(sc.day, '23:30')) {
      summarySent = true;
      alerts.dailySummary();
    }
    if (istDay(NOW) !== dayKey) {
      dayKey = istDay(NOW);
      riskManager.resetDaily();
    }
    if (sc.restartAt && !restarted && NOW >= istAt(sc.day, sc.restartAt)) {
      restarted = true;
      (tradeMonitor as unknown as { openTrades: Map<string, unknown> }).openTrades.clear();
      b.evaluatedCandle = new Map();
      riskManager.restore(tradeJournal.getTodayStats());
      tradeMonitor.restore();
      await b.syncLivePositions(true).catch((e: Error) => res.errors.push(`restart sync: ${e.message}`));
    }

    // one bot cycle (same as TradingBot.mainLoop)
    try {
      if (tradeMonitor.getOpenTrades().length > 0 && !isWeekend()) await b.monitorPositions();
      if (isAnySleeveInSession()) await b.scanAllPairs();
      else await b.refreshQuotes('Outside session');
      b.markFeed(true);
    } catch (error) {
      if (!down()) res.errors.push(`${istLabel(NOW)} ${(error as Error).message}`);
      b.markFeed(false, error);
    }

    // invariants
    if (open.length > 1) res.violations.push(`${istLabel(NOW)} ${open.length} positions open (max 1)`);
    for (const p of open) if (!(p.sl > 0 && p.tp > 0)) res.violations.push(`${istLabel(NOW)} position ${p.ticket} without SL/TP`);
    while (seenTrades < res.trades.length) {
      const t = res.trades[seenTrades++];
      const k = istDay(NOW);
      openedPerDay.set(k, (openedPerDay.get(k) ?? 0) + 1);
      const cap = Number(process.env.FIB_MAX_TRADES_PER_DAY ?? 2);
      if ((openedPerDay.get(k) ?? 0) > cap) res.violations.push(`${t.openIst} more than ${cap} trade(s) on ${k}`);
      if (t.openIst < '14:30' || t.openIst > '21:03') res.violations.push(`${t.openIst} entry outside 14:30–21:00 IST`);
      const risk = Math.abs(t.entry - t.sl) * t.volume * 100;
      if (risk > 46) res.violations.push(`${t.openIst} risk $${risk.toFixed(2)} > $45`);
      if (t.volume < 0.01) res.violations.push(`${t.openIst} volume ${t.volume} below minimum`);
    }
    NOW += 30000;
  }
  // final sync so the journal sees the last broker closes
  await b.syncLivePositions().catch(() => undefined);

  res.journal = tradeJournal.getAllClosed().map((t: { type: string; reason: string; pnl: number }) => ({ side: t.type, reason: t.reason, pnl: t.pnl }));
  res.alerts = notifier.sent.map((a: { text: string }) => a.text.split('\n')[0]);
  for (const t of res.trades.filter((x) => x.reason)) {
    const j = tradeJournal.getAllClosed().find((x: { tradeId: string }) => x.tradeId === `MT5_${t.ticket}`);
    if (!j) res.violations.push(`ticket ${t.ticket} closed at the broker but missing in the journal`);
    else if (j.reason !== t.reason || Math.abs(j.pnl - (t.profit ?? 0)) > 0.02) res.violations.push(`ticket ${t.ticket} journal ${j.reason} $${j.pnl} ≠ broker ${t.reason} $${t.profit}`);
  }
  return res;
}

// ───────────────────────────── runner ─────────────────────────────
async function main(): Promise<void> {
  const childIdx = process.argv.indexOf('--child');
  if (childIdx >= 0) {
    const sc = SCENARIOS.find((s) => s.name === process.argv[childIdx + 1])!;
    const r = await runOne(sc);
    process.stdout.write(`@@RESULT@@${JSON.stringify(r)}\n`);
    process.exit(0);
  }
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const list = SCENARIOS.filter((s) => only.length === 0 || only.includes(s.name));
  let failedChecks = 0;
  console.log(`Market simulation — real bot code, fake MT5 broker + clock (${list.length} scenarios)\n`);
  for (const sc of list) {
    const p = spawnSync(process.execPath, [...process.execArgv, __filename, '--child', sc.name], {
      encoding: 'utf8',
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
      maxBuffer: 50 * 1024 * 1024,
    });
    const line = (p.stdout || '').split('\n').find((l) => l.startsWith('@@RESULT@@'));
    if (!line) {
      failedChecks++;
      console.log(`✘ ${sc.name} crashed\n${(p.stderr || p.stdout || '').slice(-1500)}`);
      continue;
    }
    const r: SimResult = JSON.parse(line.slice(10));
    const checks: [string, boolean][] = [
      ...sc.expect(r),
      ['no invariant violations', r.violations.length === 0],
      ['no unexpected errors', r.errors.length === 0],
    ];
    const ok = checks.every(([, v]) => v);
    if (!ok) failedChecks += checks.filter(([, v]) => !v).length;
    const pnl = r.trades.reduce((a, t) => a + (t.profit ?? 0), 0);
    console.log(`${ok ? '✔' : '✘'} ${sc.name}  ${sc.title}`);
    console.log(`    trades ${r.trades.length} · P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} · Groq calls ${r.groqCalls} · orders ${r.orderCalls}`);
    for (const t of r.trades) {
      console.log(`      ${t.side.padEnd(4)} ${t.openIst} @ ${t.entry.toFixed(2)}  SL ${t.sl}  TP ${t.tp}  ${t.volume} lot → ${t.reason ?? 'OPEN'}${t.closeIst ? ` ${t.closeIst}` : ''}${t.profit !== undefined ? ` ${t.profit >= 0 ? '+' : ''}$${t.profit.toFixed(2)}` : ''}`);
    }
    for (const [label, v] of checks) if (!v || only.length) console.log(`      ${v ? '✔' : '✘'} ${label}`);
    for (const v of r.violations) console.log(`      ! ${v}`);
    for (const e of r.errors.slice(0, 5)) console.log(`      ! error ${e}`);
    if (only.length) console.log(`      alerts: ${r.alerts.join(' | ')}`);
  }
  console.log(`\n${failedChecks === 0 ? 'ALL SCENARIOS PASSED' : `${failedChecks} CHECK(S) FAILED`}`);
  process.exit(failedChecks ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
