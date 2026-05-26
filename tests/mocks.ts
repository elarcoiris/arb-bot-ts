/**
 * mocks.ts - Reusable mock exchange client for tests
 *
 * Implements IExchangeClient so it can be passed directly to ArbitrageEngine.
 * All methods are jest.fn() so tests can configure return values and assert calls.
 */

import { EventEmitter } from 'events';
import type { IExchangeClient, OrderResult, OrderSide, PriceSnapshot, ExchangeName } from '../src/types';

export function makePriceSnapshot(
  exchange: ExchangeName,
  pair: string,
  bid: number,
  ask: number,
): PriceSnapshot {
  return { exchange, pair, bid, ask, time: new Date() };
}

export function makeOrderResult(
  exchange: ExchangeName,
  pair: string,
  side: OrderSide,
  orderId = 'order-123',
): OrderResult {
  return { exchange, orderId, side, pair, orderType: 'limit' };
}

export class MockExchangeClient extends EventEmitter implements IExchangeClient {
  getBestBidAsk  = jest.fn<Promise<PriceSnapshot>, [string]>();
  getBalance     = jest.fn<Promise<number>, [string]>();
  placeLimitOrder  = jest.fn<Promise<OrderResult>, [OrderSide, string, number, number]>();
  getOrder       = jest.fn<Promise<unknown>, [string, string?]>();
  cancelOrder    = jest.fn<Promise<unknown>, [string, string?]>();
  connectWebSocket = jest.fn<void, [string[]]>();
}

/**
 * Creates a pre-configured mock client that returns sensible defaults.
 * Individual tests can override specific methods as needed.
 */
export function makeMockClient(
  exchange: ExchangeName,
  bid = 50000,
  ask = 50010,
  usdBalance = 10000,
  coinBalance = 1,
): MockExchangeClient {
  const client = new MockExchangeClient();

  client.getBestBidAsk.mockResolvedValue(
    makePriceSnapshot(exchange, 'BTC-USD', bid, ask)
  );
  client.getBalance.mockImplementation(async (currency: string) => {
    if (currency === 'USD') return usdBalance;
    return coinBalance;
  });
  client.placeLimitOrder.mockResolvedValue(
    { ...makeOrderResult(exchange, 'BTC-USD', 'buy'), orderType: 'limit' as const, limitPrice: 50000 }
  );
  client.getOrder.mockResolvedValue({ status: 'FILLED' });
  client.cancelOrder.mockResolvedValue({});

  return client;
}
