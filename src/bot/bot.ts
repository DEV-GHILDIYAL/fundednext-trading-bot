import { logger } from '../utils/logger';
import { config } from '../config';
import { marketClient } from '../api/market';
import { claudeClient } from '../api/claude';
import { EntrySignalGenerator } from '../strategies/entrySignalGenerator';
import { tradeExecutor } from '../services/tradeExecutor';
import { tradeMonitor } from '../services/tradeMonitor';
import { riskManager } from '../services/riskManager';
import { PAIR_LIST, TradingPair } from '../constants/pairs';

export class TradingBot {
  private isRunning: boolean = false;
  private currentCycle: number = 0;

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    logger.info('╔════════════════════════════════════════╗');
    logger.info('║     🤖 FundedNext Trading Bot Started ║');
    logger.info('╚════════════════════════════════════════╝');
    logger.info('');

    this.isRunning = true;

    try {
      // Initial setup
      await this.validateSetup();

      // Start main loop
      await this.mainLoop();
    } catch (error) {
      logger.error('Bot startup failed:', error);
      this.stop();
    }
  }

  /**
   * Stop the bot
   */
  stop(): void {
    this.isRunning = false;
    logger.info('🛑 Bot stopped');
  }

  /**
   * Validate initial setup
   */
  private async validateSetup(): Promise<void> {
    logger.info('Step 1: Validating setup...');

    // Check API connections
    const marketConnected = await marketClient.validateConnection();
    const claudeConnected = await claudeClient.validateConnection();

    if (!marketConnected) {
      logger.warn('⚠️ Market data connection failed - using mock data');
    }

    if (!claudeConnected) {
      logger.warn('⚠️ Claude API connection failed');
    }

    logger.info('✅ Setup validation complete');
    logger.info('');
  }

  /**
   * Main bot loop
   */
  private async mainLoop(): Promise<void> {
    logger.info('Step 2: Starting main loop');
    logger.info('');

    while (this.isRunning) {
      this.currentCycle++;
      const cycleStart = Date.now();

      try {
        // Check if within trading hours
        if (!this.isWithinTradingHours()) {
          await this.sleep(60000); // Check every minute
          continue;
        }

        logger.info(`📍 Cycle #${this.currentCycle} started`);

        // Scan all trading pairs
        await this.scanAllPairs();

        // Monitor open positions
        await this.monitorPositions();

        // Log cycle stats
        this.logCycleStats(Date.now() - cycleStart);
      } catch (error) {
        logger.error('Error in main loop:', error);
      }

      // Wait before next cycle (5 seconds)
      await this.sleep(5000);
    }
  }

  /**
   * Check if within London trading hours (IST: 1:30 PM - 5:00 PM)
   */
  private isWithinTradingHours(): boolean {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const time = hours * 60 + minutes;

    const openTime = config.londonOpenHour * 60 + config.londonOpenMinute; // 13:30 = 810
    const closeTime = config.londonCloseHour * 60 + config.londonCloseMinute; // 17:00 = 1020

    const withinHours = time >= openTime && time <= closeTime;

    if (!withinHours && this.currentCycle % 60 === 0) {
      // Log every hour outside trading hours
      logger.debug(`⏰ Outside trading hours (${hours}:${minutes < 10 ? '0' : ''}${minutes})`);
    }

    return withinHours;
  }

  /**
   * Scan all trading pairs for signals
   */
  private async scanAllPairs(): Promise<void> {
    for (const pair of PAIR_LIST) {
      try {
        await this.scanPair(pair);
      } catch (error) {
        logger.error(`Error scanning ${pair}:`, error);
      }

      // Small delay between pairs
      await this.sleep(100);
    }
  }

  /**
   * Scan individual pair
   */
  private async scanPair(pair: TradingPair): Promise<void> {
    try {
      // Get current price
      const priceData = await marketClient.getCurrentPrice(pair);

      // Get candle history
      const candles = await marketClient.getCandles(pair, '1H', 50);

      // Calculate ATR
      const atrPips = await marketClient.calculateATR(pair, 14);

      // Get yesterday's high/low (use last candle's high/low as proxy)
      const yesterdayCandle = candles[candles.length - 2];
      const yesterdayHigh = yesterdayCandle?.high || priceData.bid + 0.005;
      const yesterdayLow = yesterdayCandle?.low || priceData.bid - 0.005;

      // Generate signal
      const signal = EntrySignalGenerator.generateTradeSignal(
        pair,
        priceData,
        yesterdayHigh,
        yesterdayLow,
        candles,
        atrPips
      );

      // Check risk limits
      const riskCheck = riskManager.canPlaceTrade();
      if (!riskCheck.allowed) {
        logger.info(`⛔ Trade blocked: ${riskCheck.reason}`);
        return;
      }

      // Execute if signal is BUY or SELL
      if (signal.signal !== 'SKIP') {
        logger.info(
          `🎯 Signal found: ${signal.signal} ${pair} @ ${signal.entryPrice} (confidence: ${signal.confidence})`
        );

        const result = await tradeExecutor.executeTrade(signal);

        if (result.success) {
          logger.info(`✅ Trade executed: ${result.message}`);

          // Record in risk manager
          riskManager.recordTrade(0); // Assuming 0 initial PnL
        } else {
          logger.warn(`❌ Trade execution failed: ${result.message}`);
        }
      }
    } catch (error) {
      logger.error(`Error scanning pair ${pair}:`, error);
    }
  }

  /**
   * Monitor open positions
   */
  private async monitorPositions(): Promise<void> {
    const openTrades = tradeMonitor.getOpenTrades();

    if (openTrades.length === 0) {
      return;
    }

    logger.info(`👁️ Monitoring ${openTrades.length} open position(s)`);

    for (const trade of openTrades) {
      try {
        // Get current price
        const priceData = await marketClient.getCurrentPrice(
          trade.pair as TradingPair
        );

        // Update trade price
        tradeMonitor.updateTradePrice(trade.tradeId, priceData.bid);

        // Check daily loss limit
        if (tradeMonitor.calculateTotalPnL() <= -config.maxDailyLoss) {
          logger.error('❌ DAILY LOSS LIMIT HIT! Closing all positions.');
          await this.closeAllPositions('Daily loss limit reached');
          riskManager.resetDaily();
          break;
        }

        // Check safety buffer
        const safetyStatus = tradeMonitor.getSafetyBufferStatus(
          config.safetyBuffer
        );
        if (safetyStatus.hit) {
          logger.warn(`⚠️ Safety buffer hit. Current loss: $${safetyStatus.currentLoss}`);
        }
      } catch (error) {
        logger.error(`Error monitoring trade ${trade.tradeId}:`, error);
      }

      await this.sleep(100);
    }
  }

  /**
   * Close all open positions
   */
  private async closeAllPositions(reason: string): Promise<void> {
    const openTrades = tradeMonitor.getOpenTrades();

    logger.warn(`🔴 Force closing ${openTrades.length} position(s): ${reason}`);

    for (const trade of openTrades) {
      try {
        await tradeExecutor.closeTrade(
          trade.tradeId,
          trade.currentPrice,
          reason
        );
        tradeMonitor.removeTrade(trade.tradeId);
      } catch (error) {
        logger.error(`Error closing trade ${trade.tradeId}:`, error);
      }
    }
  }

  /**
   * Log cycle statistics
   */
  private logCycleStats(durationMs: number): void {
    const stats = tradeMonitor.getStatistics();
    const riskStatus = riskManager.getStatus();

    if (this.currentCycle % 10 === 0) {
      // Log every 10 cycles
      logger.info(`📊 Cycle #${this.currentCycle} complete (${durationMs}ms)`);
      logger.info(`   Positions: ${stats.openTrades} | P&L: $${stats.totalPnL.toFixed(2)}`);
      logger.info(
        `   Trades: ${riskStatus.tradesExecuted}/${config.maxTradesPerDay} | Loss: $${Math.abs(riskStatus.dailyLossAmount).toFixed(2)}/${config.maxDailyLoss}`
      );
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton
export const bot = new TradingBot();
