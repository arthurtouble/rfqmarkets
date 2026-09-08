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
| `account` | account address | Current collateral, initial/maintenance margin, latest indexed block and transaction. |
| `position` | account + market | Signed base size, entry price, last funding index and latest indexed block. |
| `trade` | transaction hash + log index | Intent hash, account, market, base delta, execution price, fee, block time and finality state. |
| `collateral_event` | transaction hash + log index | Deposit or withdrawal amount and resulting on-chain collateral. |
| `liquidation` | transaction hash + log index | Account, market, closed base, penalty, keeper reward and post-event position/account snapshot. |
| `protocol_event` | transaction hash + log index | Epoch, resolution and other user-visible safety-state transitions. |
| `indexer_status` | chain ID + contract | Indexed block/hash, finalized block/hash and health metadata exposed to the UI. |

Event rows are immutable for a canonical block. Current account and position rows are replaceable projections. Every mutation handler reads `collateralOf(account)` and both `positionOf(account, market)` at the event's block using Ponder's cached client. This is required because the current events do not contain funding settlement and every resulting account field. Ponder documents that its event-scoped `readContract` defaults to the current event block, which makes the snapshot deterministic.

## Frontend query surface

The public surface is deliberately narrow:

- `GET /health` returns indexed, finalized and head blocks plus lag.
- `GET /v1/account/:address` returns collateral, margins and both positions with the indexed block.
- `GET /v1/account/:address/activity?cursor=&limit=` returns a bounded, cursor-paginated union of trades, collateral actions and liquidations.
- `GET /v1/protocol` returns pause/resolution state and the current epoch/version metadata needed for display.

The frontend queries Ponder directly for history and current projections. It compares `indexedBlock` with the wallet RPC head and shows a syncing state when lag exceeds the configured bound. Transaction submission status comes from the wallet/API receipt path first; the UI then replaces it with indexed canonical history. It never invents a second balance from optimistic client arithmetic.

## Reorg and recovery rules

The indexer owns rollback of its derived tables. UI activity is `included` or `finalized`; submitted transaction state comes from the API sender journal. A changed canonical hash rebuilds projections. The API journal stores quote commitments, signatures and signed sender transactions because those cannot be reconstructed solely from successful chain events; it does not copy account balances.

Recovery deletes the disposable local SQLite file or restores production Postgres, starts from the configured deployment block, and checks a deterministic sample of indexed account/position rows against direct contract reads. Trading may continue only if the API's independent live state is healthy; frontend history remains visibly syncing until the indexer reaches its lag target.

## Contract event improvement before testnet

Add a compact `AccountStateChanged` event emitted after deposit, withdrawal, trade, funding settlement and liquidation, or retain event-block state reads and benchmark them. The event reduces RPC load and makes historical auditing easier, but it increases clearing bytecode that is already near the project size gate. The preferred production split moves view/resolution helpers out first, then adds the event if the measured indexing savings justify it.
