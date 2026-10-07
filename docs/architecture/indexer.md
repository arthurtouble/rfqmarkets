# Chain-derived read model

The clearing contract is the sole source of customer balances and positions. The indexer is disposable infrastructure: it converts finalized contract history into fast account and activity queries, but no settlement decision, withdrawal or risk check trusts it.

## Executable local shape and production path

The repository now includes a small executable chain indexer in `services/indexer`. It follows clearing logs, stores canonical block hashes and derived account/activity projections in SQLite WAL, and exposes only the bounded HTTP surface below. On a canonical-hash mismatch it discards derived state and deterministically rebuilds from the deployment block. Customer accounting remains on-chain; deleting this database loses no authoritative financial state.

This implementation is appropriate for the complete local stack and fault work. For production, retain its narrow API and event semantics while moving storage to PostgreSQL and adding redundant RPC reads, metrics, backups and measured Base reorg/finality policy. Ponder remains a framework candidate rather than a dependency requirement.

Ponder is intentionally absent from `package.json` today. Installing `ponder@0.17.10` on 2026-09-08 produced seven production audit findings, including five high-severity findings in its pinned Hono, Drizzle, Kysely and Vite tree. Re-enable it only when an upstream release or tested overrides pass indexing, reorg, query and audit gates.

## Tables

All integer financial fields remain decimal strings at the HTTP boundary and `bigint` or numeric columns internally.

| Table | Primary key | Content |
| --- | --- | --- |
| `blocks` | block number | Canonical block hash, parent and timestamp. |
| `activity` | transaction hash + log index | Typed clearing events, account/market indexes and JSON payload. |
| `accounts` | account address | Latest included collateral and both position snapshots. |
| `finalized_accounts` | account address | Independently advanced projection at the configured confirmation boundary. |
| `metadata` | key | Finalized projection cursor and rebuild metadata. |
| `liquidation_marks` | transaction hash + log index | Oracle bid/ask stored at the end of each `Liquidated` event's block, used to price partial keeper closes in portfolio history. |

Event rows are immutable for a canonical block. Account rows are replaceable projections. Every affected account is read with `collateralOf(account)` and both `positionOf(account, market)` at one block tag because the events do not contain every resulting field. Included and finalized aggregate risk are updated by subtracting the prior account values and adding the replacement values. Partial indexes cover open positions, and address cursors keep page work bounded.

## Frontend query surface

The public surface is deliberately narrow:

- `GET /health` returns indexed, finalized and head blocks plus lag.
- `GET /v1/account/:address` returns collateral, margins and both positions with the indexed block.
- `GET /v1/account/:address/activity?cursor=&limit=` returns a bounded, cursor-paginated union of trades, collateral actions and liquidations.
- `GET /v1/risk?finalized=true` returns precomputed aggregate collateral and long/short exposure.
- `GET /v1/positions?finalized=true&cursor=&limit=` returns an indexed page of pseudonymous open positions.
- `GET /v1/protocol` returns pause/resolution state and the current epoch/version metadata needed for display.
- `GET /v1/portfolio/:address`, `/v1/portfolio/:address/history`, `/v1/portfolio/:address/trades` and `GET /v1/funding/:address` return the portfolio history described below.

## Portfolio history

The indexer replays an account's stored events in `(block, logIndex)` order. Each `TradeExecuted` and `PositionClosed` goes through the same arithmetic as `RFQRiskMath.positionTransition` (size, entry price, realized PnL; integer division floors each leg). A partial keeper liquidation emits only `Liquidated`, without a price, so the indexer prices it at the oracle side (bid for a long, ask for a short) it stored for that block in `liquidation_marks`. This price is exact when the block holds one price update for the market; a liquidation indexed before that table existed is closed at entry (zero realized PnL) and the response sets `incomplete: true`. A `Liquidated` event is a partial close unless the same transaction emitted a `PositionClosed` for that leg's whole size.

The replay reconciles with on-chain collateral: `collateral = netDeposits + netPnl + deficitCovered`, where `netPnl = realizedPnl - fees + funding - liquidationPenalties`. Responses carry both this replayed `collateral` and the indexer's `indexedCollateral` read from the contract, so a client can detect drift. Replays are cached per account, finality and indexed block.

All amounts are decimal strings in USDC micro-units (6 decimals). Sizes (`baseDelta`, `size`) are base units with 18 decimals. Prices are USDC micro-units per whole base unit. Times are unix milliseconds of the block. `finalized=true` limits a read to the confirmation boundary; the default includes every indexed block. Invalid parameters return `400 {"error": "..."}` (`invalid account`, `invalid interval`, `invalid market`, `invalid cursor`). An address with no events returns zeros, not 404.

`GET /v1/portfolio/:address?finalized=` returns the summary:

