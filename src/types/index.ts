// Trade types
export interface Trade {
  id: string;
  pair: string;
  type: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  riskAmount: number;
  rewardAmount: number;
  entryTime: Date;
  exitTime?: Date;
  exitPrice?: number;
  pnl?: number;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  reason?: string;
}

// Market Data types
export interface OHLC {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface MarketData {
  pair: string;
  currentPrice: number;
  ask: number;
  bid: number;
  timestamp: Date;
}

// Strategy Signal types
export interface StrategySignal {
  pair: string;
  signal: 'BUY' | 'SELL' | 'SKIP';
  strength: number; // 0-100
  reasoning: string;
  confidence: number; // 0-1
  timestamp: Date;
}

// Account Status types
export interface AccountStatus {
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  openPositions: number;
  totalTrades: number;
  winRate: number;
  dailyPnL: number;
  timestamp: Date;
}
