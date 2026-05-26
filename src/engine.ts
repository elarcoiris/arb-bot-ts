/**
 * engine.ts - Arbitrage calculation and trade execution engine
 *
 * Maker order strategy:
 *   Rather than crossing the spread with a market order (taker), we place
 *   limit orders just inside the spread on both sides simultaneously.
 *
 *   Buy limit:  ask - (ask * limitOffsetPct)   -- slightly below ask, sits at top of book
 *   Sell limit: bid + (bid * limitOffsetPct)   -- slightly above bid, sits at top of book
 *
 *   This qualifies as a maker order on all three exchanges, reducing fees:
 *     Binance:  0.08% maker vs 0.10% taker
 *     Kraken:   0.16% maker vs 0.26% taker
 *     Coinbase: 0.40% maker vs 0.60% taker
 *
 *   Tradeoff: orders may not fill if the price moves away. The engine
 *   cancels both legs after orderTimeoutMs if unfilled.
 */

import { EventEmitter } from 'events';
import type {
  EngineOptions,
  EngineStats,
  ExchangeName,
  FillStatus,
  IExchangeClient,
  Opportunity,
  OpportunityGoneEvent,
  PricesByExchange,
  PriceSnapshot,
  TradeCompleteEvent,
  TradeErrorEvent,
} from './types';

// -- Maker fee schedule ------------------------------------------------------
export const MAKER_FEES: Record<ExchangeName, number> = {
  Binance:  0.0008,   // 0.08%
  Kraken:   0.0016,   // 0.16%
  Coinbase: 0.004,    // 0.40%
};

// -- Taker fee schedule (kept for reference / fallback display) --------------
export const FEES: Record<ExchangeName, number> = {
  Binance:  0.001,
  Kraken:   0.0026,
  Coinbase: 0.006,
};

// -- Typed EventEmitter -------------------------------------------------------

interface EngineEvents {
  opportunity:     (opp: Opportunity) => void;
  dryRun:          (opp: Opportunity) => void;
  opportunityGone: (event: OpportunityGoneEvent) => void;
  tradeStart:      (opp: Opportunity) => void;
  tradeComplete:   (event: TradeCompleteEvent) => void;
  tradeError:      (event: TradeErrorEvent) => void;
}

export class ArbitrageEngine extends EventEmitter {
  private readonly exchanges:       Partial<Record<ExchangeName, IExchangeClient>>;
  private readonly minProfitPct:    number;
  private readonly tradeSizeUSD:    number;
  private readonly dryRun:          boolean;
  private readonly orderTimeoutMs:  number;
  private readonly limitOffsetPct:  number;
  private activeTrade               = false;

  public readonly stats: EngineStats = {
    scans:           0,
    opportunities:   0,
    tradesExecuted:  0,
    tradesFailed:    0,
    totalProfitUSD:  0,
    shadowProfitUSD: 0,
  };

  constructor(opts: EngineOptions) {
    super();
    this.exchanges      = opts.exchanges;
    this.minProfitPct   = opts.minProfitPct;
    this.tradeSizeUSD   = opts.tradeSizeUSD;
    this.dryRun         = opts.dryRun;
    this.orderTimeoutMs = opts.orderTimeoutMs ?? 10_000;
    this.limitOffsetPct = opts.limitOffsetPct ?? 0.0001; // 0.01% inside spread
  }

  emit<K extends keyof EngineEvents>(event: K, ...args: Parameters<EngineEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
  on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): this {
    return super.on(event, listener);
  }

  // -- Spread calculation ----------------------------------------------------

