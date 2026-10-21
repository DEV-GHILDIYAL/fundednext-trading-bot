import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface AccountInfo {
  accountId: string;
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  marginLevel: number;
}

export interface OpenPosition {
  positionId: string;
  pair: string;
  type: 'BUY' | 'SELL';
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
}

export interface TradeRequest {
  pair: string;
  type: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
}

export class FundedNextClient {
  private client: AxiosInstance;
  private apiKey: string;
  private accountId: string;
  private baseURL = 'https://api.fundednext.com/v1';

  constructor(apiKey: string, accountId: string) {
    this.apiKey = apiKey;
    this.accountId = accountId;

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    // Add request logging
    this.client.interceptors.request.use((cfg) => {
      logger.debug(`FundedNext API Request: ${cfg.method?.toUpperCase()} ${cfg.url}`);
      return cfg;
    });

    // Add response logging
    this.client.interceptors.response.use(
      (res) => {
        logger.debug(`FundedNext API Response: ${res.status}`, { data: res.data });
        return res;
      },
      (err) => {
        logger.error('FundedNext API Error:', {
          status: err.response?.status,
          message: err.response?.data?.message || err.message,
        });
        return Promise.reject(err);
      }
    );
  }

  async getAccountInfo(): Promise<AccountInfo> {
    try {
      const response = await this.client.get(`/accounts/${this.accountId}`);
      logger.info('✅ Account info fetched');
      return response.data;
    } catch (error) {
      logger.error('Failed to fetch account info:', error);
      throw error;
    }
  }

  async getOpenPositions(): Promise<OpenPosition[]> {
    try {
      const response = await this.client.get(`/accounts/${this.accountId}/positions`);
      logger.info(`✅ Fetched ${response.data.length} open positions`);
      return response.data;
    } catch (error) {
      logger.error('Failed to fetch open positions:', error);
      throw error;
    }
  }

  async getTradeHistory(limit: number = 50): Promise<any[]> {
    try {
      const response = await this.client.get(`/accounts/${this.accountId}/trades`, {
        params: { limit },
      });
      logger.info(`✅ Fetched ${response.data.length} trades from history`);
      return response.data;
    } catch (error) {
      logger.error('Failed to fetch trade history:', error);
      throw error;
    }
  }

  async placeTrade(trade: TradeRequest): Promise<any> {
    try {
      const payload = {
        pair: trade.pair,
        type: trade.type,
        quantity: trade.quantity,
        entryPrice: trade.entryPrice,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
      };

      const response = await this.client.post(
        `/accounts/${this.accountId}/trades`,
        payload
      );

      logger.info(`✅ Trade placed: ${trade.type} ${trade.pair}`, {
        quantity: trade.quantity,
        entry: trade.entryPrice,
      });

      return response.data;
    } catch (error) {
      logger.error('Failed to place trade:', error);
      throw error;
    }
  }

  async closeTrade(positionId: string, quantity?: number): Promise<any> {
    try {
      const response = await this.client.post(
        `/accounts/${this.accountId}/positions/${positionId}/close`,
        { quantity }
      );

      logger.info(`✅ Position closed: ${positionId}`);
      return response.data;
    } catch (error) {
      logger.error('Failed to close position:', error);
      throw error;
    }
  }

  async updateStopLoss(positionId: string, newSL: number): Promise<any> {
    try {
      const response = await this.client.patch(
        `/accounts/${this.accountId}/positions/${positionId}`,
        { stopLoss: newSL }
      );

      logger.info(`✅ Stop loss updated: ${positionId} → ${newSL}`);
      return response.data;
    } catch (error) {
      logger.error('Failed to update stop loss:', error);
      throw error;
    }
  }

  async updateTakeProfit(positionId: string, newTP: number): Promise<any> {
    try {
      const response = await this.client.patch(
        `/accounts/${this.accountId}/positions/${positionId}`,
        { takeProfit: newTP }
      );

      logger.info(`✅ Take profit updated: ${positionId} → ${newTP}`);
      return response.data;
    } catch (error) {
      logger.error('Failed to update take profit:', error);
      throw error;
    }
  }

  async validateConnection(): Promise<boolean> {
    try {
      await this.getAccountInfo();
      logger.info('✅ FundedNext API connection validated');
      return true;
    } catch (error) {
      logger.error('❌ FundedNext API connection failed');
      return false;
    }
  }
}

// Create singleton instance
export const fundednextClient = new FundedNextClient(
  config.fundednextApiKey,
  config.fundednextAccountId
);
