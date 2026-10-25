/**
 * Download long MT5 history through the bridge (10,000 bars per request, paged with ?start=) into CSV files
 * for offline research. Read-only — does not touch the running bot.
 *
 *   npm run fetch-history                         # M5 ≈ 6 months (45,000 bars) + M15/H1/D1
 *   npm run fetch-history -- --m5 60000           # more M5 history
 *   npm run fetch-history -- --out data/history   # output folder (default)
 *
 * Files: <out>/XAUUSD_<TF>.csv  — time (MT5 server time, ISO), open, high, low, close, volume (closed bars only)
 */
import fs from 'fs';
import path from 'path';
import { Mt5BridgeClient, BridgeCandle } from '../src/api/mt5Bridge';
import { PAIR_LIST } from '../src/constants/pairs';

const PAGE = 10000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

async function fetchAll(bridge: Mt5BridgeClient, symbol: string, tf: string, want: number): Promise<BridgeCandle[]> {
  const byTime = new Map<string, BridgeCandle>();
  let oldestPrev: string | null = null;
  for (let start = 0; start < want; start += PAGE) {
    const count = Math.min(PAGE, want - start);
    const page = await bridge.candles(symbol, tf, count, start);
    if (page.length === 0) break;
    const newest = page[page.length - 1].time;
    if (oldestPrev !== null && newest >= oldestPrev) {
      throw new Error(
        'The bridge ignored ?start= (old bridge version). Update the Windows bridge first (see DEPLOYMENT.md / the deploy command), then re-run.'
      );
    }
    for (const c of page) byTime.set(c.time, c);
    oldestPrev = page[0].time;
    process.stdout.write(`\r  ${tf}: ${byTime.size} bars (back to ${page[0].time.slice(0, 10)})   `);
    if (page.length < count) break; // broker has no older data
  }
  process.stdout.write('\n');
  return Array.from(byTime.values())
    .filter((c) => c.closed !== false)
    .sort((a, b) => a.time.localeCompare(b.time));
}

async function main(): Promise<void> {
  const out = arg('out', 'data/history');
  const symbol = PAIR_LIST[0];
  const plan: [string, number][] = [
    ['M5', parseInt(arg('m5', '45000'), 10)],
    ['M15', parseInt(arg('m15', '15000'), 10)],
    ['H1', parseInt(arg('h1', '5000'), 10)],
    ['D1', parseInt(arg('d1', '600'), 10)],
  ];
  const bridge = new Mt5BridgeClient();
  fs.mkdirSync(out, { recursive: true });
  console.log(`Downloading ${symbol} history from the MT5 bridge → ${out}/`);
  for (const [tf, want] of plan) {
    const bars = await fetchAll(bridge, symbol, tf, want);
    const file = path.join(out, `${symbol}_${tf}.csv`);
    const lines = ['time,open,high,low,close,volume', ...bars.map((b) => `${b.time},${b.open},${b.high},${b.low},${b.close},${b.volume}`)];
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const first = bars[0]?.time.slice(0, 10);
    const last = bars[bars.length - 1]?.time.slice(0, 10);
    const weeks = bars.length ? (Date.parse(bars[bars.length - 1].time) - Date.parse(bars[0].time)) / (7 * 86400000) : 0;
    console.log(`  saved ${file}: ${bars.length} bars, ${first} → ${last} (${weeks.toFixed(0)} weeks)`);
  }
  console.log('Done. Next: npm run fib-analysis');
}

main().catch((error) => {
  console.error('\nfetch-history failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
