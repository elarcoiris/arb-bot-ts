/**
 * index.ts - Coinbase + Kraken + Binance Arbitrage Bot
 *
 * Usage:
 *   cp .env.example .env         # fill in your API keys
 *   npm start                    # build + run live trading
 *   npm run dry-run              # build + run, no orders placed
 *   npm run dev                  # run via ts-node (no build step)
 *   npm test                     # verify API connectivity
 */

import { readFileSync, existsSync } from 'fs';
import { CoinbaseClient } from './coinbase';
import { KrakenClient }   from './kraken';
import { BinanceClient }  from './binance';
import { ArbitrageEngine, FEES } from './engine';
import type {
  BotConfig,
  ExchangeName,
  IExchangeClient,
  Opportunity,
  PriceSnapshot,
} from './types';

// ── Load .env ─────────────────────────────────────────────────────────────────

function loadEnv(): void {
  const envPath = `${__dirname}/../.env`;
  if (!existsSync(envPath)) {
    console.error('ERROR: .env file not found. Copy .env.example -> .env and fill in your API keys.');
    process.exit(1);
  }
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('/')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key) process.env[key] = val;
  }
}
loadEnv();

// ── Config ────────────────────────────────────────────────────────────────────

const cfg: BotConfig = {
  cbKey:          process.env['COINBASE_API_KEY']    ?? '',
  cbSecret:       process.env['COINBASE_API_SECRET'] ?? '',
  krakenKey:      process.env['KRAKEN_API_KEY']      ?? '',
  krakenSecret:   process.env['KRAKEN_API_SECRET']   ?? '',
  binanceKey:     process.env['BINANCE_API_KEY']     ?? '',
  binanceSecret:  process.env['BINANCE_API_SECRET']  ?? '',
  pairs:          (process.env['PAIRS'] ?? 'BTC-USD,ETH-USD').split(',').map(s => s.trim()),
  minProfitPct:   parseFloat(process.env['MIN_PROFIT_PCT']  ?? '0.15') / 100,
  tradeSizeUSD:   parseFloat(process.env['TRADE_SIZE_USD']  ?? '500'),
  pollIntervalMs: parseInt(process.env['POLL_INTERVAL_MS']  ?? '3000'),
  orderTimeoutMs: parseInt(process.env['ORDER_TIMEOUT_SEC'] ?? '10') * 1000,
  dryRun:         (process.env['DRY_RUN'] ?? 'true') !== 'false',
};

// ── Terminal helpers ──────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green:  '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
} as const;

const LABEL: Record<ExchangeName, string> = {
  Coinbase: 'CB',
  Kraken:   'KR',
  Binance:  'BN',
};

const ts    = (): string => new Date().toTimeString().slice(0, 8);
const pct   = (v: number): string => (v * 100).toFixed(3) + '%';
const usd   = (v: number): string => '$' + Math.abs(v).toFixed(2);
const price = (v: number): string =>
  v >= 1000 ? v.toLocaleString('en', { maximumFractionDigits: 2 }) : v.toFixed(4);

function log(color: string, label: string, msg: string): void {
  console.log(`${C.dim}[${ts()}]${C.reset} ${color}${C.bold}${label}${C.reset} ${msg}`);
}

// ── Startup banner ────────────────────────────────────────────────────────────

