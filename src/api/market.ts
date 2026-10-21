import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface PriceData {
  pair: string;
  bid: number;
  ask: number;
  timestamp: Date;
  spread: number;
}

export interface CandleData {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export class MarketDataClient {
  private client: AxiosInstance;
  private baseURL = 'https://api.example.com/market'; // Replace with actual market data API
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private cacheTTL = 60000; // 1 minute

  constructor() {
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 5000,
    });

    this.client.interceptors.request.use((cfg) => {
      logger.debug(`Market API Request: ${cfg.url}`);
      return cfg;
    });

    this.client.interceptors.response.use(
      (res) => {
        logger.debug(`Market API Response: ${res.status}`);
        return res;
      },
      (err) => {
        logger.error('Market API Error:', {
          status: err.response?.status,
          message: err.message,
        });
        return Promise.reject(err);
      }
    );
  }

  private getCacheKey(pair: string, timeframe?: string): string {
    return timeframe ? `${pair}_${timeframe}` : pair;
  }

  private getFromCache(key: string): any | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    const isExpired = Date.now() - cached.timestamp > this.cacheTTL;
    if (isExpired) {
      this.cache.delete(key);
      return null;
    }

    return cached.data;
  }

  private setCache(key: string, data: any): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  async getCurrentPrice(pair: string): Promise<PriceData> {
    try {
      const cacheKey = this.getCacheKey(pair);
      const cached = this.getFromCache(cacheKey);

      if (cached) {
        logger.debug(`✅ Price from cache: ${pair}`);
        return cached;
      }

      // TODO: Replace with actual market data API call
      // For now, return mock data
      const mockData: PriceData = {
        pair,
        bid: 1.0950,
        ask: 1.0952,
        timestamp: new Date(),
        spread: 0.0002,
      };

      this.setCache(cacheKey, mockData);
      logger.info(`✅ Current price fetched: ${pair} → ${mockData.bid}`);

      return mockData;
    } catch (error) {
      logger.error(`Failed to fetch price for ${pair}:`, error);
      throw error;
    }
  }

  async getCandles(
    pair: string,
    timeframe: string = '1H',
    limit: number = 100
  ): Promise<CandleData[]> {
    try {
      const cacheKey = this.getCacheKey(pair, timeframe);
      const cached = this.getFromCache(cacheKey);

      if (cached) {
        logger.debug(`✅ Candles from cache: ${pair} ${timeframe}`);
        return cached;
      }

      // TODO: Replace with actual market data API call
      // For now, return mock data
      const mockCandles: CandleData[] = [];
      let basePrice = 1.0950;

      for (let i = limit; i > 0; i--) {
        mockCandles.push({
          timestamp: new Date(Date.now() - i * 3600000),
          open: basePrice,
          high: basePrice + 0.0050,
          low: basePrice - 0.0050,
          close: basePrice + 0.0025,
          volume: 1000000,
        });
        basePrice += (Math.random() - 0.5) * 0.0100;
      }

      this.setCache(cacheKey, mockCandles);
      logger.info(`✅ Candles fetched: ${pair} ${timeframe} (${mockCandles.length})`);

      return mockCandles;
    } catch (error) {
      logger.error(`Failed to fetch candles for ${pair}:`, error);
      throw error;
    }
  }

  async calculateATR(pair: string, period: number = 14): Promise<number> {
    try {
      const candles = await this.getCandles(pair, '1H', period + 10);

      let tr_sum = 0;
      for (let i = 1; i < candles.length; i++) {
        const curr = candles[i];
        const prev = candles[i - 1];

        const tr1 = curr.high - curr.low;
        const tr2 = Math.abs(curr.high - prev.close);
        const tr3 = Math.abs(curr.low - prev.close);

        const tr = Math.max(tr1, tr2, tr3);
        tr_sum += tr;
      }

      const atr = tr_sum / period;
      const atrPips = atr / 0.0001; // Convert to pips for forex

      logger.info(`✅ ATR calculated: ${pair} → ${atrPips.toFixed(2)} pips`);

      return atrPips;
    } catch (error) {
      logger.error(`Failed to calculate ATR for ${pair}:`, error);
      throw error;
    }
  }

  async validateConnection(): Promise<boolean> {
    try {
      await this.getCurrentPrice('EURUSD');
      logger.info('✅ Market API connection validated');
      return true;
    } catch (error) {
      logger.error('❌ Market API connection failed');
      return false;
    }
  }

  clearCache(): void {
    this.cache.clear();
    logger.info('✅ Market data cache cleared');
  }
}

// Create singleton instance
export const marketClient = new MarketDataClient();