```json
{
  "account": "0x…", "finality": "included", "indexedBlock": 1234, "finalizedBlock": 1232,
  "realizedPnl": "7500000", "fees": "2000000", "funding": "-2000000",
  "liquidationPenalties": "3000000", "deficitCovered": "0", "netPnl": "500000",
  "deposits": "1000000000", "withdrawals": "100000000", "netDeposits": "900000000",
  "collateral": "900500000", "indexedCollateral": "900500000",
  "volume": "160000000", "tradeCount": 2, "fundingCount": 1,
  "positions": { "BTC": { "size": "250000000000000000", "entryPrice": "100000000" },
                 "ETH": { "size": "0", "entryPrice": "0" } },
  "firstEventMs": 36000000, "lastEventMs": 43200000, "incomplete": false
}
```

`funding` is the account's net funding PnL (positive means received). `volume` sums `|baseDelta| * price` over `TradeExecuted` only; `tradeCount` counts `TradeExecuted`. `indexedCollateral` is `null` before the account is indexed.

`GET /v1/portfolio/:address/history?interval=event|1h|1d&limit=1..2000&finalized=` (defaults `event`, 500) returns cumulative points for a chart, ascending:

```json
{
  "account": "0x…", "interval": "1d", "finality": "included", "indexedBlock": 1234, "truncated": false,
  "points": [{ "timeMs": 0, "blockNumber": 12, "realizedPnl": "7500000", "fees": "2000000",
               "funding": "-2000000", "liquidationPenalties": "3000000", "netPnl": "500000",
               "netDeposits": "900000000", "collateral": "900500000" }]
}
```

`event` emits one point per block that changed a total. `1h` and `1d` keep the last point of each UTC bucket, stamped with the bucket start; buckets without events are omitted, so a chart should carry the previous value forward. `limit` keeps the newest points and `truncated` says whether older ones were dropped. Plot `netPnl` for performance and `netDeposits` separately for funds moved in and out; `collateral` is their sum plus any deficit cover.

`GET /v1/portfolio/:address/trades?cursor=&limit=1..100&market=BTC|ETH&finalized=` returns fills newest first:

```json
{
  "items": [{ "txHash": "0x…", "logIndex": 1, "blockNumber": 12, "timeMs": 43200000,
              "kind": "trade", "market": "BTC", "baseDelta": "-500000000000000000",
              "price": "120000000", "fee": "1000000", "notional": "60000000",
              "sizeBefore": "1000000000000000000", "sizeAfter": "500000000000000000",
              "entryPriceBefore": "100000000", "entryPriceAfter": "100000000",
              "realizedPnl": "10000000", "cumulativeRealizedPnl": "10000000", "finality": "included" }],
  "nextCursor": "12:1", "realizedPnl": "7500000", "indexedBlock": 1234
}
```

`kind` is `trade` (`TradeExecuted`), `close` (`PositionClosed`: paused close or full liquidation) or `liquidation` (partial keeper close at the stored oracle side). `cumulativeRealizedPnl` runs across both markets even when `market` filters the page. Pass `nextCursor` (`block:logIndex`) back as `cursor`; it is `null` on the last page.

`GET /v1/funding/:address?cursor=&limit=1..100&market=BTC|ETH&finalized=` returns `FundingSettled` events newest first:

```json
{
  "items": [{ "txHash": "0x…", "logIndex": 0, "blockNumber": 12, "timeMs": 43200000, "market": "BTC",
              "payment": "2000000", "amount": "-2000000", "cumulativeFunding": "-2000000",
              "finality": "included" }],
  "nextCursor": null, "totalFunding": "-2000000", "indexedBlock": 1234
}
```

`payment` is the event value (positive means the account paid); `amount = -payment` is its PnL effect. `cumulativeFunding` runs across both markets; `totalFunding` sums `amount` over the filtered market.

The web edge (`deploy/cloudflare/static/web-edge.mjs`) and the dev runtime route these paths to the indexer like `/v1/activity`.

The frontend queries the indexer directly for history and current projections. It compares `indexedBlock` with the RPC head and shows a syncing state when lag exceeds the configured bound. Transaction submission status comes from the wallet/API receipt path first; the UI then replaces it with indexed canonical history. It never invents a second balance from optimistic client arithmetic.

## Reorg and recovery rules

The indexer owns rollback of its derived tables. UI activity is `included` or `finalized`; submitted transaction state comes from the API sender journal. A changed canonical hash rebuilds projections. The API journal stores quote commitments, signatures and signed sender transactions because those cannot be reconstructed solely from successful chain events; it does not copy account balances.

Recovery deletes the disposable local SQLite file or restores production Postgres, starts from the configured deployment block, and checks a deterministic sample of indexed account/position rows against direct contract reads. Trading may continue only if the API's independent live state is healthy; frontend history remains visibly syncing until the indexer reaches its lag target.

## Contract event improvement before testnet

Add a compact `AccountStateChanged` event emitted after deposit, withdrawal, trade, funding settlement and liquidation, or retain event-block state reads and benchmark them. The event reduces RPC load and makes historical auditing easier, but it increases clearing bytecode that is already near the project size gate. The preferred production split moves view/resolution helpers out first, then adds the event if the measured indexing savings justify it.
