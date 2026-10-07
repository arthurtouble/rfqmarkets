# Adding a market

Markets live in the clearing contract's registry. Governance lists one with `RFQClearing.addMarket`; the contract holds at most 128. You don't need a contract upgrade or a service code change. The API, approvers, indexer and keeper read the registry at boot and again every 60 seconds (`RFQ_MARKET_REFRESH_MS`, minimum 1000). The API and approvers also refresh early when a request names a market they don't know yet. The hedger follows the markets in the indexer's exposure report, and the gateway follows the markets in the API stream. Four pieces have to be in place before customers can trade a new market:

1. The governance listing.
2. Oracle coverage.
3. A hedge mapping.
4. Caps.

`scripts/add-market-e2e.mjs`, which is part of `npm run test:contracts`, runs this whole path on the local chain. It lists SOL while the API is running, then opens, reduces and margins a SOL position through the API.

## 1. Governance call

`addMarket(MarketConfig)` appends the next index and emits `MarketAdded`, `MarketPolicyUpdated`, `ExposurePolicyUpdated` and `MarketRiskUpdated`. It also increments `policyVersion`, which invalidates every outstanding approval.

| Field | Meaning | Bounds |
| --- | --- | --- |
| `symbol` | `bytes32` ticker such as `encodeBytes32String("SOL")` | Unique and non-zero. Services accept letters, digits, `.`, `_` and `-`, up to 31 bytes (`kPEPE` is valid). |
| `enabled` | Whether new risk is allowed | List with `false`, enable later with `setMarketPolicy` |
| `maxTradeNotional`, `maxMarketNotional` | Single-trade cap and net customer notional cap, in USDC 1e6 units | `0 < maxTrade ≤ maxMarket`, at most 1M and 5M USDC |
| `grossLimit`, `sideLimit` | Gross open interest cap and per-side cap | `0 < sideLimit ≤ grossLimit ≤ 5M` USDC |
| `impactK` | Inventory-impact coefficient | 1 to 1,000,000 |
| `shockBps` | Stress shock used by `portfolioStress` | 500 to 10,000 |
| `marginScaleBps` | Multiplier on the base margin tiers (10,000 = 1x) | 2,500 (20x first tier) to 50,000 |

Production governance is the 72-hour timelock. Queue the exact calldata, list the market disabled with minimal caps, and enable it only after the market passes the checks in the next sections. `addMarket` reverts while resolution is active. Indexes are permanent: never reuse one or reinterpret it.

When it runs, `policyVersion` changes, so any quote in flight fails. The block-pinned `marketCount` read then exposes a registry that lags the chain. In that case the API and approvers refresh, and they fail closed (503 `market registry unavailable`) until the refresh succeeds. They never under-count stress.

## 2. Oracle configuration

`SignedPriceOracle` is market-agnostic. New markets use its default jump guard; set a tighter one with `setMarketJumpLimit(market, maxJumpBps)` if needed. A market without a fresh signed price can't trade. The keeper refreshes and samples only markets that have open interest, so an idle unpriced listing doesn't block it.

On each node (`services/oracle-node`):

- The symbol needs an entry in `src/symbols.ts`. `SYMBOLS` covers about 40 assets. To add one, set `base` and `exclude` (list the venues without a liquid pair), plus `tickers` overrides or a lot `multiplier` (`kPEPE` = 1000 PEPE). Then run `node --import tsx --test services/oracle-node/src/*.test.ts`.
- With `ORACLE_RPC_URL` and `ORACLE_CLEARING_ADDRESS` set, the node prices every registered market that has an entry in its table. It re-reads the registry every `ORACLE_MARKET_REFRESH_MS` (60 s by default). It logs once when it skips a registered market that has no table entry. If `ORACLE_MARKETS` is also set, it is an `id:symbol` allowlist: the node prices only listed markets, and it refuses to sign for an index whose on-chain symbol differs from the list (the signed price carries only the index). The RPC must be https unless it is loopback.
- Without a registry, the node prices exactly `ORACLE_MARKETS` (`0:BTC,1:ETH,2:SOL`). Add the new index on every node.
- Cloudflare oracle workers (`deploy/cloudflare/runtime/oracle-worker.mjs`) always pass the worker's `ORACLE_MARKETS` var (set in `wrangler.oracle.jsonc`, launch markets `0:BTC,1:ETH`) and add the registry when the worker has an `ORACLE_RPC_URL` secret and the deployment records `contracts.clearingProxy`. Add the new `id:symbol` to that var on every node, or the nodes will not price it. The container only picks up new env on restart, so redeploy the worker after changing either one.

Signing needs a majority of nodes, and each node needs its aggregation minimum of venues (`ORACLE_MIN_SOURCES`, 3 by default). Check each node's `/health` `markets[]` and confirm the new index shows `included: true` before you enable the market.

The API's own market-data sources (`services/api/src/oracle.ts`) work as follows:

| Source | How it picks up the market |
| --- | --- |
| Signed and simulated | Automatic |
| Coinbase | Subscribes to `<SYMBOL>-USD` |
| Pyth | Needs a feed id per symbol. In persistent configs, `feedIds` accepts a `{ "SOL": "0x…" }` map. |

A market with no price is left out of `/v1/markets` and can't be quoted.

## 3. Hedger mapping

`services/hedger/hedge-markets.json` maps a market symbol to its Hyperliquid perp coin, for example `"SOL": "SOL"` or `"kPEPE": "kPEPE"`. `RFQ_HEDGE_MARKETS_FILE` points the hedger at a different file. The coin also has to appear in the venue's `sz_decimals`, which `hyperliquid_bridge.py` reads from the exchange metadata.

A market without a mapping is never sent to the venue. The hedger logs it once and reports the market `reduce_only` with reason `no_hedge_mapping` (status `unhedged`), so the API and approvers admit only exposure-reducing trades in it. Restart the hedger after you edit the file.

## 4. Caps and enablement

1. Size `maxTradeNotional`, `maxMarketNotional`, `grossLimit` and `sideLimit` against maker backing. Stress capital (`portfolioStress ≤ makerBacking / 4`) now includes the new market's `shockBps`.
2. Size the hedger's `hedgeBandUsdc`, `hedgeMaxOrderUsdc` and `hedgeMinOrderUsdc` for the new venue's depth.
3. Fund hedge margin, then enable with `setMarketPolicy(market, true, …)` and minimal caps. After that, follow the staged limit procedure in [Market lifecycle](market-lifecycle.md).
4. Session keys: a session's `marketMask` has one bit per index. Existing sessions don't cover the new market until the user signs a new grant (the web app's quick session still requests `marketMask: 3`).

## Verify

- `GET /v1/config` `marketList` and `GET /v1/markets` list the new symbol, and the market entry includes its `index`.
- The indexer's `/v1/exposure` and account positions show the market. An indexer upgraded from schema 1 reindexes from `startBlock` once.
- The gateway relays history, candles and 24h stats for the market as soon as it appears in the API stream.
- The trading app lists the market on the Markets page and in the market switcher with no release. Its display name comes from `MARKET_NAMES` in `apps/web/src/ui/primitives.tsx` (the symbol when it is not there), and until the oracle prices it the row reads **No price** and its trade page says the market has no price.
- The `apps/web` client still hardcodes BTC/ETH in several places, so it doesn't show the market yet.
