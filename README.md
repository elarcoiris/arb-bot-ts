# Coinbase + Kraken + Binance Arbitrage Bot

Monitors BTC, ETH, SOL prices across all three exchanges in real time and executes simultaneous buy/sell orders when a profitable spread exists after fees. Evaluates all **6 direction pairs** on every price tick.

---

## How it works

```
Coinbase WebSocket ─┐
Kraken WebSocket   ─┼─→ ArbitrageEngine ─→ evaluate all 6 directions
Binance WebSocket  ─┘         │
                        net profit > threshold?
                              │ yes
                        re-fetch prices to confirm
                              │
                        check balances
                              │
               ┌──────────────┴──────────────┐
          buy leg                        sell leg
    (e.g. Binance)                   (e.g. Coinbase)
               └──────────────┬──────────────┘
                        wait for fills
                              │
                          log P&L
```

Both legs fire **simultaneously** to minimize price-change risk. The engine uses a mutex so only one trade runs at a time.

---

## Fee schedule (taker rates)

| Exchange | Taker fee | Breakeven when paired with… |
|----------|-----------|-----------------------------|
| Binance  | 0.10%     | Kraken: **0.36%** gross spread · Coinbase: **0.70%** |
| Kraken   | 0.26%     | Binance: **0.36%** · Coinbase: **0.86%** |
| Coinbase | 0.60%     | Binance: **0.70%** · Kraken: **0.86%** |

Binance↔Kraken is the most profitable direction due to lowest combined fees.

---

## Quickstart

### 1. Install dependencies

```bash
npm install
```

### 2. Get API keys

**Coinbase Advanced Trade**
1. Go to https://www.coinbase.com/settings/api
2. Create a key with **View** + **Trade** permissions

**Kraken**
1. Go to https://www.kraken.com/u/security/api
2. Create a key with **Query Funds** + **Create & Modify Orders**

**Binance**
1. Go to https://www.binance.com/en/my/settings/api-management
2. Create a key with **Enable Reading** + **Enable Spot & Margin Trading**
3. ⚠️ US users must use **Binance.US** (api.binance.us) — see `.env.example`

### 3. Configure

```bash
cp .env.example .env
# Open .env and fill in your six keys
```

Key settings:

| Variable         | Default           | Description                              |
|------------------|-------------------|------------------------------------------|
| `DRY_RUN`        | `true`            | `false` to place real orders             |
| `TRADE_SIZE_USD` | `500`             | Max USD per arbitrage leg                |
| `MIN_PROFIT_PCT` | `0.15`            | Minimum net profit % after all fees      |
| `PAIRS`          | `BTC-USD,ETH-USD` | Pairs to monitor                         |

### 4. Test connectivity

```bash
node src/test-connection.js
```

Checks all public price feeds, prints a live 6-direction spread table, and (if keys are set) verifies authentication and prints your balances.

### 5. Dry run

```bash
npm run dry-run
```

Scans live prices and logs every opportunity it *would* trade — no orders placed.

### 6. Live trading

```bash
# Set DRY_RUN=false in .env first
npm start
```

---

## Architecture

```
src/
  index.js            Entry point, CLI dashboard, WebSocket orchestration
  coinbase.js         Coinbase Advanced Trade REST + WebSocket client
  kraken.js           Kraken REST + WebSocket v2 client
  binance.js          Binance Spot REST + WebSocket client
  engine.js           Generic N-exchange spread calculator + trade executor
  test-connection.js  Pre-flight checks for all three exchanges
.env.example          Configuration template
```

The engine is exchange-agnostic — it accepts a `{ name: client }` map and evaluates every permutation. Adding a fourth exchange means writing one new client file and registering it in `index.js`.

---

## Important risks

**Execution risk** — Spreads close in milliseconds. The bot re-confirms prices before committing and cancels the surviving leg if one fails.

**Slippage** — Market orders may fill slightly worse than the quoted bid/ask, especially at larger sizes. Keep `TRADE_SIZE_USD` modest relative to typical order book depth.

**Pre-funded accounts** — The bot does not move funds between exchanges. You need USD and coin balances on all three exchanges simultaneously (USD on potential buy sides, coins on potential sell sides).

**Binance.US** — Binance is not available to US persons via binance.com. Set `BINANCE_BASE_URL` and `BINANCE_WS_URL` in `.env` if you're using Binance.US.

**API rate limits**
- Binance: 1200 weight/min (bookTicker = 2 weight; order = 1 weight)
- Coinbase: 30 req/s private
- Kraken: 15 calls/min (tiered by tier level)

WebSocket mode avoids most rate-limit pressure since prices arrive as pushed events rather than polled requests.

---

## Extending the bot

- **Add an exchange**: Implement `getBestBidAsk`, `placeMarketOrder`, `getBalance`, `cancelOrder`, `getOrder`, `connectWebSocket` (same interface as existing clients), then add to the `exchanges` map in `index.js`.
- **Limit orders**: Replace market orders with IOC limit orders placed slightly inside the spread for better fill prices at the cost of fill certainty.
- **Telegram/Discord alerts**: Hook `engine.on('opportunity', ...)` to post a notification.
- **P&L database**: Write trade records in the `tradeComplete` handler to SQLite for analysis.
- **BNB fee discount**: On Binance, paying fees in BNB reduces the taker rate to 0.075%. Update `FEES.Binance` in `engine.js` and set `feeAsset=BNB` in order params.
