/**
 * coinbase.ts - Coinbase client
 *
 * Public prices:  Coinbase Exchange public API (no auth required)
 *                 GET /products/{id}/ticker
 *
 * Private orders: Coinbase Advanced Trade API (auth required)
 *                 POST /api/v3/brokerage/orders
 *
 * Order type: limit_limit_gtc (Good-Till-Cancelled limit order)
 *   - Qualifies as a maker order when placed inside the spread
 *   - Maker fee: 0.40% (vs 0.60% taker) at lowest volume tier
 *   - post_only flag ensures the order is rejected rather than crossing
 *     as a taker if the market moves before placement
 *
 * Coinbase Advanced Trade WebSocket requires signed auth on every subscription
 * so this client polls the public Exchange API instead and emits price events.
 */

import crypto from 'crypto';
import fetch from 'node-fetch';
import { EventEmitter } from 'events';
import type { IExchangeClient, OrderResult, OrderSide, PriceSnapshot } from './types';

const PUBLIC_BASE  = 'https://api.exchange.coinbase.com';
const PRIVATE_BASE = 'https://api.coinbase.com';

export class CoinbaseClient extends EventEmitter implements IExchangeClient {
  private readonly apiKey:    string;
  private readonly apiSecret: string;
  public  readonly prices: Record<string, PriceSnapshot> = {};

  constructor(apiKey: string, apiSecret: string) {
    super();
    this.apiKey    = apiKey;
    this.apiSecret = apiSecret;
  }

  // -- Auth ------------------------------------------------------------------

  private sign(timestamp: string, method: string, path: string, body = ''): string {
    const msg = `${timestamp}${method.toUpperCase()}${path}${body}`;
    return crypto.createHmac('sha256', this.apiSecret).update(msg).digest('hex');
  }

  private authHeaders(method: string, path: string, body = ''): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return {
      'Content-Type':        'application/json',
      'CB-ACCESS-KEY':       this.apiKey,
      'CB-ACCESS-TIMESTAMP': timestamp,
      'CB-ACCESS-SIGN':      this.sign(timestamp, method, path, body),
    };
  }

  // -- REST helpers ----------------------------------------------------------

  private async publicRequest<T>(path: string): Promise<T> {
    const res = await fetch(`${PUBLIC_BASE}${path}`, {
      headers: { 'User-Agent': 'arb-bot/2.0' },
    });
    if (!res.ok) throw new Error(`Coinbase public ${path} -> ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  private async privateRequest<T>(method: string, path: string, body: unknown = null): Promise<T> {
    const bodyStr = body ? JSON.stringify(body) : '';
    const res = await fetch(`${PRIVATE_BASE}${path}`, {
      method,
      headers: this.authHeaders(method, path, bodyStr),
      body:    bodyStr || undefined,
    });
    const data = await res.json() as T;
    if (!res.ok) throw new Error(`Coinbase ${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  // -- Public price ----------------------------------------------------------

  async getBestBidAsk(pair: string): Promise<PriceSnapshot> {
    const data = await this.publicRequest<{ bid: string; ask: string }>(`/products/${pair}/ticker`);
    return {
      exchange: 'Coinbase',
      pair,
      bid:  parseFloat(data.bid),
      ask:  parseFloat(data.ask),
      time: new Date(),
    };
  }

  // -- Account balance -------------------------------------------------------

  async getBalance(currency: string): Promise<number> {
    const data = await this.privateRequest<{ accounts?: Array<{ currency: string; available_balance: { value: string } }> }>(
      'GET', '/api/v3/brokerage/accounts'
    );
    const acct = (data.accounts ?? []).find(a => a.currency === currency);
    return acct ? parseFloat(acct.available_balance.value) : 0;
  }

  // -- Place limit (maker) order ---------------------------------------------
  //
  // Uses limit_limit_gtc with post_only=true.
  // post_only guarantees the order is never filled as a taker — if the market
  // has moved and the order would cross, Coinbase rejects it rather than
  // charging the higher taker fee.
  //
  // limitPrice for buys:  slightly above current best ask (to sit at top of book)
  // limitPrice for sells: slightly below current best bid
  // The engine calculates these via limitOffsetPct before calling this method.

  async placeLimitOrder(side: OrderSide, pair: string, quantity: number, limitPrice: number): Promise<OrderResult> {
    const clientOrderId = `arb-cb-${Date.now()}`;
    const body = {
      client_order_id: clientOrderId,
      product_id:      pair,
      side:            side.toUpperCase(),
      order_configuration: {
        limit_limit_gtc: {
          base_size:   quantity.toFixed(8),
          limit_price: limitPrice.toFixed(2),
          post_only:   true,
        },
      },
    };

    const data = await this.privateRequest<{
      success:         boolean;
      order_id?:       string;
      error_response?: unknown;
    }>('POST', '/api/v3/brokerage/orders', body);

    if (!data.success || !data.order_id) {
      throw new Error(`Coinbase limit order failed: ${JSON.stringify(data.error_response)}`);
    }

    return { exchange: 'Coinbase', orderId: data.order_id, side, pair, orderType: 'limit', limitPrice };
  }

  async getOrder(orderId: string): Promise<unknown> {
    return this.privateRequest('GET', `/api/v3/brokerage/orders/historical/${orderId}`);
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    return this.privateRequest('POST', '/api/v3/brokerage/orders/batch_cancel', { order_ids: [orderId] });
  }

  // -- Price polling (emulates WebSocket interface) --------------------------

  connectWebSocket(pairs: string[]): void {
    const POLL_MS = 2000;
    const poll = async (): Promise<void> => {
      for (const pair of pairs) {
        try {
          const snapshot = await this.getBestBidAsk(pair);
          this.prices[pair] = snapshot;
          this.emit('price', snapshot);
        } catch (err) {
          this.emit('error', err as Error);
        }
      }
    };
    this.emit('connected');
    void poll();
    setInterval(() => void poll(), POLL_MS);
  }
}
