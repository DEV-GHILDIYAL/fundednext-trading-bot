import { logger } from '../utils/logger';
import { config } from '../config';
import { Validator } from '../utils/validator';
import { Calculator } from '../utils/calculator';
import { TradeSignal } from '../strategies/entrySignalGenerator';
import { marketClient, MarketDataSource } from '../api/market';
import { mt5Bridge, Mt5BridgeClient } from '../api/mt5Bridge';

export interface ExecutionResult {
  success: boolean;
  tradeId?: string;
  /** MT5 position ticket (live mode) */
  ticket?: number;
  message: string;
  executedAt?: Date;
  executedPrice?: number;
  /** Position size in units (oz for gold) */
  quantity?: number;
  lots?: number;
  /** $ lost if the stop is hit */
  riskAmount?: number;
  error?: string;
}

/**
 * PAPER (DRY_RUN=true): fills simulated at the current bid/ask — works with sim or MT5 prices.
 * LIVE  (DRY_RUN=false): real market orders on the MT5 account via the bridge; SL/TP are set on the order.
 */
export class TradeExecutor {
  constructor(
    private readonly dryRun: boolean = config.dryRun,
    private readonly market: MarketDataSource = marketClient,
    private readonly bridge: Mt5BridgeClient = mt5Bridge
  ) {}

  get isDryRun(): boolean {
    return this.dryRun;
  }

  /** Live trading needs real prices; refuse LIVE on the simulated feed */
  get liveBlockedReason(): string | null {
    if (this.dryRun) return null;
    if (this.market.isSimulated) return 'DRY_RUN=false requires DATA_SOURCE=mt5 (refusing live orders on simulated prices)';
    return null;
  }

  async executeTrade(signal: TradeSignal): Promise<ExecutionResult> {
    if (signal.signal === 'SKIP') {
      return { success: false, message: `Trade skipped: ${signal.reasoning}` };
    }

    try {
      this.validateSignal(signal);

      const spec = await this.market.getSymbolSpec(signal.pair);
      const sizing = Calculator.calculateLots(config.riskPerTrade, signal.entryPrice, signal.stopLoss, spec);
      if (sizing.lots <= 0) {
        return {
          success: false,
          message: `Risk $${config.riskPerTrade} is too small for the minimum lot ${spec.volumeMin} at this stop distance`,
        };
      }
      Validator.validateQuantity(sizing.units, 'Position size');

      return this.dryRun ? this.paperOrder(signal, sizing) : await this.liveOrder(signal, sizing);
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
    // The strategy sets the TP; only reject nonsense (reward below 1R or above the strategy's ratio)
    const target = signal.riskRewardRatio > 0 ? signal.riskRewardRatio : config.profitRatio;
    Validator.validateRRRange(reward / risk, 1, target + 0.02);
  }

  private paperOrder(signal: TradeSignal, sizing: { lots: number; units: number; risk: number }): ExecutionResult {
    const tradeId = `PAPER_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    logger.info(`📝 [PAPER] ${signal.signal} ${signal.pair} @ ${signal.entryPrice}`, {
      tradeId,
      sl: signal.stopLoss,
      tp: signal.takeProfit,
      lots: sizing.lots,
      risk: `$${sizing.risk}`,
    });
    return {
      success: true,
      tradeId,
      message: `[PAPER] ${signal.signal} ${signal.pair} opened`,
      executedAt: new Date(),
      executedPrice: signal.entryPrice,
      quantity: sizing.units,
      lots: sizing.lots,
      riskAmount: sizing.risk,
    };
  }

  private async liveOrder(signal: TradeSignal, sizing: { lots: number; units: number; risk: number }): Promise<ExecutionResult> {
    const blocked = this.liveBlockedReason;
    if (blocked) return { success: false, message: blocked };

    const side = signal.signal === 'BUY' ? 'BUY' : 'SELL';
    const result = await this.bridge.order({
      symbol: signal.pair,
      side,
      volume: sizing.lots,
      sl: signal.stopLoss,
      tp: signal.takeProfit,
    });
    const ticket = result.ticket ?? result.order;
    const fill = result.price || signal.entryPrice;
    const risk = parseFloat((Math.abs(fill - signal.stopLoss) * sizing.units).toFixed(2));
    logger.info(`✅ [LIVE] ${side} ${sizing.lots} ${signal.pair} filled @ ${fill} (ticket ${ticket}, risk $${risk})`);
    return {
      success: true,
      tradeId: `MT5_${ticket}`,
      ticket,
      message: `[LIVE] ${side} ${signal.pair} opened (ticket ${ticket})`,
      executedAt: new Date(),
      executedPrice: fill,
      quantity: sizing.units,
      lots: sizing.lots,
      riskAmount: risk,
    };
  }

  /** Close at market. Paper: at the given price. Live: sends a closing order and returns the fill. */
  async closeTrade(tradeId: string, closePrice: number, reason: string, ticket?: number): Promise<ExecutionResult> {
    if (this.dryRun || ticket === undefined) {
      logger.info(`📝 [PAPER] Close ${tradeId} @ ${closePrice} (${reason})`);
      return { success: true, tradeId, message: `[PAPER] Trade closed at ${closePrice}`, executedPrice: closePrice };
    }
    try {
      const result = await this.bridge.close(ticket);
      logger.info(`✅ [LIVE] Closed ticket ${ticket} @ ${result.price} (${reason})`);
      return { success: true, tradeId, ticket, message: `[LIVE] Closed at ${result.price}`, executedPrice: result.price };
    } catch (error) {
      logger.error(`[LIVE] Close failed for ticket ${ticket}`, error);
      return { success: false, tradeId, ticket, message: 'Close failed', error: (error as Error).message };
    }
  }
}

export const tradeExecutor = new TradeExecutor(config.dryRun);
