# Price oracle

RFQ Markets prices every trade, liquidation and resolution from its own signed oracle. Three oracle nodes run on Cloudflare, one each in the US (`wnam`), Europe (`weur`) and Asia (`apac`). Each signs a price batch about once a second, and the on-chain `SignedPriceOracle` accepts a majority of them. It replaced Pyth Core and Chainlink Data Streams in October 2026, which charged per asset and needed paid API keys.

The platform lists only markets that trade 24/7, so there is no closed-market mode. Prices are mids. The platform quotes its own spreads around them.

## Nodes

`services/oracle-node` streams top-of-book from Coinbase, Kraken, Bitstamp, Gemini, OKX, Bybit and Binance. Each venue has a REST fallback and a per-symbol exclusion list (`src/symbols.ts`). For each market, a node runs these steps every tick:

1. Drops stale and crossed quotes, and quotes wider than `ORACLE_MAX_WIDTH_BPS`.
2. Converts USDT and USD quotes to USDC through stablecoin legs, with a depeg bound.
3. Takes the median mid across venues and rejects outliers beyond `ORACLE_MAX_DEVIATION_BPS`.
4. Requires at least `ORACLE_MIN_SOURCES` venues.
5. Signs the passing markets as one EIP-712 `PriceBatch(uint64 observedAt, Price[] prices)`, where each `Price` is `(uint8 market, uint256 bid, uint256 ask)`. The domain is `"RFQ Markets Oracle"`, version `"1"`, the chain and the adapter address.

Prices are in USDC micro-units per market unit. A node serves:

- `/health`
- `/v1/batch/latest`
- `/v1/batch/stream` (SSE)
- `/v1/candles`

On Cloudflare, each node is its own worker, `oracle-<n>` (`deploy/cloudflare/runtime/oracle-worker.mjs`). Its Durable Object:

- generates the signing key on first start and keeps it only in Durable Object storage;
- publishes the address to KV `oracle-node-<n>.json`;
- runs the node container;
- signs only for the adapter in KV `deployment.json`, and only if that adapter's signer set includes this node.

## On chain

`contracts/oracle/SignedPriceOracle.sol` verifies a report, which is `abi.encode(SignedPriceBatch[])`. A report must pass these checks:

- Only the clearing house may call `verify`.
- The batches must come from at least `threshold` distinct authorized signers. The threshold must be a majority.
- Batch timestamps must be within `maxSkew` of each other, and none may be in the future.

Each market present in at least `threshold` batches is then handled like this:

- **Disagreement:** if the signers' mids differ by more than `maxDeviationBps`, the market is skipped.
- **Price:** otherwise the price is the median bid and median ask. With an even number of batches, the bid rounds down and the ask rounds up.
- **Jumps:** a move larger than the market's jump limit within `jumpWindow` is also skipped.

A skipped market simply has no fresh price. The clearing house therefore refuses trades on it, and a disagreement pauses that market instead of letting a doubtful price through. The report's `validUntil` is its oldest batch time plus 15 seconds. The clearing house separately enforces its own 8-second freshness and 1% width limits.

The owner (governance) manages the oracle with these calls:

- `setSigners` rotates nodes.
- `setConsensusParams` sets the deviation and skew limits.
- `setJumpGuard` and `setMarketJumpLimit` set the jump limits.
- `setClearing` binds the oracle once. Production does this inside the timelocked go-live.

## Off-chain consumers

`SignedOracleClient` (`packages/shared/src/signed-oracle.ts`) subscribes to every node's stream, falls back to REST polling, and combines the newest batch from each signer under the same rules as the contract. The API's `SignedOracleSource` serves each market the combined report, and approvers in `signed` mode dry-run the adapter for the consensus price.

## Markets

Governance lists markets with `RFQClearing.addMarket`, which accepts at most 128. Each market has:

- a symbol;
- caps;
- an impact coefficient;
- a stress shock;
- a margin scale.

`setMarketRisk` retunes a market. Neither needs an upgrade. The nodes price whatever markets they are configured for (`ORACLE_MARKETS`). A new market goes live once at least two nodes cover it on enough venues.

## Price history

Every node's Durable Object syncs from its container into SQLite every minute:

- Every signed batch is kept for 30 days, with its signature, so anyone can check that an execution price matches a price signed for the adapter's domain.
- 1-minute candles are kept permanently.

Both are served from SQLite, so they stay available while a container restarts:

- `/v1/history/batches?market=&from=&to=` returns signed batches.
- `/v1/history/candles?market=&interval=1m|5m|15m|1h|4h|1d&from=&to=` returns candles.

## Adding 24/7 stock markets

Candidate sources for always-open equity prices:

- Hyperliquid's trade.xyz markets.
- The stock perpetuals on Binance, Bybit, Bitget and OKX.
- Tokenized stocks: xStocks on Kraken and Raydium, Binance bStocks and Ondo.

A stock market should use several of these. A single source must not be enough on its own.
