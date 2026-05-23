/**
 * coinbase.ts - Coinbase Advanced Trade REST + WebSocket client
 *
 * Docs: https://docs.cdp.coinbase.com/advanced-trade/reference
 *
 * Auth: HMAC-SHA256 over timestamp + method + path + body
 * Headers: CB-ACCESS-KEY, CB-ACCESS-SIGN, CB-ACCESS-TIMESTAMP
 */

import crypto from 'crypto';
import fetch from 'node-fetch';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { IExchangeClient, OrderResult, OrderSide, PriceSnapshot } from './types';

const REST_BASE = 'https://api.coinbase.com';
const WS_URL    = 'wss://advanced-trade-ws.coinbase.com';

export class CoinbaseClient extends EventEmitter implements IExchangeClient {
  private readonly apiKey:    string;
  private readonly apiSecret: string;
  private ws: WebSocket | null = null;
  public  readonly prices: Record<string, PriceSnapshot> = {};

  constructor(apiKey: string, apiSecret: string) {
    super();
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private sign(timestamp: string, method: string, path: string, body = ''): string {
    const msg = `${timestamp}${method.toUpperCase()}${path}${body}`;
    return crypto.createHmac('sha256', this.apiSecret).update(msg).digest('hex');
  }

  private headers(method: string, path: string, body = ''): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return {
      'Content-Type':        'application/json',
      'CB-ACCESS-KEY':       this.apiKey,
      'CB-ACCESS-TIMESTAMP': timestamp,
      'CB-ACCESS-SIGN':      this.sign(timestamp, method, path, body),
    };
  }

  // ── REST helpers ──────────────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body: unknown = null): Promise<T> {
    const bodyStr = body ? JSON.stringify(body) : '';
    const res = await fetch(`${REST_BASE}${path}`, {
      method,
      headers: this.headers(method, path, bodyStr),
      body:    bodyStr || undefined,
    });
    const data = await res.json() as T;
    if (!res.ok) {
      throw new Error(`Coinbase ${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
    }
    return data;
  }

  // ── Public price ──────────────────────────────────────────────────────────

  async getBestBidAsk(pair: string): Promise<PriceSnapshot> {
    const data = await this.request<{
      pricebooks?: Array<{
        bids: Array<{ price: string }>;
        asks: Array<{ price: string }>;
      }>;
    }>('GET', `/api/v3/brokerage/best_bid_ask?product_ids=${pair}`);

    const entry = data.pricebooks?.[0];
    if (!entry) throw new Error(`No price data for ${pair}`);

    return {
      exchange: 'Coinbase',
      pair,
      bid:  parseFloat(entry.bids[0]?.price ?? '0'),
      ask:  parseFloat(entry.asks[0]?.price ?? '0'),
      time: new Date(),
    };
  }

  // ── Account balance ───────────────────────────────────────────────────────

  async getBalance(currency: string): Promise<number> {
    const data = await this.request<{
      accounts?: Array<{
        currency:          string;
        available_balance: { value: string };
      }>;
    }>('GET', '/api/v3/brokerage/accounts');

    const acct = data.accounts?.find(a => a.currency === currency);
    return acct ? parseFloat(acct.available_balance.value) : 0;
  }

  // ── Place market order ────────────────────────────────────────────────────

  async placeMarketOrder(side: OrderSide, pair: string, quantity: number): Promise<OrderResult> {
    const clientOrderId = `arb-cb-${Date.now()}`;
    const body = {
      client_order_id: clientOrderId,
      product_id:      pair,
      side:            side.toUpperCase(),
      order_configuration: {
        market_market_ioc: side === 'buy'
          ? { quote_size: quantity.toFixed(2) }   // USD amount
          : { base_size:  quantity.toFixed(8) },  // coin amount
      },
    };

    const data = await this.request<{
      success:        boolean;
      order_id?:      string;
      error_response?: unknown;
    }>('POST', '/api/v3/brokerage/orders', body);

    if (!data.success || !data.order_id) {
      throw new Error(`Coinbase order failed: ${JSON.stringify(data.error_response)}`);
    }

    return { exchange: 'Coinbase', orderId: data.order_id, side, pair };
  }

  async getOrder(orderId: string): Promise<unknown> {
    return this.request('GET', `/api/v3/brokerage/orders/historical/${orderId}`);
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    return this.request('POST', '/api/v3/brokerage/orders/batch_cancel', {
      order_ids: [orderId],
    });
  }

  // ── WebSocket for live prices ─────────────────────────────────────────────

  connectWebSocket(pairs: string[]): void {
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      const ts = Math.floor(Date.now() / 1000).toString();
      const subscribeMsg = {
        type:        'subscribe',
        product_ids: pairs,
        channel:     'ticker',
        api_key:     this.apiKey,
        timestamp:   ts,
        signature:   this.sign(ts, 'GET', '/ws/ticker'),
      };
      (this.ws as WebSocket).send(JSON.stringify(subscribeMsg));
      this.emit('connected');
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          channel?: string;
          events?:  Array<{
            tickers?: Array<{
              product_id: string;
              best_bid:   string;
              best_ask:   string;
            }>;
          }>;
        };

        if (msg.channel === 'ticker' && msg.events) {
          for (const event of msg.events) {
            for (const ticker of (event.tickers ?? [])) {
              const snapshot: PriceSnapshot = {
                exchange: 'Coinbase',
                pair:     ticker.product_id,
                bid:      parseFloat(ticker.best_bid),
                ask:      parseFloat(ticker.best_ask),
                time:     new Date(),
              };
              this.prices[ticker.product_id] = snapshot;
              this.emit('price', snapshot);
            }
          }
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
