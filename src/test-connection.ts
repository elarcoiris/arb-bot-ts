/**
 * test-connection.ts - Pre-flight connectivity check for all three exchanges
 *
 * Usage:  npm test
 *
 * Phase 1: Public price feeds (no API keys needed)
 * Phase 2: Live 6-direction spread snapshot
 * Phase 3: Authenticated balance checks (requires API keys)
 */

import { readFileSync, existsSync } from 'fs';
import { CoinbaseClient } from './coinbase';
import { KrakenClient }   from './kraken';
import { BinanceClient }  from './binance';
import { ArbitrageEngine, FEES } from './engine';
import type { ExchangeName, IExchangeClient, PriceSnapshot } from './types';

function loadEnv(): void {
  const envPath = `${__dirname}/../.env`;
  if (!existsSync(envPath)) return;
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

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
} as const;

async function test(label: string, fn: () => Promise<string>): Promise<boolean> {
  process.stdout.write(`  ${label.padEnd(38, '.')}`);
  try {
    const result = await fn();
    console.log(` ${C.green}OK${C.reset}  ${result}`);
    return true;
  } catch (err) {
    console.log(` ${C.red}FAIL${C.reset}  ${(err as Error).message}`);
    return false;
  }
}

function hasKeys(key: string | undefined, secret: string | undefined): boolean {
  return Boolean(key && secret && !key.includes('your_') && !secret.includes('your_'));
}

