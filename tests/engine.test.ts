/**
 * engine.test.ts - Unit tests for ArbitrageEngine
 *
 * Covers:
 *   - evaluate(): spread calculation, fee deduction, sorting, shadow P&L
 *   - onPriceUpdate(): opportunity detection, dry-run mode, trade mutex
 *   - executeTrade(): happy path, stale spread, insufficient balance,
 *                     leg failure + cancellation, fill timeout
 *   - normalizeStatus(): all three exchange order status formats
 */

import { ArbitrageEngine, FEES, MAKER_FEES } from '../src/engine';
import { makeMockClient, makePriceSnapshot, makeOrderResult } from './mocks';
import type { Opportunity, PricesByExchange } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEngine(overrides: Partial<{
  minProfitPct:   number;
  tradeSizeUSD:   number;
  dryRun:         boolean;
  orderTimeoutMs: number;
}> = {}) {
  const coinbase = makeMockClient('Coinbase');
  const kraken   = makeMockClient('Kraken');
  const binance  = makeMockClient('Binance');

  const engine = new ArbitrageEngine({
    exchanges: { Coinbase: coinbase, Kraken: kraken, Binance: binance },
    minProfitPct:   overrides.minProfitPct   ?? 0.001,
    tradeSizeUSD:   overrides.tradeSizeUSD   ?? 1000,
    dryRun:         overrides.dryRun         ?? true,
    orderTimeoutMs: overrides.orderTimeoutMs ?? 2000,
  });

  return { engine, coinbase, kraken, binance };
}

function makePrices(
  cbBid: number, cbAsk: number,
  krBid: number, krAsk: number,
  bnBid: number, bnAsk: number,
  pair = 'BTC-USD',
): PricesByExchange {
  return {
    Coinbase: makePriceSnapshot('Coinbase', pair, cbBid, cbAsk),
    Kraken:   makePriceSnapshot('Kraken',   pair, krBid, krAsk),
    Binance:  makePriceSnapshot('Binance',  pair, bnBid, bnAsk),
  };
}

// ---------------------------------------------------------------------------
// evaluate()
// ---------------------------------------------------------------------------

