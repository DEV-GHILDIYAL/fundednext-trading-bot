import axios, { AxiosError, AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface BridgeTick {
  symbol: string;
  bid: number;
  ask: number;
  time: string;
}

export interface BridgeCandle {
  /** Bar open time (MT5 server time, encoded as UTC) */
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** false for the bar that is still forming */
  closed: boolean;
}

export interface BridgeSymbolSpec {
  symbol: string;
  digits: number;
  point: number;
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  stopsLevel: number;
  spreadPoints: number;
}

export interface BridgeAccount {
  login: number;
  server: string;
  currency: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  leverage: number;
  tradeAllowed: boolean;
}

export interface BridgePosition {
  ticket: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: number;
  priceOpen: number;
  priceCurrent: number;
  sl: number;
  tp: number;
  profit: number;
  swap: number;
  magic: number;
  comment: string;
  time: string;
}

export interface BridgeOrderResult {
  retcode: number;
  comment: string;
  order: number;
  deal: number;
  volume: number;
  price: number;
  ticket?: number;
}

export interface BridgePositionHistory {
  ticket: number;
  closed: boolean;
  exitPrice?: number;
  exitReason?: 'STOP_LOSS' | 'TAKE_PROFIT' | 'STOP_OUT' | 'MANUAL_OR_BOT';
  exitTime?: string;
  profit?: number;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** HTTP client for bridge/app.py (MT5 terminal on the Windows host) */
export class Mt5BridgeClient {
  private http: AxiosInstance;

  constructor(
    baseURL: string = config.mt5BridgeUrl,
    token: string = config.mt5BridgeToken,
    timeout: number = config.mt5TimeoutMs
  ) {
    this.http = axios.create({
      baseURL,
      timeout,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  }

  private async call<T>(method: 'get' | 'post', url: string, body?: unknown, retries = method === 'get' ? 2 : 0): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = method === 'get' ? await this.http.get<T>(url) : await this.http.post<T>(url, body);
        return res.data;
      } catch (error) {
        const err = error as AxiosError<{ detail?: unknown }>;
        const status = err.response?.status;
        const detail = err.response?.data?.detail;
        const message =
          typeof detail === 'string'
            ? detail
            : detail && typeof detail === 'object' && 'message' in detail
              ? String((detail as { message: unknown }).message)
              : err.message;
        // Retry only idempotent reads on network errors / 5xx
        const retryable = !status || status >= 500;
        if (attempt < retries && retryable) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw new BridgeError(`MT5 bridge ${method.toUpperCase()} ${url} failed: ${message}`, status);
      }
    }
  }

  async health(): Promise<{ ok: boolean; mock: boolean; tradeAllowed: boolean }> {
    return this.call('get', '/health', undefined, 0);
  }

  account(): Promise<BridgeAccount> {
    return this.call('get', '/account');
  }

  symbol(symbol: string): Promise<BridgeSymbolSpec> {
    return this.call('get', `/symbol/${encodeURIComponent(symbol)}`);
  }

  tick(symbol: string): Promise<BridgeTick> {
    return this.call('get', `/tick/${encodeURIComponent(symbol)}`);
  }

  /** `start` > 0 skips the newest bars (history paging; needs the bridge version with ?start=) */
  async candles(symbol: string, timeframe: string, count: number, start: number = 0): Promise<BridgeCandle[]> {
    const data = await this.call<{ candles: BridgeCandle[] }>(
      'get',
      `/candles/${encodeURIComponent(symbol)}?timeframe=${timeframe}&count=${count}${start > 0 ? `&start=${start}` : ''}`
    );
    return data.candles;
  }

  async positions(magic?: number): Promise<BridgePosition[]> {
    const q = magic !== undefined ? `?magic=${magic}` : '';
    const data = await this.call<{ positions: BridgePosition[] }>('get', `/positions${q}`);
    return data.positions;
  }

  order(req: {
    symbol: string;
    side: 'BUY' | 'SELL';
    volume: number;
    sl: number;
    tp: number;
    deviation?: number;
    magic?: number;
    comment?: string;
  }): Promise<BridgeOrderResult> {
    logger.info(`➡️ MT5 order ${req.side} ${req.volume} ${req.symbol} SL ${req.sl} TP ${req.tp}`);
    return this.call('post', '/order', {
      deviation: config.mt5DeviationPoints,
      magic: config.mt5Magic,
      comment: 'fn-bot',
      ...req,
    });
  }

  close(ticket: number): Promise<BridgeOrderResult> {
    return this.call('post', '/close', { ticket, deviation: config.mt5DeviationPoints });
  }

  /** Change SL/TP of an open position */
  modify(ticket: number, sl: number, tp: number): Promise<BridgeOrderResult> {
    logger.info(`✏️ MT5 modify ${ticket} SL ${sl} TP ${tp}`);
    return this.call('post', '/modify', { ticket, sl, tp });
  }

  positionHistory(ticket: number): Promise<BridgePositionHistory> {
    return this.call('get', `/history/position/${ticket}`);
  }
}

export const mt5Bridge = new Mt5BridgeClient();