async function main(): Promise<void> {
  console.log(`\n${C.cyan}${C.bold}Crypto Arbitrage Bot - Connection Test (TypeScript v2.0)${C.reset}`);
  console.log(`${C.dim}Exchanges: Coinbase | Kraken | Binance${C.reset}\n`);

  const coinbase = new CoinbaseClient(
    process.env['COINBASE_API_KEY']    ?? '',
    process.env['COINBASE_API_SECRET'] ?? '',
  );
  const kraken = new KrakenClient(
    process.env['KRAKEN_API_KEY']    ?? '',
    process.env['KRAKEN_API_SECRET'] ?? '',
  );
  const binance = new BinanceClient(
    process.env['BINANCE_API_KEY']    ?? '',
    process.env['BINANCE_API_SECRET'] ?? '',
  );

  // ── Phase 1: Public price feeds ───────────────────────────────────────────

  console.log(`${C.bold}Phase 1 - Public price feeds (no API keys needed)${C.reset}`);

  const prices: Partial<Record<ExchangeName, Record<string, PriceSnapshot>>> = {};

  const clients: [ExchangeName, IExchangeClient][] = [
    ['Coinbase', coinbase],
    ['Kraken',   kraken],
    ['Binance',  binance],
  ];

  for (const [name, client] of clients) {
    for (const pair of ['BTC-USD', 'ETH-USD']) {
      await test(`${name} ${pair}`, async () => {
        const p = await client.getBestBidAsk(pair);
        if (!prices[name]) prices[name] = {};
        prices[name]![pair] = p;
        return `bid=$${p.bid.toLocaleString('en', { maximumFractionDigits: 2 })}  ask=$${p.ask.toLocaleString('en', { maximumFractionDigits: 2 })}`;
      });
    }
  }

  // ── Phase 2: Spread snapshot ──────────────────────────────────────────────

  console.log(`\n${C.bold}Phase 2 - Live spread snapshot (BTC-USD, all 6 directions)${C.reset}`);

  const cb = prices['Coinbase']?.['BTC-USD'];
  const kr = prices['Kraken']?.['BTC-USD'];
  const bn = prices['Binance']?.['BTC-USD'];

  if (cb && kr && bn) {
    const engine = new ArbitrageEngine({
      exchanges:    {},
      minProfitPct: 0.001,
      tradeSizeUSD: 500,
      dryRun:       true,
    });

    const opps = engine.evaluate({ Coinbase: cb, Kraken: kr, Binance: bn });
    console.log();
    console.log(`  ${'Direction'.padEnd(10)} ${'Buy ask'.padEnd(14)} ${'Sell bid'.padEnd(14)} ${'Gross'.padEnd(10)} ${'Fees'.padEnd(10)} Net`);
    console.log(`  ${'-'.repeat(70)}`);

    for (const o of opps) {
      const arrow   = `${o.buyExchange.slice(0, 2)}->${o.sellExchange.slice(0, 2)}`;
      const netCol  = o.netProfitPct >= 0 ? C.green : C.red;
      const buyAsk  = `$${o.buyAsk.toLocaleString('en',  { maximumFractionDigits: 2 })}`;
      const sellBid = `$${o.sellBid.toLocaleString('en', { maximumFractionDigits: 2 })}`;
      console.log(
        `  ${arrow.padEnd(10)} ${buyAsk.padEnd(14)} ${sellBid.padEnd(14)} ` +
        `${(o.grossSpreadPct * 100).toFixed(3).padEnd(9)}%  ` +
        `-${(o.totalFeesPct  * 100).toFixed(3).padEnd(9)}%  ` +
        `${netCol}${o.netProfitPct >= 0 ? '+' : ''}${(o.netProfitPct * 100).toFixed(3)}%${C.reset}`,
      );
    }

    console.log();
    const best = opps[0];
    if (best && best.netProfitPct > 0) {
      console.log(`  ${C.green}${C.bold}Best: ${best.buyExchange} -> ${best.sellExchange} at +${(best.netProfitPct * 100).toFixed(3)}% net${C.reset}`);
    } else {
      console.log(`  ${C.dim}No profitable spread right now. This is normal - arb windows are brief.${C.reset}`);
    }
  } else {
    console.log(`  ${C.yellow}Skipping - one or more price feeds failed above.${C.reset}`);
  }

  // ── Phase 3: Authenticated balance checks ────────────────────────────────

  console.log(`\n${C.bold}Phase 3 - Authenticated balance checks (requires API keys)${C.reset}`);

  const authClients: Array<{
    name:   ExchangeName;
    client: IExchangeClient;
    key?:   string;
    secret?: string;
  }> = [
    { name: 'Coinbase', client: coinbase, key: process.env['COINBASE_API_KEY'], secret: process.env['COINBASE_API_SECRET'] },
    { name: 'Kraken',   client: kraken,   key: process.env['KRAKEN_API_KEY'],   secret: process.env['KRAKEN_API_SECRET']   },
    { name: 'Binance',  client: binance,  key: process.env['BINANCE_API_KEY'],  secret: process.env['BINANCE_API_SECRET']  },
  ];

  let anyKeys = false;
  for (const { name, client, key, secret } of authClients) {
    if (!hasKeys(key, secret)) {
      console.log(`  ${C.yellow}!! ${name}: no API keys set - skipping${C.reset}`);
      continue;
    }
    anyKeys = true;
    await test(`${name} USD balance`, async () => `$${(await client.getBalance('USD')).toFixed(2)}`);
    await test(`${name} BTC balance`, async () => `${(await client.getBalance('BTC')).toFixed(6)} BTC`);
    await test(`${name} ETH balance`, async () => `${(await client.getBalance('ETH')).toFixed(6)} ETH`);
  }

  if (!anyKeys) {
    console.log(`\n  ${C.yellow}No API keys found - edit .env to test authenticated endpoints.${C.reset}`);
  }

  // ── Fee reference ─────────────────────────────────────────────────────────

  console.log(`\n${C.bold}Fee breakeven reference${C.reset}`);
  const pairs: [ExchangeName, ExchangeName][] = [
    ['Binance',  'Kraken'],
    ['Binance',  'Coinbase'],
    ['Kraken',   'Coinbase'],
  ];
  for (const [a, b] of pairs) {
    const combined = ((FEES[a] + FEES[b]) * 100).toFixed(2);
    console.log(`  ${a.padEnd(10)} (${(FEES[a] * 100).toFixed(2)}%) + ${b.padEnd(10)} (${(FEES[b] * 100).toFixed(2)}%) = ${combined}% min gross spread`);
  }

  console.log(`\n${C.green}Test complete.${C.reset} Next steps:`);
  console.log(`  npm run dry-run    # scan live prices, no orders placed`);
  console.log(`  # set DRY_RUN=false in .env, then:`);
  console.log(`  npm start\n`);
}

main().catch((err: unknown) => {
  console.error(`\n${C.red}Fatal: ${(err as Error).message}${C.reset}\n`);
  process.exit(1);
});
