import { notifier, escapeHtml } from '../../src/services/notifier';
import { alerts } from '../../src/services/alerts';
import { OpenTrade } from '../../src/services/tradeMonitor';

const trade: OpenTrade = {
  tradeId: 'T1', pair: 'XAUUSD', type: 'SELL', entryPrice: 4130.89, currentPrice: 4130.89, quantity: 4,
  stopLoss: 4142.48, takeProfit: 4109.7, pnl: 0, pnlPercent: 0, openedAt: new Date(Date.now() - 85 * 60000),
  ticket: 123456, lots: 0.04, riskAmount: 46.36, sleeve: 'fibSweep:M5',
};
const last = () => notifier.sent[notifier.sent.length - 1].text;

describe('Telegram alerts', () => {
  it('escapes HTML', () => {
    expect(escapeHtml('a<b & c>')).toBe('a&lt;b &amp; c&gt;');
  });
  it('trade opened card has entry, SL, TP, size, risk→reward, Groq, ticket', () => {
    alerts.tradeOpened(trade, { lots: 0.04, risk: 46.36, confidence: 0.72, reason: 'Fib 2 line swept' });
    const t = last();
    expect(t).toMatch(/SELL opened · fibSweep M5/);
    expect(t).toMatch(/Entry: 4130\.89/);
    expect(t).toMatch(/Stop loss: 4142\.48/);
    expect(t).toMatch(/Size: 0\.04 lot/);
    expect(t).toMatch(/Risk → reward: \$46\.36 → \$84\.76/);
    expect(t).toMatch(/Groq: approved \(0\.72\)/);
    expect(t).toMatch(/Ticket: 123456/);
  });
  it('trade closed card shows result in $ and R, duration and phase progress', () => {
    alerts.tradeClosed(trade, 4109.7, 84.76, 'TAKE_PROFIT');
    const t = last();
    expect(t).toMatch(/Take profit hit · \+\$84\.76 \(\+1\.83R\)/);
    expect(t).toMatch(/Duration: 1h 25m/);
    expect(t).toMatch(/Phase target: /);
  });
  it('stop loss shows a negative R', () => {
    alerts.tradeClosed(trade, 4142.48, -46.36, 'STOP_LOSS');
    expect(last()).toMatch(/Stop loss hit · −\$46\.36 \(-1\.00R\)/);
  });
});
