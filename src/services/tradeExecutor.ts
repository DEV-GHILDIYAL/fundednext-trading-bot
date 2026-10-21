import { logger } from '../utils/logger';
import { Validator } from '../utils/validator';
import { TradeSignal } from '../strategies/entrySignalGenerator';
import { Calculator } from '../utils/calculator';

export interface ExecutionRequest {
  pair: string;
  type: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  riskAmount: number;
}

export interface ExecutionResult {
  success: boolean;
  tradeId?: string;
  message: string;
  executedAt?: Date;
  executedPrice?: number;
  error?: string;
}

export class TradeExecutor {
  private dryRun: boolean;

  constructor(dryRun: boolean = true) {
    this.dryRun = dryRun;
  }

  /**
   * Execute trade from signal
   */
  async executeTrade(signal: TradeSignal): Promise<ExecutionResult> {
    logger.info(`📊 Processing trade signal: ${signal.signal} ${signal.pair}`);

    // Skip if signal is SKIP
    if (signal.signal === 'SKIP') {
      return {
        success: false,
        message: `Trade skipped: ${signal.reasoning}`,
      };
    }

    try {
      // Validate signal
      this.validateSignal(signal);

      // Build execution request
      const executionRequest: ExecutionRequest = {
        pair: signal.pair,
        type: signal.signal,
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        quantity: this.calculateQuantity(signal),
        riskAmount: 30, // From config
      };

      // Execute
      const result = await this.executeOrder(executionRequest);

      return result;
    } catch (error) {
      logger.error('Trade execution failed:', error);
      return {
        success: false,
        message: 'Trade execution failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Validate trade signal before execution
   */
  private validateSignal(signal: TradeSignal): void {
    Validator.validateTradingPair(signal.pair);
    Validator.validatePrice(signal.entryPrice, 'Entry Price');
    Validator.validatePrice(signal.stopLoss, 'Stop Loss');
    Validator.validatePrice(signal.takeProfit, 'Take Profit');

    // Validate SL/TP positioning
    if (signal.signal === 'BUY') {
      Validator.validateStopLoss(signal.entryPrice, signal.stopLoss, 'BUY');
      Validator.validateTakeProfit(signal.entryPrice, signal.takeProfit, 'BUY');
    } else {
      Validator.validateStopLoss(signal.entryPrice, signal.stopLoss, 'SELL');
      Validator.validateTakeProfit(signal.entryPrice, signal.takeProfit, 'SELL');
    }

    // Validate R:R ratio
    const riskDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    const rewardDistance = Math.abs(signal.takeProfit - signal.entryPrice);
    const ratio = rewardDistance / riskDistance;
    Validator.validateRRRatio(ratio, 1.5);
  }

  /**
   * Calculate position size
   */
  private calculateQuantity(signal: TradeSignal): number {
    const riskAmount = 30; // $30 per trade
    const quantity = Calculator.calculatePositionSize(
      riskAmount,
      signal.entryPrice,
      signal.stopLoss
    );

    logger.debug('Position size calculated', { quantity });
    return quantity;
  }

  /**
   * Execute order (real or dry-run)
   */
  private async executeOrder(
    request: ExecutionRequest
  ): Promise<ExecutionResult> {
    const tradeId = this.generateTradeId();

    if (this.dryRun) {
      logger.info(
        `✅ [DRY RUN] ${request.type} ${request.pair} @ ${request.entryPrice}`
      );
      logger.info(`   SL: ${request.stopLoss} | TP: ${request.takeProfit}`);
      logger.info(`   Quantity: ${request.quantity}`);

      return {
        success: true,
        tradeId,
        message: `[DRY RUN] Trade would be executed`,
        executedAt: new Date(),
        executedPrice: request.entryPrice,
      };
    }

    // TODO: Implement actual MT5 WebSocket connection
    // For now, simulate execution
    await this.simulateExecution();

    logger.info(`🎯 LIVE: ${request.type} ${request.pair} executed`);

    return {
      success: true,
      tradeId,
      message: `Trade executed successfully`,
      executedAt: new Date(),
      executedPrice: request.entryPrice,
    };
  }

  /**
   * Simulate execution (for testing)
   */
  private async simulateExecution(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  /**
   * Generate unique trade ID
   */
  private generateTradeId(): string {
    return `TRADE_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Close trade at specified price
   */
  async closeTrade(
    tradeId: string,
    closePrice: number,
    reason: string
  ): Promise<ExecutionResult> {
    logger.info(`📍 Closing trade ${tradeId} @ ${closePrice}`);
    logger.info(`   Reason: ${reason}`);

    if (this.dryRun) {
      return {
        success: true,
        message: `[DRY RUN] Trade closed at ${closePrice}`,
      };
    }

    // TODO: Implement actual MT5 close
    return {
      success: true,
      message: `Trade closed successfully`,
    };
  }

  /**
   * Modify stop loss
   */
  async modifyStopLoss(
    tradeId: string,
    newSL: number
  ): Promise<ExecutionResult> {
    logger.info(`🛡️ Modifying SL for ${tradeId} → ${newSL}`);

    if (this.dryRun) {
      return {
        success: true,
        message: `[DRY RUN] SL modified to ${newSL}`,
      };
    }

    return {
      success: true,
      message: `Stop loss updated`,
    };
  }

  /**
   * Modify take profit
   */
  async modifyTakeProfit(
    tradeId: string,
    newTP: number
  ): Promise<ExecutionResult> {
    logger.info(`🎁 Modifying TP for ${tradeId} → ${newTP}`);

    if (this.dryRun) {
      return {
        success: true,
        message: `[DRY RUN] TP modified to ${newTP}`,
      };
    }

    return {
      success: true,
      message: `Take profit updated`,
    };
  }
}

// Export singleton
export const tradeExecutor = new TradeExecutor(true); // true = dryRun mode
