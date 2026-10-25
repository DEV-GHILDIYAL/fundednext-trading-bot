/**
 * Is the Groq review helping? Replays every reviewed signal in data/ai-reviews.jsonl on real MT5 M5 candles
 * and compares what the APPROVED signals did vs what the REJECTED ones would have done.
 *
 *   npm run ai-audit                 # needs DATA_SOURCE=mt5 (reads candles from the bridge)
 *   npm run ai-audit -- --file path  # another log file
 *
 * If rejected signals win as often as approved ones, the AI is just removing trades (slower phases) —
 * then set AI_REVIEW_ENABLED=false or keep it only as a sanity check.
 */
import { config } from '../src/config';
import { createMarketDataSource } from '../src/api/market';
import { readAiReviews, aiReviewLogPath, AiReviewRecord } from '../src/services/aiReviewLog';
import { PAIR_LIST } from '../src/constants/pairs';
import { serverToUtc } from '../src/utils/time';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

type Outcome = 'WIN' | 'LOSS' | 'OPEN' | 'NO DATA';

async function main(): Promise<void> {
  const file = arg('file', aiReviewLogPath());
  const records = readAiReviews(file).filter((r) => r.verdict !== 'unavailable');
  if (records.length === 0) {
    console.log(`No reviewed signals in ${file} yet — let the bot run first.`);
    return;
  }
  const market = createMarketDataSource(config.dataSource);
  const m5 = (await market.getCandles(PAIR_LIST[0], 'M5', 10000)).filter((c) => c.closed !== false);

  const replay = (r: AiReviewRecord): { outcome: Outcome; r: number } => {
    const from = new Date(r.at).getTime();
    const risk = Math.abs(r.entry - r.sl);
    const reward = Math.abs(r.tp - r.entry);
    if (!(risk > 0)) return { outcome: 'NO DATA', r: 0 };
    const bars = m5.filter((c) => (market.isSimulated ? c.timestamp : serverToUtc(c.timestamp)).getTime() >= from);
    if (bars.length === 0) return { outcome: 'NO DATA', r: 0 };
    for (const c of bars) {
      const hitSl = r.side === 'BUY' ? c.low <= r.sl : c.high >= r.sl;
      const hitTp = r.side === 'BUY' ? c.high >= r.tp : c.low <= r.tp;
      if (hitSl) return { outcome: 'LOSS', r: -1 }; // both in one bar → SL (conservative)
      if (hitTp) return { outcome: 'WIN', r: reward / risk };
    }
    return { outcome: 'OPEN', r: 0 };
  };

  const groups: Record<string, { n: number; win: number; loss: number; open: number; r: number }> = {};
  console.log('Time (UTC)        Strategy                  Side  Verdict   AI conf  Outcome');
  for (const rec of records) {
    const res = replay(rec);
    const g = rec.verdict === 'approved' ? 'APPROVED' : 'REJECTED';
    groups[g] ??= { n: 0, win: 0, loss: 0, open: 0, r: 0 };
    const x = groups[g];
    x.n++;
    if (res.outcome === 'WIN') x.win++;
    if (res.outcome === 'LOSS') x.loss++;
    if (res.outcome === 'OPEN' || res.outcome === 'NO DATA') x.open++;
    x.r += res.r;
    console.log(
      `${rec.at.slice(0, 16)}  ${rec.sleeve.padEnd(25)} ${rec.side.padEnd(5)} ${rec.verdict.padEnd(9)} ${String(rec.confidence ?? '-').padEnd(8)} ${res.outcome}${res.r ? ` (${res.r.toFixed(2)}R)` : ''}`
    );
  }
  console.log('\nGroup      Signals  Wins  Losses  Open  Win%   Net R');
  for (const [g, x] of Object.entries(groups)) {
    const closed = x.win + x.loss;
    console.log(`${g.padEnd(10)} ${String(x.n).padStart(7)} ${String(x.win).padStart(5)} ${String(x.loss).padStart(7)} ${String(x.open).padStart(5)} ${(closed ? (x.win / closed) * 100 : 0).toFixed(0).padStart(5)} ${x.r.toFixed(1).padStart(7)}`);
  }
  const rej = groups.REJECTED;
  if (rej && rej.win + rej.loss >= 10) {
    console.log(rej.r > 0 ? '\n⚠️ Rejected signals were net profitable — the AI is costing you R. Consider AI_REVIEW_ENABLED=false.' : '\n✅ Rejected signals were net losers — the AI filter is helping so far.');
  } else {
    console.log('\nNeed ≥10 closed rejected signals before judging the AI filter.');
  }
}

main().catch((error) => {
  console.error('AI audit failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
