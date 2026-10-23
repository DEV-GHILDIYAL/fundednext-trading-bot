# FundedNext Trading Bot

London-session breakout bot for **XAUUSD on MT5** (FundedNext), with a Groq AI review of every signal,
hard-coded FundedNext risk rules, a live dashboard, Telegram alerts, Terraform infrastructure and
GitHub Actions CI/CD. Built as a DevOps portfolio project.

```
┌──────────── Ubuntu EC2 (fundednext-bot-prod) ────────────┐        ┌──────── Windows EC2 (MT5 host) ────────┐
│  Node bot (PM2)                                          │  HTTP  │  bridge/app.py (FastAPI + MetaTrader5) │
│  • strategy · risk manager · trade journal               │ ─────▶ │  MT5 terminal → FundedNext-Server3     │
│  • Groq review (2 keys, auto failover)                   │ token  │  started at logon, auto-restart        │
│  • dashboard :3000 · Telegram alerts                     │        └────────────────────────────────────────┘
└──────────────────────────────────────────────────────────┘               ▲ SSM Run Command (deploy)
         ▲ SSH (deploy)                                                    │
         └──────────────── GitHub Actions: test → deploy ──────────────────┘
```

## Modes

| `DATA_SOURCE` | `DRY_RUN` | What happens |
|---|---|---|
| `sim` | `true` | Offline random-walk prices, paper fills (loop/UI testing) |
| `mt5` | `true` | **Real MT5 prices, paper fills** ← current testing stage |
| `mt5` | `false` | Real orders on the MT5 account (SL/TP set on the broker) |

Live orders on simulated prices are refused.

## Strategies

`STRATEGY=` picks one from `src/strategies/library.ts` — the backtest and the live bot run the same code:
`breakout` (default) · `trendPullback` · `asianBreakout` · `meanReversion` · `emaCross` · `donchian`,
plus objective versions of educators' setups: `turtle20`/`turtle55` (Turtle, AlgoWorld), `volBreakout` (Larry Williams),
`pinBar` (Nial Fuller), `raynerEma` (Rayner Teo), `ictSilverBullet` (ICT), `casperSmc` (Casper SMC).
Compare them on real MT5 history: `npm run backtest -- --strategies` (ranked, with in-sample / out-of-sample split).

### Portfolio mode (recommended)

`STRATEGIES=` trades several strategies together. By default only one position is open at a time; `MAX_OPEN_POSITIONS=2|3` allows more, same direction only and one per strategy. `MAX_TRADES_PER_DAY` is shared, and the first signal wins:

```
STRATEGIES=asianBreakout:M30:2, volBreakout:M30:2, nyOpenBreakout:M15:2
```

- `nyOpenBreakout`: takes the first close beyond the 08:30–09:30 New York range (± 5% of the range) between 09:30 and 12:00 NY. The range must be 0.15–1.0 × D1 ATR. SL is the other side of the range, capped at 0.6 × D1 ATR. No trades on FOMC days.
- `insideDayBreakout`: needs yesterday to be an inside day or NR4 with range < ATR40(D1). Trades a close beyond yesterday's high/low ± 0.1 × D1 ATR in the SMA5 direction. SL is 1 × D1 ATR.
- Filters:
  - **News blackout** (`NEWS_FILTER=true`): no new entries from 15 min before to 30 min after US tier-1 news (60 min after FOMC). Uses the ForexFactory feed plus a built-in NFP/FOMC schedule.
  - asianBreakout skips Asian ranges outside 0.10–0.80 × D1 ATR.
- `npm run backtest -- --portfolio` simulates exactly this: each strategy with filters ON vs OFF, the combined portfolio, and Monte Carlo pass odds for both phases. Add `--why` to see skip reasons.
- `npm run ai-audit` replays every Groq-approved and Groq-rejected signal (`data/ai-reviews.jsonl`) on MT5 candles, to show whether the AI veto adds value.

### Breakout rules (summary — full rules in the project's `STRATEGY.md`)

- **XAUUSD only**, London session **08:00–11:30 London time** (13:30–17:00 IST in winter, DST automatic)
- Entry when a **closed 1H candle** closes beyond the last-24-candle range (or previous D1 with `RANGE_MODE=prevDay`),
  price still beyond it, ATR ≥ `MIN_ATR_PIPS`, spread ≤ `MAX_SPREAD_PIPS`, price action agrees, no S/R in the way
- One decision per candle, only within 15 min of the close
- **SL** beyond nearest S/R, clamped to 0.5–1.5 × ATR · **TP** = 2 × SL · exits: **SL or TP only**
- **Groq review** must approve (same side, confidence ≥ 0.55). Groq down → trade skipped (fail-closed) + alert

## Risk rules (FundedNext Stellar 2-Step, $6K)

| Rule | Value |
|---|---|
| Risk per trade | 0.75% = **$45** (cap 1%), lots rounded **down** to broker volume step |
| Max trades/day | 3 |
| Safety buffer (no new trades) | −$135 |
| Daily loss (close everything) | −$300 (5%, realized + floating) |
| Max loss | −$600 (10%) |
| Target | Phase 1 $480 (8%) · Phase 2 $300 (5%) · min 5 trading days |
| Min hold | 30 s (Quick Strike rule) |

Open trades survive restarts/deploys (paper: `data/open-trades.json`, live: re-synced from MT5).

## Quick start (local)

```bash
npm ci
cp .env.example .env          # DATA_SOURCE=sim for an offline run
npm run dev                   # dashboard on http://localhost:3000
npm test                      # unit tests
npm run test:bridge           # bridge tests (mock MT5, needs Python)
npm run backtest -- --bars 5000   # strategy on MT5 history (DATA_SOURCE=mt5)
```

Run the bridge without MT5 (Linux/macOS), then point the bot at it:

```bash
cd bridge && pip install -r requirements.txt
BRIDGE_MOCK=1 BRIDGE_TOKEN=dev python -m uvicorn app:app --port 8765
# .env: DATA_SOURCE=mt5  MT5_BRIDGE_URL=http://127.0.0.1:8765  MT5_BRIDGE_TOKEN=dev
```

## Deploy

See **[DEPLOYMENT.md](DEPLOYMENT.md)** — Terraform for the Windows MT5 host, GitHub Actions secrets,
and moving everything to a new AWS account.

## Layout

```
src/            bot (TypeScript)        bridge/        MT5 bridge (Python, FastAPI)
  api/          market data, MT5 client, Groq      scripts/windows/   Windows setup/run/deploy
  strategies/   breakout, S/R, price action        scripts/backtest.ts
  services/     risk, executor, monitor, journal, notifier
infra/terraform Windows MT5 host, SSM secrets, GitHub OIDC role, optional Ubuntu bot
.github/workflows ci.yml · deploy-bot.yml · deploy-bridge.yml
```