describe('ArbitrageEngine.evaluate()', () => {
  test('returns 6 direction pairs for 3 exchanges', () => {
    const { engine } = makeEngine();
    const prices = makePrices(50000, 50010, 50000, 50010, 50000, 50010);
    const results = engine.evaluate(prices);
    expect(results).toHaveLength(6);
  });

  test('results are sorted by netProfitPct descending', () => {
    const { engine } = makeEngine();
    // Binance ask is lowest so BN buy legs should be most profitable
    const prices = makePrices(50100, 50110, 50050, 50060, 49900, 49910);
    const results = engine.evaluate(prices);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].netProfitPct).toBeGreaterThanOrEqual(results[i].netProfitPct);
    }
  });

  test('gross spread uses limit prices offset from bid/ask', () => {
    const { engine } = makeEngine();
    const prices = makePrices(50000, 50000, 50500, 50500, 50000, 50000);
    const results = engine.evaluate(prices);

    // Engine offsets: buyLimit = ask * (1 - offset), sellLimit = bid * (1 + offset)
    const offset = 0.0001;
    const cbToKr = results.find(r => r.buyExchange === 'Coinbase' && r.sellExchange === 'Kraken')!;
    const buyLimit  = 50000 * (1 - offset);
    const sellLimit = 50500 * (1 + offset);
    const expectedGross = (sellLimit - buyLimit) / buyLimit;
    expect(cbToKr.grossSpreadPct).toBeCloseTo(expectedGross, 4);
  });

  test('totalFeesPct equals sum of both exchange maker fees', () => {
    const { engine } = makeEngine();
    const prices = makePrices(50000, 50000, 50000, 50000, 50000, 50000);
    const results = engine.evaluate(prices);

    const cbToKr = results.find(r => r.buyExchange === 'Coinbase' && r.sellExchange === 'Kraken')!;
    expect(cbToKr.totalFeesPct).toBeCloseTo(MAKER_FEES.Coinbase + MAKER_FEES.Kraken, 6);

    const bnToKr = results.find(r => r.buyExchange === 'Binance' && r.sellExchange === 'Kraken')!;
    expect(bnToKr.totalFeesPct).toBeCloseTo(MAKER_FEES.Binance + MAKER_FEES.Kraken, 6);
  });

  test('netProfitPct = grossSpreadPct - totalFeesPct', () => {
    const { engine } = makeEngine();
    const prices = makePrices(50000, 50000, 50500, 50500, 50000, 50000);
    const results = engine.evaluate(prices);

    for (const r of results) {
      expect(r.netProfitPct).toBeCloseTo(r.grossSpreadPct - r.totalFeesPct, 8);
    }
  });

  test('viable is true only when netProfitPct >= minProfitPct', () => {
    const { engine } = makeEngine({ minProfitPct: 0.002 }); // 0.2%
    // BN->KR combined fee = 0.36% — need > 0.56% gross to be viable
    const prices = makePrices(50000, 50000, 50000, 50000, 50000, 50000);
    const results = engine.evaluate(prices);
    // All spreads are 0 gross here — none should be viable
    expect(results.every(r => !r.viable)).toBe(true);
  });

  test('marks viable when spread exceeds fees + threshold', () => {
    const { engine } = makeEngine({ minProfitPct: 0.001 }); // 0.1%
    // BN buy at 50000, KR sell at 50300 = 0.6% gross, BN+KR fee = 0.36% -> net 0.24%
    const prices = makePrices(50000, 50010, 50300, 50310, 50000, 50000);
    const results = engine.evaluate(prices);
    const bnToKr = results.find(r => r.buyExchange === 'Binance' && r.sellExchange === 'Kraken')!;
    expect(bnToKr.viable).toBe(true);
  });

  test('coinsBought = tradeSizeUSD / buyLimitPrice', () => {
    const { engine } = makeEngine({ tradeSizeUSD: 1000 });
    const prices = makePrices(50000, 50000, 50000, 50000, 50000, 50000);
    const results = engine.evaluate(prices);
    for (const r of results) {
      expect(r.coinsBought).toBeCloseTo(1000 / r.buyLimitPrice!, 4);
    }
  });

  test('increments stats.scans on each call', () => {
    const { engine } = makeEngine();
    const prices = makePrices(50000, 50010, 50000, 50010, 50000, 50010);
    engine.evaluate(prices);
    engine.evaluate(prices);
    engine.evaluate(prices);
    expect(engine.stats.scans).toBe(3);
  });

  test('shadowProfitUSD does not accumulate from evaluate() directly', () => {
    const { engine } = makeEngine({ tradeSizeUSD: 1000 });
    const prices = makePrices(50000, 50000, 50000, 50000, 50000, 50000);
    engine.evaluate(prices);
    engine.evaluate(prices);
    engine.evaluate(prices);
    // evaluate() alone should never touch shadowProfitUSD
    expect(engine.stats.shadowProfitUSD).toBe(0);
  });

  test('shadowProfitUSD accumulates only on viable opportunities via onPriceUpdate', async () => {
    const { engine } = makeEngine({ dryRun: true, minProfitPct: 0.001, tradeSizeUSD: 1000 });
    // BN buy at 50000, KR sell at 50300 = viable after maker fees
    const prices = makePrices(50000, 50010, 50300, 50310, 50000, 50000);
    await engine.onPriceUpdate(prices);
    expect(engine.stats.shadowProfitUSD).toBeGreaterThan(0);
    const afterFirst = engine.stats.shadowProfitUSD;
    await engine.onPriceUpdate(prices);
    // Should accumulate again on second viable opportunity
    expect(engine.stats.shadowProfitUSD).toBeCloseTo(afterFirst * 2, 2);
  });

  test('shadowProfitUSD does not accumulate when no viable opportunity', async () => {
    const { engine } = makeEngine({ dryRun: true, minProfitPct: 0.5, tradeSizeUSD: 1000 }); // 50% threshold — impossible
    const prices = makePrices(50000, 50010, 50000, 50010, 50000, 50010);
    await engine.onPriceUpdate(prices);
    await engine.onPriceUpdate(prices);
    expect(engine.stats.shadowProfitUSD).toBe(0);
  });

  test('handles missing exchange prices gracefully', () => {
    const { engine } = makeEngine();
    // Only two exchanges provided — should return 2 direction pairs
    const partial = {
      Coinbase: makePriceSnapshot('Coinbase', 'BTC-USD', 50000, 50010),
      Kraken:   makePriceSnapshot('Kraken',   'BTC-USD', 50000, 50010),
    };
    const results = engine.evaluate(partial);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.buyExchange !== 'Binance' && r.sellExchange !== 'Binance')).toBe(true);
  });

  test('negative spread produces negative netProfitUSD', () => {
    const { engine } = makeEngine({ tradeSizeUSD: 1000 });
    // CB ask > KR bid — buying CB and selling KR loses money before fees
    const prices = makePrices(50500, 50500, 50000, 50000, 50000, 50000);
    const results = engine.evaluate(prices);
    const cbToKr = results.find(r => r.buyExchange === 'Coinbase' && r.sellExchange === 'Kraken')!;
    expect(cbToKr.netProfitUSD).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// FEES constant
// ---------------------------------------------------------------------------

describe('FEES', () => {
  test('Binance fee is 0.1%', () => {
    expect(FEES.Binance).toBe(0.001);
  });

  test('Kraken fee is 0.26%', () => {
    expect(FEES.Kraken).toBe(0.0026);
  });

  test('Coinbase fee is 0.6%', () => {
    expect(FEES.Coinbase).toBe(0.006);
  });

  test('BN+KR combined fee is 0.36%', () => {
    expect(FEES.Binance + FEES.Kraken).toBeCloseTo(0.0036, 6);
  });

  test('BN+CB combined fee is 0.7%', () => {
    expect(FEES.Binance + FEES.Coinbase).toBeCloseTo(0.007, 6);
  });

  test('KR+CB combined fee is 0.86%', () => {
    expect(FEES.Kraken + FEES.Coinbase).toBeCloseTo(0.0086, 6);
  });

  test('MAKER_FEES are lower than taker FEES for all exchanges', () => {
    expect(MAKER_FEES.Binance).toBeLessThan(FEES.Binance);
    expect(MAKER_FEES.Kraken).toBeLessThan(FEES.Kraken);
    expect(MAKER_FEES.Coinbase).toBeLessThan(FEES.Coinbase);
  });
});

// ---------------------------------------------------------------------------
// onPriceUpdate()
// ---------------------------------------------------------------------------

describe('ArbitrageEngine.onPriceUpdate()', () => {
  test('emits opportunity when viable spread found in dry-run', async () => {
    const { engine } = makeEngine({ dryRun: true, minProfitPct: 0.001 });
    const oppHandler = jest.fn();
    const dryRunHandler = jest.fn();
    engine.on('opportunity', oppHandler);
    engine.on('dryRun', dryRunHandler);

    // BN buy at 50000, KR sell at 50300 = ~0.6% gross, net ~0.24% after fees
    const prices = makePrices(50000, 50010, 50300, 50310, 50000, 50000);
    await engine.onPriceUpdate(prices);

    expect(oppHandler).toHaveBeenCalledTimes(1);
    expect(dryRunHandler).toHaveBeenCalledTimes(1);
  });

  test('does not emit opportunity when no viable spread', async () => {
    const { engine } = makeEngine({ dryRun: true, minProfitPct: 0.01 }); // 1% threshold
    const oppHandler = jest.fn();
    engine.on('opportunity', oppHandler);

    const prices = makePrices(50000, 50010, 50000, 50010, 50000, 50010);
    await engine.onPriceUpdate(prices);

    expect(oppHandler).not.toHaveBeenCalled();
  });

  test('increments stats.opportunities when opportunity found', async () => {
    const { engine } = makeEngine({ dryRun: true, minProfitPct: 0.001 });
    const prices = makePrices(50000, 50010, 50300, 50310, 50000, 50000);
    await engine.onPriceUpdate(prices);
    expect(engine.stats.opportunities).toBe(1);
  });

  test('does not execute trade in dry-run mode', async () => {
    const { engine, binance, kraken } = makeEngine({ dryRun: true, minProfitPct: 0.001 });
    const prices = makePrices(50000, 50010, 50300, 50310, 50000, 50000);
    await engine.onPriceUpdate(prices);
    expect(binance.placeLimitOrder).not.toHaveBeenCalled();
    expect(kraken.placeLimitOrder).not.toHaveBeenCalled();
  });

  test('ignores update while a trade is already active', async () => {
    const { engine } = makeEngine({ dryRun: false, minProfitPct: 0.001 });
    const oppHandler = jest.fn();
    engine.on('opportunity', oppHandler);

    // Simulate active trade by calling onPriceUpdate twice concurrently
    const prices = makePrices(50000, 50010, 50300, 50310, 50000, 50000);
    await Promise.all([
      engine.onPriceUpdate(prices),
      engine.onPriceUpdate(prices),
    ]);

    // Only one opportunity should be processed
    expect(oppHandler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// executeTrade() — happy path
// ---------------------------------------------------------------------------

describe('ArbitrageEngine.executeTrade() - happy path', () => {
  test('places buy on buy exchange and sell on sell exchange', async () => {
    const { engine, binance, kraken } = makeEngine({ dryRun: false, minProfitPct: 0.001 });

    // Configure re-fetch prices to still show viable spread
    binance.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Binance', 'BTC-USD', 50000, 50000));
    kraken.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Kraken', 'BTC-USD', 50300, 50300));

    // Configure Binance balances (buy side)
    binance.getBalance.mockImplementation(async () => 10000); // enough USD
    kraken.getBalance.mockImplementation(async (currency: string) => {
      if (currency === 'USD') return 10000;
      return 1; // enough BTC on sell side
    });

    binance.placeLimitOrder.mockResolvedValue({ ...makeOrderResult('Binance', 'BTC-USD', 'buy', 'buy-001'), orderType: 'limit' as const, limitPrice: 50000 });
    kraken.placeLimitOrder.mockResolvedValue(makeOrderResult('Kraken', 'BTC-USD', 'sell', 'sell-001'));

    // Kraken order status: closed = filled
    kraken.getOrder.mockResolvedValue({ 'sell-001': { status: 'closed' } });
    binance.getOrder.mockResolvedValue({ status: 'FILLED' });

    const opp: Opportunity = {
      pair: 'BTC-USD', buyExchange: 'Binance', sellExchange: 'Kraken',
      buyAsk: 50000, sellBid: 50300,
      grossSpreadPct: 0.006, totalFeesPct: 0.0036, netProfitPct: 0.0024,
      netProfitUSD: 2.4, coinsBought: 0.02, viable: true,
    };

    await engine.executeTrade(opp);

    expect(binance.placeLimitOrder).toHaveBeenCalledWith('buy', 'BTC-USD', expect.any(Number), expect.any(Number));
    expect(kraken.placeLimitOrder).toHaveBeenCalledWith('sell', 'BTC-USD', expect.any(Number), expect.any(Number));
  });

  test('emits tradeComplete and updates stats on success', async () => {
    const { engine, binance, kraken } = makeEngine({ dryRun: false, minProfitPct: 0.001 });

    binance.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Binance', 'BTC-USD', 50000, 50000));
    kraken.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Kraken', 'BTC-USD', 50300, 50300));
    binance.getBalance.mockResolvedValue(10000);
    kraken.getBalance.mockResolvedValue(1);
    binance.placeLimitOrder.mockResolvedValue({ ...makeOrderResult('Binance', 'BTC-USD', 'buy', 'buy-001'), orderType: 'limit' as const, limitPrice: 50000 });
    kraken.placeLimitOrder.mockResolvedValue(makeOrderResult('Kraken', 'BTC-USD', 'sell', 'sell-001'));
    binance.getOrder.mockResolvedValue({ status: 'FILLED' });
    kraken.getOrder.mockResolvedValue({ 'sell-001': { status: 'closed' } });

    const completeHandler = jest.fn();
    engine.on('tradeComplete', completeHandler);

    const opp: Opportunity = {
      pair: 'BTC-USD', buyExchange: 'Binance', sellExchange: 'Kraken',
      buyAsk: 50000, sellBid: 50300,
      grossSpreadPct: 0.006, totalFeesPct: 0.0036, netProfitPct: 0.0024,
      netProfitUSD: 2.4, coinsBought: 0.02, viable: true,
    };

    await engine.executeTrade(opp);

    expect(completeHandler).toHaveBeenCalledTimes(1);
    expect(engine.stats.tradesExecuted).toBe(1);
    expect(engine.stats.totalProfitUSD).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// executeTrade() — stale spread
// ---------------------------------------------------------------------------

describe('ArbitrageEngine.executeTrade() - stale spread', () => {
  test('emits opportunityGone when re-fetched prices no longer viable', async () => {
    const { engine, binance, kraken } = makeEngine({ dryRun: false, minProfitPct: 0.001 });

    // Re-fetch shows the spread has collapsed
    binance.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Binance', 'BTC-USD', 50000, 50000));
    kraken.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Kraken', 'BTC-USD', 50000, 50000));

    const goneHandler = jest.fn();
    engine.on('opportunityGone', goneHandler);

    const opp: Opportunity = {
      pair: 'BTC-USD', buyExchange: 'Binance', sellExchange: 'Kraken',
      buyAsk: 50000, sellBid: 50300,
      grossSpreadPct: 0.006, totalFeesPct: 0.0036, netProfitPct: 0.0024,
      netProfitUSD: 2.4, coinsBought: 0.02, viable: true,
    };

    await engine.executeTrade(opp);

    expect(goneHandler).toHaveBeenCalledTimes(1);
    expect(binance.placeLimitOrder).not.toHaveBeenCalled();
    expect(kraken.placeLimitOrder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// executeTrade() — insufficient balance
// ---------------------------------------------------------------------------

describe('ArbitrageEngine.executeTrade() - insufficient balance', () => {
  test('emits tradeError when USD balance too low on buy side', async () => {
    const { engine, binance, kraken } = makeEngine({
      dryRun: false, minProfitPct: 0.001, tradeSizeUSD: 1000,
    });

    binance.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Binance', 'BTC-USD', 50000, 50000));
    kraken.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Kraken', 'BTC-USD', 50300, 50300));

    // Only $50 available on buy side
    binance.getBalance.mockResolvedValue(50);

    const errorHandler = jest.fn();
    engine.on('tradeError', errorHandler);

    const opp: Opportunity = {
      pair: 'BTC-USD', buyExchange: 'Binance', sellExchange: 'Kraken',
      buyAsk: 50000, sellBid: 50300,
      grossSpreadPct: 0.006, totalFeesPct: 0.0036, netProfitPct: 0.0024,
      netProfitUSD: 2.4, coinsBought: 0.02, viable: true,
    };

    await engine.executeTrade(opp);

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0].error).toContain('balance');
    expect(engine.stats.tradesFailed).toBe(1);
  });

  test('emits tradeError when coin balance too low on sell side', async () => {
    const { engine, binance, kraken } = makeEngine({
      dryRun: false, minProfitPct: 0.001, tradeSizeUSD: 1000,
    });

    binance.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Binance', 'BTC-USD', 50000, 50000));
    kraken.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Kraken', 'BTC-USD', 50300, 50300));

    binance.getBalance.mockResolvedValue(10000);  // enough USD
    kraken.getBalance.mockResolvedValue(0.00001); // not enough BTC to sell

    const errorHandler = jest.fn();
    engine.on('tradeError', errorHandler);

    const opp: Opportunity = {
      pair: 'BTC-USD', buyExchange: 'Binance', sellExchange: 'Kraken',
      buyAsk: 50000, sellBid: 50300,
      grossSpreadPct: 0.006, totalFeesPct: 0.0036, netProfitPct: 0.0024,
      netProfitUSD: 2.4, coinsBought: 0.02, viable: true,
    };

    await engine.executeTrade(opp);

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(engine.stats.tradesFailed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// executeTrade() — leg failure and cancellation
// ---------------------------------------------------------------------------

describe('ArbitrageEngine.executeTrade() - leg failure', () => {
  test('cancels successful leg when the other leg fails', async () => {
    const { engine, binance, kraken } = makeEngine({ dryRun: false, minProfitPct: 0.001 });

    binance.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Binance', 'BTC-USD', 50000, 50000));
    kraken.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Kraken', 'BTC-USD', 50300, 50300));
    binance.getBalance.mockResolvedValue(10000);
    kraken.getBalance.mockResolvedValue(1);

    // Buy leg succeeds, sell leg fails
    binance.placeLimitOrder.mockResolvedValue({ ...makeOrderResult('Binance', 'BTC-USD', 'buy', 'buy-001'), orderType: 'limit' as const, limitPrice: 50000 });
    kraken.placeLimitOrder.mockRejectedValue(new Error('Kraken order rejected'));

    const errorHandler = jest.fn();
    engine.on('tradeError', errorHandler);

    const opp: Opportunity = {
      pair: 'BTC-USD', buyExchange: 'Binance', sellExchange: 'Kraken',
      buyAsk: 50000, sellBid: 50300,
      grossSpreadPct: 0.006, totalFeesPct: 0.0036, netProfitPct: 0.0024,
      netProfitUSD: 2.4, coinsBought: 0.02, viable: true,
    };

    await engine.executeTrade(opp);

    // Should have attempted to cancel the buy leg to avoid naked position
    expect(binance.cancelOrder).toHaveBeenCalledWith('buy-001', 'BTC-USD');
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(engine.stats.tradesFailed).toBe(1);
  });

  test('emits tradeError and does not crash when both legs fail', async () => {
    const { engine, binance, kraken } = makeEngine({ dryRun: false, minProfitPct: 0.001 });

    binance.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Binance', 'BTC-USD', 50000, 50000));
    kraken.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Kraken', 'BTC-USD', 50300, 50300));
    binance.getBalance.mockResolvedValue(10000);
    kraken.getBalance.mockResolvedValue(1);

    binance.placeLimitOrder.mockRejectedValue(new Error('Binance order rejected'));
    kraken.placeLimitOrder.mockRejectedValue(new Error('Kraken order rejected'));

    const errorHandler = jest.fn();
    engine.on('tradeError', errorHandler);

    const opp: Opportunity = {
      pair: 'BTC-USD', buyExchange: 'Binance', sellExchange: 'Kraken',
      buyAsk: 50000, sellBid: 50300,
      grossSpreadPct: 0.006, totalFeesPct: 0.0036, netProfitPct: 0.0024,
      netProfitUSD: 2.4, coinsBought: 0.02, viable: true,
    };

    await engine.executeTrade(opp);

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(engine.stats.tradesFailed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// executeTrade() — fill timeout
// ---------------------------------------------------------------------------

describe('ArbitrageEngine.executeTrade() - fill timeout', () => {
  test('emits tradeError when order does not fill within timeout', async () => {
    const { engine, binance, kraken } = makeEngine({
      dryRun: false, minProfitPct: 0.001, orderTimeoutMs: 100, // very short timeout
    });

    binance.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Binance', 'BTC-USD', 50000, 50000));
    kraken.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Kraken', 'BTC-USD', 50300, 50300));
    binance.getBalance.mockResolvedValue(10000);
    kraken.getBalance.mockResolvedValue(1);
    binance.placeLimitOrder.mockResolvedValue({ ...makeOrderResult('Binance', 'BTC-USD', 'buy', 'buy-001'), orderType: 'limit' as const, limitPrice: 50000 });
    kraken.placeLimitOrder.mockResolvedValue(makeOrderResult('Kraken', 'BTC-USD', 'sell', 'sell-001'));

    // Order never fills — always returns open status
    binance.getOrder.mockResolvedValue({ status: 'NEW' });
    kraken.getOrder.mockResolvedValue({ 'sell-001': { status: 'open' } });

    const errorHandler = jest.fn();
    engine.on('tradeError', errorHandler);

    const opp: Opportunity = {
      pair: 'BTC-USD', buyExchange: 'Binance', sellExchange: 'Kraken',
      buyAsk: 50000, sellBid: 50300,
      grossSpreadPct: 0.006, totalFeesPct: 0.0036, netProfitPct: 0.0024,
      netProfitUSD: 2.4, coinsBought: 0.02, viable: true,
    };

    await engine.executeTrade(opp);

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0].error).toContain('did not fill');
  }, 10_000);
});

// ---------------------------------------------------------------------------
// normalizeStatus() — via getOrder mock responses
// ---------------------------------------------------------------------------

describe('ArbitrageEngine order status normalisation', () => {
  test('Coinbase FILLED resolves fill', async () => {
    const { engine, coinbase, kraken } = makeEngine({ dryRun: false, minProfitPct: 0.001 });

    // Re-fetch must return a spread that remains viable after CB+KR fees (0.86%)
    // Buy CB at 50000, sell KR at 50500 = 1.0% gross, net ~0.14% after 0.86% fees
    coinbase.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Coinbase', 'BTC-USD', 50000, 50000));
    kraken.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Kraken', 'BTC-USD', 50500, 50500));

    coinbase.getBalance.mockResolvedValue(10000);  // USD on buy side
    kraken.getBalance.mockResolvedValue(1);         // BTC on sell side

    coinbase.placeLimitOrder.mockResolvedValue({ ...makeOrderResult('Coinbase', 'BTC-USD', 'buy', 'cb-001'), orderType: 'limit' as const, limitPrice: 50000 });
    kraken.placeLimitOrder.mockResolvedValue({ ...makeOrderResult('Kraken', 'BTC-USD', 'sell', 'kr-001'), orderType: 'limit' as const, limitPrice: 50500 });

    // Coinbase Advanced Trade order shape: { order: { status: 'FILLED' } }
    coinbase.getOrder.mockResolvedValue({ order: { status: 'FILLED' } });
    kraken.getOrder.mockResolvedValue({ 'kr-001': { status: 'closed' } });

    const completeHandler = jest.fn();
    engine.on('tradeComplete', completeHandler);

    const opp: Opportunity = {
      pair: 'BTC-USD', buyExchange: 'Coinbase', sellExchange: 'Kraken',
      buyAsk: 50000, sellBid: 50500,
      grossSpreadPct: 0.01, totalFeesPct: 0.0086, netProfitPct: 0.0014,
      netProfitUSD: 1.4, coinsBought: 0.02, viable: true,
    };

    await engine.executeTrade(opp);
    expect(completeHandler).toHaveBeenCalledTimes(1);
  });

  test('Binance CANCELED triggers tradeError via cancelled status', async () => {
    const { engine, binance, kraken } = makeEngine({
      dryRun: false, minProfitPct: 0.001, orderTimeoutMs: 2000,
    });

    binance.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Binance', 'BTC-USD', 50000, 50000));
    kraken.getBestBidAsk.mockResolvedValue(makePriceSnapshot('Kraken', 'BTC-USD', 50300, 50300));
    binance.getBalance.mockResolvedValue(10000);
    kraken.getBalance.mockResolvedValue(1);
    binance.placeLimitOrder.mockResolvedValue({ ...makeOrderResult('Binance', 'BTC-USD', 'buy', 'buy-001'), orderType: 'limit' as const, limitPrice: 50000 });
    kraken.placeLimitOrder.mockResolvedValue(makeOrderResult('Kraken', 'BTC-USD', 'sell', 'sell-001'));

    // Binance order gets cancelled
    binance.getOrder.mockResolvedValue({ status: 'CANCELED' });
    kraken.getOrder.mockResolvedValue({ 'sell-001': { status: 'closed' } });

    const errorHandler = jest.fn();
    engine.on('tradeError', errorHandler);

    const opp: Opportunity = {
      pair: 'BTC-USD', buyExchange: 'Binance', sellExchange: 'Kraken',
      buyAsk: 50000, sellBid: 50300,
      grossSpreadPct: 0.006, totalFeesPct: 0.0036, netProfitPct: 0.0024,
      netProfitUSD: 2.4, coinsBought: 0.02, viable: true,
    };

    await engine.executeTrade(opp);

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0].error).toContain('cancelled');
  });
});
