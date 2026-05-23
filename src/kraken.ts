/**
 * kraken.ts - Kraken REST + WebSocket v2 client
 *
 * Docs: https://docs.kraken.com/api/docs/rest-api/add-order
 *
 * Auth: HMAC-SHA512 over nonce + encoded body, keyed with base64-decoded secret
 * Headers: API-Key, API-Sign
 *
 * Pair translation:
 *   Coinbase -> Kraken REST -> Kraken WS
 *   BTC-USD  -> XBTUSD     -> BTC/USD
 *   ETH-USD  -> ETHUSD     -> ETH/USD
 *   SOL-USD  -> SOLUSD     -> SOL/USD
 */

import crypto from 'crypto';
import fetch from 'node-fetch';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { IExchangeClient, OrderResult, OrderSide, PriceSnapshot } from './types';

const REST_BASE = 'https://api.kraken.com';
const WS_URL    = 'wss://ws.kraken.com/v2';

// Coinbase pair -> Kraken REST pair name
export const PAIR_MAP: Record<string, string> = {
  'BTC-USD': 'XBTUSD',
  'ETH-USD': 'ETHUSD',
  'SOL-USD': 'SOLUSD',
  'XRP-USD': 'XRPUSD',
};

// Coinbase pair -> Kraken WebSocket symbol
export const WS_PAIR_MAP: Record<string, string> = {
  'BTC-USD': 'BTC/USD',
  'ETH-USD': 'ETH/USD',
  'SOL-USD': 'SOL/USD',
  'XRP-USD': 'XRP/USD',
};

// Kraken uses non-standard currency codes internally
const CURRENCY_MAP: Record<string, string> = {
  USD: 'ZUSD',
  BTC: 'XXBT',
  ETH: 'XETH',
  SOL: 'SOL',
};

export class KrakenClient extends EventEmitter implements IExchangeClient {
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

  private sign(path: string, nonce: string, body: string): string {
    const hash   = crypto.createHash('sha256').update(nonce + body).digest();
    const msg    = Buffer.concat([Buffer.from(path), hash]);
    const secret = Buffer.from(this.apiSecret, 'base64');
    return crypto.createHmac('sha512', secret).update(msg).digest('base64');
  }

  // ── REST helpers ──────────────────────────────────────────────────────────

  private async privateRequest<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const path  = `/0/private/${endpoint}`;
    const nonce = Date.now().toString();
    const body  = new URLSearchParams({ nonce, ...params }).toString();

    const res = await fetch(`${REST_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'API-Key':      this.apiKey,
        'API-Sign':     this.sign(path, nonce, body),
      },
      body,
    });

    const data = await res.json() as { error: string[]; result: T };
    if (data.error?.length) throw new Error(`Kraken ${endpoint}: ${data.error.join(', ')}`);
    return data.result;
  }

  private async publicRequest<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const qs  = new URLSearchParams(params).toString();
    const url = `${REST_BASE}/0/public/${endpoint}${qs ? '?' + qs : ''}`;
    const res = await fetch(url);
    const data = await res.json() as { error: string[]; result: T };
    if (data.error?.length) throw new Error(`Kraken public ${endpoint}: ${data.error.join(', ')}`);
    return data.result;
  }

  // ── Public price ──────────────────────────────────────────────────────────

  async getBestBidAsk(pair: string): Promise<PriceSnapshot> {
    const krakenPair = PAIR_MAP[pair];
    if (!krakenPair) throw new Error(`No Kraken mapping for ${pair}`);

    const data = await this.publicRequest<Record<string, {
      b: [string, string, string]; // best bid: price, wholeLotVolume, lotVolume
      a: [string, string, string]; // best ask
    }>>('Ticker', { pair: krakenPair });

    const key  = Object.keys(data)[0];
    const tick = data[key];
    if (!tick) throw new Error(`Empty Kraken ticker response for ${krakenPair}`);

    return {
      exchange: 'Kraken',
      pair,
      bid:  parseFloat(tick.b[0]),
      ask:  parseFloat(tick.a[0]),
      time: new Date(),
    };
  }

  // ── Account balance ───────────────────────────────────────────────────────

  async getBalance(currency: string): Promise<number> {
    const krakenCurrency = CURRENCY_MAP[currency] ?? currency;
    const data = await this.privateRequest<Record<string, string>>('Balance');
    return parseFloat(data[krakenCurrency] ?? '0');
  }

  // ── Place market order ────────────────────────────────────────────────────

  async placeMarketOrder(side: OrderSide, pair: string, volume: number): Promise<OrderResult> {
    const krakenPair = PAIR_MAP[pair];
    if (!krakenPair) throw new Error(`No Kraken mapping for ${pair}`);

    const result = await this.privateRequest<{ txid: string[] }>('AddOrder', {
      pair:      krakenPair,
      type:      side,
      ordertype: 'market',
      volume:    volume.toFixed(8),
      oflags:    'fciq',   // fee charged in quote currency (USD)
    });

    return { exchange: 'Kraken', orderId: result.txid[0], side, pair };
  }

  async getOrder(orderId: string): Promise<unknown> {
    return this.privateRequest('QueryOrders', { txid: orderId, trades: 'true' });
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    return this.privateRequest('CancelOrder', { txid: orderId });
  }

  // ── WebSocket v2 for live prices ──────────────────────────────────────────

  connectWebSocket(pairs: string[]): void {
    const wsPairs = pairs.map(p => WS_PAIR_MAP[p]).filter((p): p is string => Boolean(p));
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      (this.ws as WebSocket).send(JSON.stringify({
        method: 'subscribe',
        params: { channel: 'ticker', symbol: wsPairs },
      }));
      this.emit('connected');
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          channel?: string;
          data?: Array<{ symbol: string; bid: number; ask: number }>;
        };

        if (msg.channel === 'ticker' && msg.data) {
          for (const tick of msg.data) {
            const cbPair = tick.symbol.replace('/', '-');
            const snapshot: PriceSnapshot = {
              exchange: 'Kraken',
              pair:     cbPair,
              bid:      tick.bid,
              ask:      tick.ask,
              time:     new Date(),
            };
            this.prices[cbPair] = snapshot;
            this.emit('price', snapshot);
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
