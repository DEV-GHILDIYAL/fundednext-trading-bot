/**
 * Backtest the London breakout rules on historical 1H candles.
 *
 *   npm run backtest                       # DATA_SOURCE from .env (mt5 = real history via the bridge)
 *   npm run backtest -- --bars 5000        # more history (max 10000)
 *   npm run backtest -- --source sim       # offline smoke test on the random-walk feed
 *
 * Same EntrySignalGenerator as the live bot. NOT included: the Groq review (can't be replayed
 * deterministically) and slippage. Fills: next bar's open + current spread. If SL and TP are
 * both inside one bar, the SL is assumed first (conservative).
 */
import { config } from '../src/config';
import { createMarketDataSource, computeAtrPips, CandleData } from '../src/api/market';
import { EntrySignalGenerator, MIN_CLOSED_CANDLES, defaultStrategyParams } from '../src/strategies/entrySignalGenerator';
import { getPairSpec, PAIR_LIST } from '../src/constants/pairs';
import { isWithinTradingSession, getZonedTime } from '../src/utils/time';

interface BtTrade {
  side: 'BUY' | 'SELL';
  openedAt: Date;
  entry: number;
  sl: number;
  tp: number;
  result: 'WIN' | 'LOSS' | 'OPEN';
  r: number;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const source = arg('source', config.dataSource) === 'mt5' ? 'mt5' : 'sim';
  const bars = Math.min(10000, parseInt(arg('bars', '3000'), 10));
  const pair = PAIR_LIST[0];
  const spec = getPairSpec(pair);
  const market = createMarketDataSource(source);
  const params = defaultStrategyParams();

  console.log(`Backtest ${pair} on ${source.toUpperCase()} data, ${bars} H1 bars`);
  const candles = (await market.getCandles(pair, 'H1', bars)).filter((c) => c.closed !== false);
  const quote = await market.getCurrentPrice(pair);
  const spread = Math.max(quote.ask - quote.bid, spec.pipSize);

  // MT5 bar times are broker server time written as UTC → shift to real UTC for the session check
  let offsetMs = 0;
  if (source === 'mt5') {
    offsetMs = Math.round((quote.timestamp.getTime() - Date.now()) / 1800000) * 1800000;
    console.log(`Server time offset: ${(offsetMs / 3600000).toFixed(1)} h | spread used: ${spread.toFixed(2)}`);
  }

  const trades: BtTrade[] = [];
  const perDay = new Map<string, number>();
  let open: BtTrade | null = null;

  for (let i = MIN_CLOSED_CANDLES; i < candles.length - 1; i++) {
    const bar = candles[i];
    // 1. manage the open trade on this bar
    if (open) {
      const hitSl = open.side === 'BUY' ? bar.low <= open.sl : bar.high + spread >= open.sl;
      const hitTp = open.side === 'BUY' ? bar.high >= open.tp : bar.low + spread <= open.tp;
      if (hitSl || hitTp) {
        open.result = hitSl ? 'LOSS' : 'WIN';
        open.r = hitSl ? -1 : params.rewardRatio;
        open = null;
      }
      if (open) continue; // no hedging
    }

    // 2. this bar just closed → evaluate at the close (= next bar's open)
    const closeAt = new Date(bar.timestamp.getTime() + 3600000 - offsetMs);
    if (!isWithinTradingSession(closeAt)) continue;
    const day = getZonedTime(closeAt).dateKey;
    if ((perDay.get(day) ?? 0) >= config.maxTradesPerDay) continue;

    const history: CandleData[] = candles.slice(Math.max(0, i - 59), i + 1);
    const next = candles[i + 1];
    const bid = next.open;
    const signal = EntrySignalGenerator.generateTradeSignal(
      {
        pair,
        quote: { pair, bid, ask: bid + spread, spread: parseFloat((spread / spec.pipSize).toFixed(1)), timestamp: closeAt },
        candles: history,
        atrPips: computeAtrPips(history, spec.pipSize, 14),
      },
      params
    );
    if (signal.signal === 'SKIP') continue;

    open = {
      side: signal.signal,
      openedAt: closeAt,
      entry: signal.entryPrice,
      sl: signal.stopLoss,
      tp: signal.takeProfit,
      result: 'OPEN',
      r: 0,
    };
    trades.push(open);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const done = trades.filter((t) => t.result !== 'OPEN');
  const wins = done.filter((t) => t.result === 'WIN').length;
  const losses = done.length - wins;
  const netR = done.reduce((s, t) => s + t.r, 0);
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const t of done) {
    equity += t.r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const grossWin = wins * params.rewardRatio;
  const first = candles[0]?.timestamp;
  const last = candles[candles.length - 1]?.timestamp;
  const weeks = first && last ? (last.getTime() - first.getTime()) / (7 * 86400000) : 0;

  console.log('──────────────────────────────────────────');
  console.log(`Period: ${first?.toISOString().slice(0, 10)} → ${last?.toISOString().slice(0, 10)} (${weeks.toFixed(1)} weeks)`);
  console.log(`Trades: ${done.length} (${(done.length / Math.max(weeks, 1)).toFixed(1)}/week) | open at end: ${trades.length - done.length}`);
  console.log(`Wins ${wins} / Losses ${losses} | win rate ${done.length ? ((wins / done.length) * 100).toFixed(1) : '0'}% (break-even ≈ ${(100 / (1 + params.rewardRatio)).toFixed(1)}%)`);
  console.log(`Net: ${netR.toFixed(1)} R = $${(netR * config.riskPerTrade).toFixed(2)} at $${config.riskPerTrade}/trade`);
  console.log(`Profit factor: ${losses ? (grossWin / losses).toFixed(2) : '∞'} | max drawdown ${maxDd.toFixed(1)} R = $${(maxDd * config.riskPerTrade).toFixed(2)}`);
  console.log('Not modelled: Groq review, slippage, swap/commission.');
  for (const t of done.slice(-10)) {
    console.log(`  ${t.openedAt.toISOString().slice(0, 16)} ${t.side} ${t.entry} SL ${t.sl} TP ${t.tp} → ${t.result}`);
  }
}

main().catch((error) => {
  console.error('Backtest failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
