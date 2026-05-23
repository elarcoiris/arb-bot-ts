/**
 * engine.ts - Arbitrage calculation and trade execution engine
 *
 * Supports any number of exchanges via the IExchangeClient interface.
 * Currently wired for Coinbase, Kraken, and Binance (all 6 direction pairs).
 *
 * Flow for each detected opportunity:
 *   1. Verify spread is still live (re-fetch prices from both exchanges)
 *   2. Check sufficient balance on both sides
 *   3. Place buy + sell legs simultaneously
 *   4. Monitor fills; cancel surviving leg if one times out
 *   5. Log P&L
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

// ── Fee schedule (taker rates as of 2025) ────────────────────────────────────
// Binance:  0.10% (0.075% if paying with BNB — not modelled here)
// Coinbase: 0.60% (drops with 30-day volume)
// Kraken:   0.26% (drops with 30-day volume)
export const FEES: Record<ExchangeName, number> = {
  Binance:  0.001,
  Coinbase: 0.006,
  Kraken:   0.0026,
};

// ── Typed EventEmitter ────────────────────────────────────────────────────────

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
  private activeTrade               = false;

  public readonly stats: EngineStats = {
    scans:          0,
    opportunities:  0,
    tradesExecuted: 0,
    tradesFailed:   0,
    totalProfitUSD: 0,
  };

  constructor(opts: EngineOptions) {
    super();
    this.exchanges      = opts.exchanges;
    this.minProfitPct   = opts.minProfitPct;
    this.tradeSizeUSD   = opts.tradeSizeUSD;
    this.dryRun         = opts.dryRun;
    this.orderTimeoutMs = opts.orderTimeoutMs ?? 10_000;
  }

  // Typed emit/on wrappers
  emit<K extends keyof EngineEvents>(event: K, ...args: Parameters<EngineEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
  on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): this {
    return super.on(event, listener);
  }

  // ── Core spread calculation ───────────────────────────────────────────────

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

        const ask         = buyPrice.ask;
        const bid         = sellPrice.bid;
        const grossSpread = (bid - ask) / ask;
        const buyFee      = FEES[buyExName]  ?? 0;
        const sellFee     = FEES[sellExName] ?? 0;
        const totalFees   = buyFee + sellFee;
        const netProfit   = grossSpread - totalFees;

        const coinsBought  = this.tradeSizeUSD / ask;
        const usdReceived  = coinsBought * bid;
        const feeCost      = (this.tradeSizeUSD * buyFee) + (usdReceived * sellFee);
        const netProfitUSD = usdReceived - this.tradeSizeUSD - feeCost;

        results.push({
          pair:           buyPrice.pair,
          buyExchange:    buyExName,
          sellExchange:   sellExName,
          buyAsk:         ask,
          sellBid:        bid,
          grossSpreadPct: grossSpread,
          totalFeesPct:   totalFees,
          netProfitPct:   netProfit,
          netProfitUSD,
          coinsBought,
          viable:         netProfit >= this.minProfitPct,
        });
      }
    }

    return results.sort((a, b) => b.netProfitPct - a.netProfitPct);
  }

  // ── Opportunity handler ───────────────────────────────────────────────────

  async onPriceUpdate(pricesByExchange: Partial<PricesByExchange>): Promise<void> {
    if (this.activeTrade) return;

    const opportunities = this.evaluate(pricesByExchange);
    const best = opportunities.find(o => o.viable);
    if (!best) return;

    this.stats.opportunities++;
    this.emit('opportunity', best);

    if (this.dryRun) {
      this.emit('dryRun', best);
      return;
    }

    await this.executeTrade(best);
  }

  // ── Trade execution ───────────────────────────────────────────────────────

  async executeTrade(opp: Opportunity): Promise<void> {
    this.activeTrade = true;
    this.emit('tradeStart', opp);

    try {
      const buyClient  = this.exchanges[opp.buyExchange];
      const sellClient = this.exchanges[opp.sellExchange];

      if (!buyClient || !sellClient) {
        throw new Error(`Client missing for ${opp.buyExchange} or ${opp.sellExchange}`);
      }

      // Step 1: Re-fetch to confirm spread is still live
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

      // Step 2: Check balances
      await this.verifyBalances(fresh, buyClient, sellClient);

      // Step 3: Fire both legs simultaneously
      const [buyResult, sellResult] = await Promise.allSettled([
        buyClient.placeMarketOrder('buy',   fresh.pair, this.tradeSizeUSD),
        sellClient.placeMarketOrder('sell', fresh.pair, fresh.coinsBought),
      ]);

      if (buyResult.status === 'rejected' || sellResult.status === 'rejected') {
        if (buyResult.status === 'fulfilled') {
          await this.cancelOrderSafe(buyClient, buyResult.value.orderId, fresh.pair);
        }
        if (sellResult.status === 'fulfilled') {
          await this.cancelOrderSafe(sellClient, sellResult.value.orderId, fresh.pair);
        }
        const buyErr  = buyResult.status  === 'rejected' ? (buyResult.reason  as Error).message : 'ok';
        const sellErr = sellResult.status === 'rejected' ? (sellResult.reason as Error).message : 'ok';
        throw new Error(`Leg failure - buy: ${buyErr}, sell: ${sellErr}`);
      }

      // Step 4: Wait for both fills
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

  // ── Private helpers ───────────────────────────────────────────────────────

  private async verifyBalances(
    opp:        Opportunity,
    buyClient:  IExchangeClient,
    sellClient: IExchangeClient,
  ): Promise<void> {
    const [baseCurrency] = opp.pair.split('-'); // 'BTC' from 'BTC-USD'

    const usdBal = await buyClient.getBalance('USD');
    if (usdBal < this.tradeSizeUSD) {
      throw new Error(
        `${opp.buyExchange} USD balance $${usdBal.toFixed(2)} < required $${this.tradeSizeUSD}`,
      );
    }

    const coinBal = await sellClient.getBalance(baseCurrency);
    if (coinBal < opp.coinsBought * 0.999) {
      throw new Error(
        `${opp.sellExchange} ${baseCurrency} balance ${coinBal.toFixed(6)} ` +
        `< required ${opp.coinsBought.toFixed(6)}`,
      );
    }
  }

  private async cancelOrderSafe(
    client:  IExchangeClient,
    orderId: string,
    pair:    string,
  ): Promise<void> {
    try {
      await client.cancelOrder(orderId, pair);
    } catch { /* best-effort */ }
  }

  private async waitForFill(
    client:       IExchangeClient,
    orderId:      string,
    pair:         string,
    exchangeName: ExchangeName,
  ): Promise<unknown> {
    const deadline = Date.now() + this.orderTimeoutMs;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const order  = await client.getOrder(orderId, pair);
        const status = this.normalizeStatus(order, exchangeName);

        if (status === 'filled')    return order;
        if (status === 'cancelled') {
          throw new Error(`Order ${orderId} on ${exchangeName} was cancelled`);
        }
      } catch (err) {
        if ((err as Error).message.includes('cancelled')) throw err;
        // Transient error - keep retrying
      }
    }

    throw new Error(
      `Order ${orderId} on ${exchangeName} did not fill within ${this.orderTimeoutMs}ms`,
    );
  }

  private normalizeStatus(order: unknown, exchangeName: ExchangeName): FillStatus {
    const o = order as Record<string, unknown>;

    switch (exchangeName) {
      case 'Coinbase': {
        const s = (o['order'] as Record<string, string> | undefined)?.['status'] ?? '';
        if (s === 'FILLED')                          return 'filled';
        if (['CANCELLED', 'EXPIRED'].includes(s))    return 'cancelled';
        return 'open';
      }
      case 'Kraken': {
        const entries = Object.values(o) as Array<{ status?: string }>;
        const s       = entries[0]?.status ?? '';
        if (s === 'closed')   return 'filled';
        if (s === 'canceled') return 'cancelled';
        return 'open';
      }
      case 'Binance': {
        const s = (o['status'] as string | undefined) ?? '';
        if (s === 'FILLED')                                    return 'filled';
        if (['CANCELED', 'EXPIRED', 'REJECTED'].includes(s))  return 'cancelled';
        return 'open';
      }
    }
  }
}

// Re-export PriceSnapshot so index.ts doesn't need to import from types directly
export type { PriceSnapshot };
