# FundedNext Trading Bot

Automated London Breakout + Support/Resistance trading bot for FundedNext.

## Strategy Overview

- **Strategy**: London Breakout + S/R Bounce
- **Expected Win Rate**: 70-72%
- **Risk/Reward**: 1:2 (minimum)
- **Target**: $300 profit on $6K account
- **Duration**: 13 days (Oct 21 - Nov 3, 2026)

## Trading Rules

### Entry Conditions (ALL must be true)
1. Time: 8:00 AM - 10:00 AM GMT ONLY
2. Instrument: EURUSD, GBPUSD, or XAU/USD
3. Breakout: Price closes ABOVE yesterday's High OR BELOW yesterday's Low
4. Confirmation: Wait for candle close (no wicks)
5. Volatility: ATR > 50 pips (ensures good volatility)
6. Trend: Check 1H timeframe direction (entry confirmation)

### Position Sizing
- Account Balance: $6,000
- Risk Per Trade: $30 (0.5%)
- Reward Per Trade: $60 (minimum, for 1:2 ratio)
- Lot Size = Risk Amount / (Entry - SL) × 10,000

### Exit Rules
| Condition | Action |
|-----------|--------|
| Price hits Target (2:1 profit) | Close trade (✓) |
| Price hits Stop Loss | Close trade (-$30) |
| 4 hours passed | Close at 50% of position |
| Session ends (17:00 GMT) | Force close remaining |

### Daily Limits (HARD CAPS)
- Max 3 trades per day (one per pair, per session)
- Max daily loss: -$100 (1.67% account)
- Safety buffer: Stop at -$70 loss (30% of hard limit)
- If safety buffer hit → **ZERO new trades for rest of day**

### Risk Controls (ENFORCED)
✅ Never increase lot size after loss  
✅ Never average down / add to losing position  
✅ Never force trades to hit profit targets  
✅ Max $30 risk per trade - NO EXCEPTIONS  
✅ 1:2 ratio minimum - target always $60+  
✅ Position sizing per instrument specs  
✅ Stop all trades when -$70 loss reached  
✅ Force close if losses exceed -$100

## Tech Stack

**Language**: TypeScript 5.0+  
**Runtime**: Node.js 18 LTS  
**Database**: SQLite3  
**Testing**: Jest  
**Logging**: Winston + Pino  
**Scheduling**: node-cron  
**HTTP Client**: Axios  
**Process Manager**: PM2 (production)  
**Containerization**: Docker  

## Development Phases

### Phase 1: Foundation ✅ (Starting Now - Day 1)
- [x] Create GitHub repository
- [x] Setup project structure
- [x] Configure TypeScript & dependencies
- [x] Create .env template
- [x] Setup logging system
- [x] Write basic types/interfaces
- **Time**: 2-3 hours

### Phase 2: API Integration (Day 2)
- [ ] Build FundedNext API client
- [ ] Build Claude API wrapper
- [ ] Build market data fetcher
- [ ] Test API connections
- [ ] Setup error handling
- **Time**: 4-5 hours

### Phase 3: Strategy Implementation (Day 3)
- [ ] London Breakout detector
- [ ] Support/Resistance calculator
- [ ] Entry signal generator
- [ ] Unit tests for strategies
- [ ] Backtest against historical data
- **Time**: 4-5 hours

### Phase 4: Trade Execution (Day 4)
- [ ] Order management system
- [ ] Trade monitoring (real-time P&L)
- [ ] SL/TP trigger monitoring
- [ ] Exit execution control
- [ ] Logging & alerts
- **Time**: 4 hours

### Phase 5: Risk Management & Daily Limits (Day 5)
- [ ] Position sizing calculator
- [ ] Daily loss tracking
- [ ] Safety buffer enforcement
- [ ] Maximum trades per day limit
- [ ] Risk per trade enforcement
- **Time**: 3 hours

### Phase 6: Deployment (Day 6)
- [ ] Docker containerization
- [ ] AWS EC2 setup
- [ ] PM2 process manager config
- [ ] CI/CD with GitHub Actions
- [ ] Health check endpoints
- **Time**: 3-4 hours

### Phase 7: Backtesting & Optimization (Day 7)
- [ ] Download historical data
- [ ] Run full backtest
- [ ] Validate win rate (70%+)
- [ ] Optimize entry timing
- [ ] Final safety audit
- **Time**: 2-3 hours

## Installation

```bash
# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your API keys

# Build
npm run build

# Run in dev mode
npm run dev

# Run tests
npm run test

# Backtest
npm run backtest
```

## API Keys Required

1. **FundedNext**: Your trading account API key
2. **Claude**: For AI-powered trade decision making
3. **Market Data**: For FOREX/Gold price feeds

## Safety & Compliance

⚠️ **This is a paper trading bot for learning/portfolio purposes only**
- Use with dry-run mode enabled first
- Never use with real money without thorough backtesting
- Always maintain stop losses
- Monitor daily loss limits strictly

## Next Steps

1. Setup environment variables (.env file)
2. Install dependencies: `npm install`
3. Start Phase 2: API Integration

---

**Created**: 2026-10-22  
**Status**: In Development (Phase 1)  
**Last Updated**: 2026-10-22
