/**
 * binance.ts - Binance Spot REST + WebSocket client
 *
 * Docs:
 *   REST:      https://developers.binance.com/docs/binance-spot-api-docs/rest-api
 *   WebSocket: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
 *
 * Auth: HMAC-SHA256 over query string, appended as &signature=
 * Headers: X-MBX-APIKEY
 *
 * Pair translation:
 *   Coinbase -> Binance
 *   BTC-USD  -> BTCUSDT  (Binance uses USDT, not USD)
 *   ETH-USD  -> ETHUSDT
 *   SOL-USD  -> SOLUSDT
 *
 * US users: set BINANCE_BASE_URL=https://api.binance.us and
 *           BINANCE_WS_URL=wss://stream.binance.us:9443 in .env
 */

import crypto from 'crypto';
import fetch from 'node-fetch';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { IExchangeClient, OrderResult, OrderSide, PriceSnapshot } from './types';

const DEFAULT_REST_BASE = 'https://api.binance.com';
const DEFAULT_WS_BASE   = 'wss://stream.binance.com:9443';

export const SYMBOL_MAP: Record<string, string> = {
  'BTC-USD': 'BTCUSDT',
  'ETH-USD': 'ETHUSDT',
  'SOL-USD': 'SOLUSDT',
  'BNB-USD': 'BNBUSDT',
  'XRP-USD': 'XRPUSDT',
};

const REVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SYMBOL_MAP).map(([k, v]) => [v, k])
);

export class BinanceClient extends EventEmitter implements IExchangeClient {
  private readonly apiKey:    string;
  private readonly apiSecret: string;
  private readonly restBase:  string;
  private readonly wsBase:    string;
  private ws: WebSocket | null = null;
  public  readonly prices: Record<string, PriceSnapshot> = {};

  constructor(apiKey: string, apiSecret: string) {
    super();
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
    // Read overrides after .env has been loaded by the caller
    this.restBase  = process.env['BINANCE_BASE_URL'] ?? DEFAULT_REST_BASE;
    this.wsBase    = process.env['BINANCE_WS_URL']   ?? DEFAULT_WS_BASE;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private sign(queryString: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  // ── REST helpers ──────────────────────────────────────────────────────────

  private async publicRequest<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const qs  = new URLSearchParams(params).toString();
    const url = `${this.restBase}${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url);
    const data = await res.json() as T & { code?: number; msg?: string };
    if (data.code !== undefined && data.code < 0) {
      throw new Error(`Binance ${path}: [${data.code}] ${data.msg}`);
    }
    return data;
  }

  private async privateRequest<T>(
    method: string,
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const allParams = { ...params, timestamp: Date.now().toString() };
    const qs        = new URLSearchParams(allParams).toString();
    const signature = this.sign(qs);
    const url       = `${this.restBase}${path}?${qs}&signature=${signature}`;

    const res = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
    });
    const data = await res.json() as T & { code?: number; msg?: string };
    if (data.code !== undefined && data.code < 0) {
      throw new Error(`Binance ${method} ${path}: [${data.code}] ${data.msg}`);
    }
    return data;
  }

  // ── Public price ──────────────────────────────────────────────────────────

  async getBestBidAsk(pair: string): Promise<PriceSnapshot> {
    const symbol = SYMBOL_MAP[pair];
    if (!symbol) throw new Error(`No Binance symbol mapping for ${pair}`);

    const data = await this.publicRequest<{
      symbol:   string;
      bidPrice: string;
      askPrice: string;
    }>('/api/v3/ticker/bookTicker', { symbol });

    return {
      exchange: 'Binance',
      pair,
      bid:  parseFloat(data.bidPrice),
      ask:  parseFloat(data.askPrice),
      time: new Date(),
    };
  }

  // ── Account balance ───────────────────────────────────────────────────────

  async getBalance(currency: string): Promise<number> {
    const asset = currency === 'USD' ? 'USDT' : currency;

    const data = await this.privateRequest<{
      balances: Array<{ asset: string; free: string; locked: string }>;
    }>('GET', '/api/v3/account');

    const entry = data.balances.find(b => b.asset === asset);
    return entry ? parseFloat(entry.free) : 0;
  }

  // ── Place market order ────────────────────────────────────────────────────

  async placeMarketOrder(side: OrderSide, pair: string, quantity: number): Promise<OrderResult> {
    const symbol = SYMBOL_MAP[pair];
    if (!symbol) throw new Error(`No Binance symbol mapping for ${pair}`);

    const params: Record<string, string> = {
      symbol,
      side:  side.toUpperCase(),
      type:  'MARKET',
      // Buy with a fixed USDT amount; sell a fixed coin quantity
      ...(side === 'buy'
        ? { quoteOrderQty: quantity.toFixed(2) }
        : { quantity:      quantity.toFixed(8) }),
    };

    const data = await this.privateRequest<{
      orderId:       number;
      clientOrderId: string;
      status:        string;
    }>('POST', '/api/v3/order', params);

    return {
      exchange: 'Binance',
      orderId:  data.orderId.toString(),
      side,
      pair,
    };
  }

  async getOrder(orderId: string, pair?: string): Promise<unknown> {
    const symbol = pair ? SYMBOL_MAP[pair] : undefined;
    if (!symbol) throw new Error(`Binance getOrder requires a pair`);
    return this.privateRequest('GET', '/api/v3/order', { symbol, orderId });
  }

  async cancelOrder(orderId: string, pair?: string): Promise<unknown> {
    const symbol = pair ? SYMBOL_MAP[pair] : undefined;
    if (!symbol) throw new Error(`Binance cancelOrder requires a pair`);
    return this.privateRequest('DELETE', '/api/v3/order', { symbol, orderId });
  }

  // ── WebSocket for live prices ─────────────────────────────────────────────

  connectWebSocket(pairs: string[]): void {
    const streams = pairs
      .map(p => SYMBOL_MAP[p])
      .filter((s): s is string => Boolean(s))
      .map(sym => `${sym.toLowerCase()}@bookTicker`)
      .join('/');

    const url = `${this.wsBase}/stream?streams=${streams}`;
    this.ws   = new WebSocket(url);

    this.ws.on('open', () => this.emit('connected'));

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          data?: { s: string; b: string; a: string };
          s?:    string;
          b?:    string;
          a?:    string;
        };

        const tick = msg.data ?? msg;
        if (tick.b !== undefined && tick.a !== undefined && tick.s) {
          const cbPair = REVERSE_MAP[tick.s];
          if (!cbPair) return;

          const snapshot: PriceSnapshot = {
            exchange: 'Binance',
            pair:     cbPair,
            bid:      parseFloat(tick.b),
            ask:      parseFloat(tick.a),
            time:     new Date(),
          };
          this.prices[cbPair] = snapshot;
          this.emit('price', snapshot);
        }
      } catch { /* ignore malformed frames */ }
    });

    this.ws.on('error', (err: Error) => this.emit('error', err));
    this.ws.on('close', () => {
      this.emit('disconnected');
      setTimeout(() => this.connectWebSocket(pairs), 3000);
    });
  }
}
