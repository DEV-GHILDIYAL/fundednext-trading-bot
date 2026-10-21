import { logger } from '../utils/logger';
import { config } from '../config';
import { Validator } from '../utils/validator';
import { Calculator } from '../utils/calculator';
import { getPairSpec } from '../constants/pairs';
import { TradeSignal } from '../strategies/entrySignalGenerator';

export interface ExecutionRequest {
  pair: string;
  type: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Position size in units */
  quantity: number;
  lots: number;
  riskAmount: number;
}

export interface ExecutionResult {
  success: boolean;
  tradeId?: string;
  message: string;
  executedAt?: Date;
  executedPrice?: number;
  quantity?: number;
  error?: string;
}

const LIVE_NOT_AVAILABLE =
  'Live execution is not available: MT5 bridge is not implemented yet. Keep DRY_RUN=true.';

export class TradeExecutor {
  constructor(private readonly dryRun: boolean = config.dryRun) {}

  get isDryRun(): boolean {
    return this.dryRun;
  }

  async executeTrade(signal: TradeSignal): Promise<ExecutionResult> {
    if (signal.signal === 'SKIP') {
      return { success: false, message: `Trade skipped: ${signal.reasoning}` };
    }

    try {
      this.validateSignal(signal);

      const quantity = Calculator.calculatePositionSize(config.riskPerTrade, signal.entryPrice, signal.stopLoss);
      Validator.validateQuantity(quantity, 'Position size');

      const request: ExecutionRequest = {
        pair: signal.pair,
        type: signal.signal,
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        quantity,
        lots: Calculator.unitsToLots(quantity, getPairSpec(signal.pair).contractSize),
        riskAmount: config.riskPerTrade,
      };

      return await this.executeOrder(request);
    } catch (error) {
      logger.error('Trade execution failed', error);
      return {
        success: false,
        message: 'Trade execution failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private validateSignal(signal: TradeSignal): void {
    Validator.validateTradingPair(signal.pair);
    Validator.validatePrice(signal.entryPrice, 'Entry Price');
    Validator.validatePrice(signal.stopLoss, 'Stop Loss');
    Validator.validatePrice(signal.takeProfit, 'Take Profit');

    const side = signal.signal === 'BUY' ? 'BUY' : 'SELL';
    Validator.validateStopLoss(signal.entryPrice, signal.stopLoss, side);
    Validator.validateTakeProfit(signal.entryPrice, signal.takeProfit, side);

    const risk = Math.abs(signal.entryPrice - signal.stopLoss);
    const reward = Math.abs(signal.takeProfit - signal.entryPrice);
    Validator.validateRRRatio(reward / risk, 1.5);
  }

  private async executeOrder(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!this.dryRun) {
      logger.error(LIVE_NOT_AVAILABLE);
      return { success: false, message: LIVE_NOT_AVAILABLE };
    }

    const tradeId = this.generateTradeId();
    logger.info(`📝 [PAPER] ${request.type} ${request.pair} @ ${request.entryPrice}`, {
      tradeId,
      sl: request.stopLoss,
      tp: request.takeProfit,
      lots: request.lots,
      risk: `$${request.riskAmount}`,
    });

    return {
      success: true,
      tradeId,
      message: `[PAPER] ${request.type} ${request.pair} opened`,
      executedAt: new Date(),
      executedPrice: request.entryPrice,
      quantity: request.quantity,
    };
  }

  async closeTrade(tradeId: string, closePrice: number, reason: string): Promise<ExecutionResult> {
    if (!this.dryRun) {
      logger.error(LIVE_NOT_AVAILABLE);
      return { success: false, message: LIVE_NOT_AVAILABLE };
    }

    logger.info(`📝 [PAPER] Close ${tradeId} @ ${closePrice} (${reason})`);
    return { success: true, tradeId, message: `[PAPER] Trade closed at ${closePrice}`, executedPrice: closePrice };
  }

  private generateTradeId(): string {
    return `TRADE_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }
}

export const tradeExecutor = new TradeExecutor(config.dryRun);
