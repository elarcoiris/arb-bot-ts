/**
 * types.ts - Shared interfaces and types across the entire bot
 */

// ── Exchange names ────────────────────────────────────────────────────────────

export type ExchangeName = 'Coinbase' | 'Kraken' | 'Binance';
export type OrderSide    = 'buy' | 'sell';
export type FillStatus   = 'open' | 'filled' | 'cancelled';

// ── Price data ────────────────────────────────────────────────────────────────

export interface PriceSnapshot {
  exchange: ExchangeName;
  pair:     string;       // Coinbase-style, e.g. 'BTC-USD'
  bid:      number;
  ask:      number;
  time:     Date;
}

export type PricesByExchange = Record<ExchangeName, PriceSnapshot>;

// ── Orders ────────────────────────────────────────────────────────────────────

export interface OrderResult {
  exchange:  ExchangeName;
  orderId:   string;
  side:      OrderSide;
  pair:      string;
}

// ── Arbitrage opportunities ───────────────────────────────────────────────────

export interface Opportunity {
  pair:             string;
  buyExchange:      ExchangeName;
  sellExchange:     ExchangeName;
  buyAsk:           number;
  sellBid:          number;
  grossSpreadPct:   number;
  totalFeesPct:     number;
  netProfitPct:     number;
  netProfitUSD:     number;
  coinsBought:      number;
  viable:           boolean;
}

// ── Engine stats ──────────────────────────────────────────────────────────────

export interface EngineStats {
  scans:           number;
  opportunities:   number;
  tradesExecuted:  number;
  tradesFailed:    number;
  totalProfitUSD:  number;
}

// ── Engine events ─────────────────────────────────────────────────────────────

export interface TradeCompleteEvent {
  opp:          Opportunity;
  fills:        [unknown, unknown];
  netProfitUSD: number;
}

export interface TradeErrorEvent {
  opp:   Opportunity;
  error: string;
}

export interface OpportunityGoneEvent {
  opp:    Opportunity;
  reason: string;
}

// ── Engine constructor options ────────────────────────────────────────────────

export interface EngineOptions {
  exchanges:      Partial<Record<ExchangeName, IExchangeClient>>;
  minProfitPct:   number;
  tradeSizeUSD:   number;
  dryRun:         boolean;
  orderTimeoutMs?: number;
}

// ── Exchange client interface ─────────────────────────────────────────────────
// All three clients implement this contract, ensuring the engine can treat
// them interchangeably.

export interface IExchangeClient {
  getBestBidAsk(pair: string): Promise<PriceSnapshot>;
  getBalance(currency: string): Promise<number>;
  placeMarketOrder(side: OrderSide, pair: string, quantity: number): Promise<OrderResult>;
  getOrder(orderId: string, pair?: string): Promise<unknown>;
  cancelOrder(orderId: string, pair?: string): Promise<unknown>;
  connectWebSocket(pairs: string[]): void;
  on(event: 'price',        listener: (price: PriceSnapshot) => void): this;
  on(event: 'connected',    listener: () => void): this;
  on(event: 'disconnected', listener: () => void): this;
  on(event: 'error',        listener: (err: Error) => void): this;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface BotConfig {
  cbKey:          string;
  cbSecret:       string;
  krakenKey:      string;
  krakenSecret:   string;
  binanceKey:     string;
  binanceSecret:  string;
  pairs:          string[];
  minProfitPct:   number;
  tradeSizeUSD:   number;
  pollIntervalMs: number;
  orderTimeoutMs: number;
  dryRun:         boolean;
}