  evaluate(pricesByExchange: Partial<PricesByExchange>): Opportunity[] {
    this.stats.scans++;
    const results: Opportunity[] = [];
    const names = Object.keys(pricesByExchange) as ExchangeName[];

    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < names.length; j++) {
        if (i === j) continue;
        const buyExName  = names[i];
        const sellExName = names[j];
        const buyPrice   = pricesByExchange[buyExName];
        const sellPrice  = pricesByExchange[sellExName];
        if (!buyPrice?.ask || !sellPrice?.bid) continue;

        // Limit prices sit just inside the spread
        const buyLimitPrice  = buyPrice.ask  * (1 - this.limitOffsetPct);
        const sellLimitPrice = sellPrice.bid * (1 + this.limitOffsetPct);

        const grossSpread = (sellLimitPrice - buyLimitPrice) / buyLimitPrice;
        const buyFee      = MAKER_FEES[buyExName]  ?? 0;
        const sellFee     = MAKER_FEES[sellExName] ?? 0;
        const totalFees   = buyFee + sellFee;
        const netProfit   = grossSpread - totalFees;

        const coinsBought  = this.tradeSizeUSD / buyLimitPrice;
        const usdReceived  = coinsBought * sellLimitPrice;
        const feeCost      = (this.tradeSizeUSD * buyFee) + (usdReceived * sellFee);
        const netProfitUSD = usdReceived - this.tradeSizeUSD - feeCost;

        results.push({
          pair:           buyPrice.pair,
          buyExchange:    buyExName,
          sellExchange:   sellExName,
          buyAsk:         buyPrice.ask,
          sellBid:        sellPrice.bid,
          buyLimitPrice,
          sellLimitPrice,
          grossSpreadPct: grossSpread,
          totalFeesPct:   totalFees,
          netProfitPct:   netProfit,
          netProfitUSD,
          coinsBought,
          viable:         netProfit >= this.minProfitPct,
        });
      }
    }

    const sorted = results.sort((a, b) => b.netProfitPct - a.netProfitPct);

    return sorted;
  }

  // -- Opportunity handler ---------------------------------------------------

  async onPriceUpdate(pricesByExchange: Partial<PricesByExchange>): Promise<void> {
    if (this.activeTrade) return;
    const opportunities = this.evaluate(pricesByExchange);
    const best = opportunities.find(o => o.viable);
    if (!best) return;
    this.stats.opportunities++;
    // Shadow P&L: accumulate once per viable opportunity, not once per scan.
    // Represents what you would have made if you had traded every opportunity
    // that crossed the minProfitPct threshold.
    this.stats.shadowProfitUSD += best.netProfitUSD;
    this.emit('opportunity', best);
    if (this.dryRun) { this.emit('dryRun', best); return; }
    await this.executeTrade(best);
  }

  // -- Trade execution -------------------------------------------------------

  async executeTrade(opp: Opportunity): Promise<void> {
    this.activeTrade = true;
    this.emit('tradeStart', opp);

    try {
      const buyClient  = this.exchanges[opp.buyExchange];
      const sellClient = this.exchanges[opp.sellExchange];
      if (!buyClient || !sellClient) throw new Error(`Client missing for ${opp.buyExchange} or ${opp.sellExchange}`);

      // Re-fetch to confirm spread still viable
      const [freshBuy, freshSell] = await Promise.all([
        buyClient.getBestBidAsk(opp.pair),
        sellClient.getBestBidAsk(opp.pair),
      ]);

      const freshPrices: Partial<PricesByExchange> = {
        [opp.buyExchange]:  freshBuy,
        [opp.sellExchange]: freshSell,
      };
      const fresh = this.evaluate(freshPrices)
        .find(o => o.buyExchange === opp.buyExchange && o.sellExchange === opp.sellExchange);

      if (!fresh?.viable) {
        this.emit('opportunityGone', { opp, reason: 'Spread closed before execution' });
        return;
      }

      await this.verifyBalances(fresh, buyClient, sellClient);

      // Place both limit orders simultaneously
      const [buyResult, sellResult] = await Promise.allSettled([
        buyClient.placeLimitOrder('buy',   fresh.pair, fresh.coinsBought, fresh.buyLimitPrice!),
        sellClient.placeLimitOrder('sell', fresh.pair, fresh.coinsBought, fresh.sellLimitPrice!),
      ]);

      if (buyResult.status === 'rejected' || sellResult.status === 'rejected') {
        if (buyResult.status === 'fulfilled')  await this.cancelOrderSafe(buyClient,  buyResult.value.orderId,  fresh.pair);
        if (sellResult.status === 'fulfilled') await this.cancelOrderSafe(sellClient, sellResult.value.orderId, fresh.pair);
        const buyErr  = buyResult.status  === 'rejected' ? (buyResult.reason  as Error).message : 'ok';
        const sellErr = sellResult.status === 'rejected' ? (sellResult.reason as Error).message : 'ok';
        throw new Error(`Leg failure - buy: ${buyErr}, sell: ${sellErr}`);
      }

      const fills = await Promise.all([
        this.waitForFill(buyClient,  buyResult.value.orderId,  fresh.pair, opp.buyExchange),
        this.waitForFill(sellClient, sellResult.value.orderId, fresh.pair, opp.sellExchange),
      ]) as [unknown, unknown];

      this.stats.tradesExecuted++;
      this.stats.totalProfitUSD += fresh.netProfitUSD;
      this.emit('tradeComplete', { opp: fresh, fills, netProfitUSD: fresh.netProfitUSD });

    } catch (err) {
      this.stats.tradesFailed++;
      this.emit('tradeError', { opp, error: (err as Error).message });
    } finally {
      this.activeTrade = false;
    }
  }

  // -- Private helpers -------------------------------------------------------

  private async verifyBalances(opp: Opportunity, buyClient: IExchangeClient, sellClient: IExchangeClient): Promise<void> {
    const [baseCurrency] = opp.pair.split('-');
    const usdBal  = await buyClient.getBalance('USD');
    if (usdBal < this.tradeSizeUSD) throw new Error(`${opp.buyExchange} USD balance $${usdBal.toFixed(2)} < required $${this.tradeSizeUSD}`);
    const coinBal = await sellClient.getBalance(baseCurrency);
    if (coinBal < opp.coinsBought * 0.999) throw new Error(`${opp.sellExchange} ${baseCurrency} balance ${coinBal.toFixed(6)} < required ${opp.coinsBought.toFixed(6)}`);
  }

  private async cancelOrderSafe(client: IExchangeClient, orderId: string, pair: string): Promise<void> {
    try { await client.cancelOrder(orderId, pair); } catch { /* best-effort */ }
  }

  private async waitForFill(client: IExchangeClient, orderId: string, pair: string, exchangeName: ExchangeName): Promise<unknown> {
    const deadline = Date.now() + this.orderTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const order  = await client.getOrder(orderId, pair);
        const status = this.normalizeStatus(order, exchangeName);
        if (status === 'filled')    return order;
        if (status === 'cancelled') throw new Error(`Order ${orderId} on ${exchangeName} was cancelled`);
      } catch (err) {
        if ((err as Error).message.includes('cancelled')) throw err;
      }
    }
    // Timeout — cancel the unfilled order rather than leaving it open
    await this.cancelOrderSafe(client, orderId, pair);
    throw new Error(`Order ${orderId} on ${exchangeName} did not fill within ${this.orderTimeoutMs}ms — cancelled`);
  }

  private normalizeStatus(order: unknown, exchangeName: ExchangeName): FillStatus {
    const o = order as Record<string, unknown>;
    switch (exchangeName) {
      case 'Coinbase': {
        const s = (o['order'] as Record<string, string> | undefined)?.['status'] ?? '';
        if (s === 'FILLED')                         return 'filled';
        if (['CANCELLED', 'EXPIRED'].includes(s))   return 'cancelled';
        return 'open';
      }
      case 'Kraken': {
        const s = (Object.values(o) as Array<{ status?: string }>)[0]?.status ?? '';
        if (s === 'closed')   return 'filled';
        if (s === 'canceled') return 'cancelled';
        return 'open';
      }
      case 'Binance': {
        const s = (o['status'] as string | undefined) ?? '';
        if (s === 'FILLED')                                   return 'filled';
        if (['CANCELED', 'EXPIRED', 'REJECTED'].includes(s)) return 'cancelled';
        return 'open';
      }
    }
  }
}

export type { PriceSnapshot };