function printBanner(): void {
  console.log();
  console.log(`${C.cyan}${C.bold}+============================================================+`);
  console.log(`|   Coinbase + Kraken + Binance Arbitrage Bot  v2.0 (TS)    |`);
  console.log(`+============================================================+${C.reset}`);
  console.log();
  console.log(`  Mode:       ${cfg.dryRun
    ? C.yellow + 'DRY RUN (no real orders)'
    : C.green  + 'LIVE TRADING'}${C.reset}`);
  console.log(`  Pairs:      ${cfg.pairs.join(', ')}`);
  console.log(`  Trade size: ${usd(cfg.tradeSizeUSD)}`);
  console.log(`  Min profit: ${pct(cfg.minProfitPct)} after fees`);
  console.log(`  Fees:       Binance ${pct(FEES.Binance)} | Kraken ${pct(FEES.Kraken)} | Coinbase ${pct(FEES.Coinbase)}`);
  console.log(`  Directions: CB<->KR | CB<->BN | KR<->BN  (6 pairs per tick)`);
  console.log();

  if (cfg.dryRun) {
    console.log(`${C.yellow}  WARNING: DRY_RUN=true - set DRY_RUN=false in .env to trade live${C.reset}`);
    console.log();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printBanner();

  const coinbase = new CoinbaseClient(cfg.cbKey,      cfg.cbSecret);
  const kraken   = new KrakenClient  (cfg.krakenKey,  cfg.krakenSecret);
  const binance  = new BinanceClient (cfg.binanceKey, cfg.binanceSecret);

  const exchanges: Partial<Record<ExchangeName, IExchangeClient>> = {
    Coinbase: coinbase,
    Kraken:   kraken,
    Binance:  binance,
  };

  const engine = new ArbitrageEngine({
    exchanges,
    minProfitPct:   cfg.minProfitPct,
    tradeSizeUSD:   cfg.tradeSizeUSD,
    dryRun:         cfg.dryRun,
    orderTimeoutMs: cfg.orderTimeoutMs,
  });

  // ── Engine event handlers ─────────────────────────────────────────────────

  engine.on('opportunity', (opp: Opportunity) => {
    const arrow = `${LABEL[opp.buyExchange]}->${LABEL[opp.sellExchange]}`;
    log(C.green, 'OPP',
      `${opp.pair} [${arrow}] buy@${price(opp.buyAsk)} sell@${price(opp.sellBid)} ` +
      `gross=${pct(opp.grossSpreadPct)} fees=-${pct(opp.totalFeesPct)} ` +
      `${C.bold}net=${pct(opp.netProfitPct)} (~${usd(opp.netProfitUSD)})${C.reset}`,
    );
  });

  engine.on('dryRun', (opp: Opportunity) => {
    const arrow = `${LABEL[opp.buyExchange]}->${LABEL[opp.sellExchange]}`;
    log(C.yellow, 'SIM',
      `[${arrow}] Would buy ${opp.coinsBought.toFixed(6)} ${opp.pair.split('-')[0]} ` +
      `on ${opp.buyExchange} / sell on ${opp.sellExchange} | est. profit: ${usd(opp.netProfitUSD)}`,
    );
  });

  engine.on('opportunityGone', ({ opp, reason }) => {
    log(C.yellow, 'GONE', `${opp.pair} - ${reason}`);
  });

  engine.on('tradeStart', (opp: Opportunity) => {
    log(C.cyan, 'EXEC',
      `Executing: buy on ${opp.buyExchange} + sell on ${opp.sellExchange} for ${opp.pair}`,
    );
  });

  engine.on('tradeComplete', ({ opp, netProfitUSD }) => {
    log(C.green, 'DONE',
      `Trade complete | ${opp.pair} ${LABEL[opp.buyExchange]}->${LABEL[opp.sellExchange]} | ` +
      `Profit: ${usd(netProfitUSD)} | Running total: ${usd(engine.stats.totalProfitUSD)}`,
    );
  });

  engine.on('tradeError', ({ opp, error }) => {
    log(C.red, 'ERR',
      `Trade failed (${opp.pair} ${LABEL[opp.buyExchange]}->${LABEL[opp.sellExchange]}): ${error}`,
    );
  });

  // ── Price state ───────────────────────────────────────────────────────────
  // Accumulates latest prices from all exchanges; fires engine once all three
  // have a quote for the same pair.

  const latestPrices: Record<ExchangeName, Record<string, PriceSnapshot>> = {
    Coinbase: {},
    Kraken:   {},
    Binance:  {},
  };

  async function onPrice(exchangeName: ExchangeName, snapshot: PriceSnapshot): Promise<void> {
    latestPrices[exchangeName][snapshot.pair] = snapshot;
    const { pair } = snapshot;

    const cb = latestPrices['Coinbase'][pair];
    const kr = latestPrices['Kraken'][pair];
    const bn = latestPrices['Binance'][pair];
    if (!cb || !kr || !bn) return;

    await engine.onPriceUpdate({ Coinbase: cb, Kraken: kr, Binance: bn });
  }

  // ── Decide WebSocket vs. polling based on key availability ───────────────

  const hasKeys = (key: string) => Boolean(key) && !key.includes('your_');
  const hasCbKeys = hasKeys(cfg.cbKey);
  const hasKrKeys = hasKeys(cfg.krakenKey);
  const hasBnKeys = hasKeys(cfg.binanceKey);
  const hasAllKeys = hasCbKeys && hasKrKeys && hasBnKeys;

  if (hasAllKeys) {
    log(C.cyan, 'WS', 'Connecting WebSocket feeds to all three exchanges...');

    for (const [name, client] of Object.entries(exchanges) as [ExchangeName, IExchangeClient][]) {
      client.on('price',        (p: PriceSnapshot) => void onPrice(name, p));
      client.on('connected',    () => log(C.green,  `OK ${LABEL[name]}`, `${name} WebSocket connected`));
      client.on('disconnected', () => log(C.yellow, `!! ${LABEL[name]}`, `${name} WebSocket disconnected - reconnecting`));
      client.on('error',        (e: Error) => log(C.red, `ERR ${LABEL[name]}`, `${name} error: ${e.message}`));
    }

    coinbase.connectWebSocket(cfg.pairs);
    kraken.connectWebSocket(cfg.pairs);
    binance.connectWebSocket(cfg.pairs);

  } else {
    const missing = (
      [!hasCbKeys && 'Coinbase', !hasKrKeys && 'Kraken', !hasBnKeys && 'Binance'] as
      (string | false)[]
    ).filter((x): x is string => Boolean(x)).join(', ');

    log(C.yellow, 'POLL', `Keys missing for: ${missing}. Polling every ${cfg.pollIntervalMs}ms.`);
    log(C.yellow, '    ', 'Add API keys to .env to enable WebSocket mode.');

    const poll = async (): Promise<void> => {
      for (const pair of cfg.pairs) {
        try {
          const [cb, kr, bn] = await Promise.all([
            coinbase.getBestBidAsk(pair),
            kraken.getBestBidAsk(pair),
            binance.getBestBidAsk(pair),
          ]);

          latestPrices['Coinbase'][pair] = cb;
          latestPrices['Kraken'][pair]   = kr;
          latestPrices['Binance'][pair]  = bn;

          const opps = engine.evaluate({ Coinbase: cb, Kraken: kr, Binance: bn });
          const top  = opps[0];
          if (top) {
            const marker = top.viable ? C.green + '^' : C.dim + '-';
            const arrow  = `${LABEL[top.buyExchange]}->${LABEL[top.sellExchange]}`;
            process.stdout.write(
              `${C.dim}[${ts()}]${C.reset} ${marker} ${top.pair} best: ${arrow} net=${pct(top.netProfitPct)}${C.reset}   `,
            );
          }

          await engine.onPriceUpdate({ Coinbase: cb, Kraken: kr, Binance: bn });
        } catch (err) {
          log(C.red, 'POLL', `${pair}: ${(err as Error).message}`);
        }
      }
      process.stdout.write('\n');
    };

    await poll();
    setInterval(() => void poll(), cfg.pollIntervalMs);
  }

  // ── Stats ticker ──────────────────────────────────────────────────────────
  setInterval(() => {
    const s = engine.stats;
    process.stdout.write(
      `\r${C.dim}  scans:${s.scans} opps:${s.opportunities} ` +
      `trades:${s.tradesExecuted} failed:${s.tradesFailed} ` +
      `P&L: ${s.totalProfitUSD >= 0 ? C.green : C.red}${usd(s.totalProfitUSD)}${C.reset}   `,
    );
  }, 10_000);
}

main().catch((err: unknown) => {
  console.error(`\n${C.red}Fatal error: ${(err as Error).message}${C.reset}`);
  process.exit(1);
});
