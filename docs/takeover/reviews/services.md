# RFQ Markets: backend services and shared package audit

Scope: `services/**` (api, approver, gateway, indexer, keeper, hedger, `hyperliquid_bridge.py`), `packages/shared/**`, `tsconfig.json`, `Dockerfile.host`, `Dockerfile.cloudflare`, `deploy/host/**`, `deploy/operations/**`, `scripts/{local-stack,base-sepolia-stack,persistent-service,persistent-config,runtime-identity,approver-process,prepare-cloudflare-runtime,cloudflare-container}.ts`, and the docs LOCAL-DEVELOPMENT, SIMPLIFIED-DESIGN, HEDGING-OPERATIONS, INDEXER-DESIGN, SCALE-AND-STREAMING and PRODUCT-READ-MODEL-AND-ORDERS. Repo HEAD is `bae3332`. No repo files were modified.

Line references are `file:line`. Where a line is very long, the reference points to that line. "Inferred" marks conclusions I reached by reasoning about the code rather than by running it.

---

## 0. Validation results

| Command | Result |
|---|---|
| `npm ci` | OK. 344 packages; npm audit reports 13 vulnerabilities (6 low, 4 moderate, 3 high), mostly in the dev tree. |
| `npm run typecheck` | **Pass** in about 2 s. The compiler is **TypeScript 7.0.2**, the native Go compiler (`npx tsc --version` → `Version 7.0.2`). |
| `npm run test:services` (Node v22.22.0 in this sandbox) | **166/166 pass** in about 9 s. My first run had 11 file-level failures with `ERR_MODULE_NOT_FOUND` for `node_modules/tsx`, `ethers` and `esbuild`. The cause was a concurrent `npm ci` rewriting `node_modules` while the tests ran (inferred: sibling audit agents share the checkout). A clean re-run passed everything. |

Warnings: `node:sqlite` prints `ExperimentalWarning` 11 times. CI baseline is Node 24, which I did not run here.

Test inventory: 26 service test files and about 18 `scripts/*.test.ts` files. The tests for `packages/shared` live in `scripts/` (for example `scripts/gross-reservations.test.ts`, `scripts/exposure-admission.test.ts`, `scripts/pricing.test.ts`), not next to the package. There is **no `services/approver` test file**; the approver is exercised only through `services/api/src/server.test.ts`. `services/keeper/src/server.ts` (the RPC and indexer wiring) has no unit test; only `engine.ts` does (7 tests).

---

## 1. Services

### Size and density

| File | Lines | Bytes | Max line | Lines >160 chars |
|---|---:|---:|---:|---:|
| services/api/src/server.ts | 544 | 93,411 | **3,013** | 173 |
| services/approver/src/server.ts | 151 | 26,108 | 1,349 | 60 |
| services/indexer/src/server.ts | 99 | 19,318 | 1,616 | 36 |
| services/api/src/sender.ts | 72 | 14,029 | 819 | 30 |
| services/hedger/src/server.ts | 56 | 12,990 | 1,369 | 27 |
| services/api/src/oracle.ts | 158 | 16,071 | 681 | 26 |
| services/keeper/src/server.ts | 40 | 6,511 | 834 | 16 |
| services/gateway/src/server.ts | 20 | 4,013 | 1,000 | 6 |
| packages/shared/src/pricing.ts | 40 | 6,816 | 1,700 | 13 |
| services/hedger/hyperliquid_bridge.py | 236 | 10,552 | 252 | 2 (PEP 8 style, readable) |

Line counts understate the code size. The API server alone is 93 KB, about 2,500 to 3,000 lines at a normal 100-column width.

All TypeScript services follow the same pattern. A `buildX(options)` factory returns a Fastify 5 instance with `logger:false`. Long-running work is driven by `setInterval`, and state goes into a private `node:sqlite` `DatabaseSync` file in WAL mode. No service reads `process.env` directly. Wiring and env parsing live in the `scripts/*` entrypoints.

### 1.1 API, the execution leader (`services/api/src/server.ts`, `buildApi`)

**Purpose.** The API is the single active leader and does all of the following:
- quoting (adaptive spread, inventory impact, pending envelope);
- EIP-712 intent preparation;
- 2-of-3 approval collection;
- sponsored transaction signing and broadcast through `DurableSender`;
- market SSE source;
- account read model (direct RPC);
- deposit simulator, withdraw, cancel nonce, close position, session grant;
- resting limit-order book and executor;
- dev-chain helpers (clock advance, autofund).

**Routes** (`server.ts:298-402`):

| Route | Notes |
|---|---|
| `GET /health` | `ok` is false whenever any sender row is `signed`/`submitted`/`ambiguous`/`reorged` (`:298`). Health therefore reports false while any normal trade is in flight (inferred). |
| `GET /internal/metrics` | Bearer `operationsToken` (`:299`). |
| `GET /v1/config` | Chain, RPC and addresses for the UI (`:300`). |
| `GET /v1/dev/wallet` | Only when `localDevMode` (31337 + loopback + devFund) (`:301`, guard `:152-153`). |
| `GET /v1/markets` | Cached 500 ms coherent snapshot (`:236-256`). |
| `GET /v1/markets/stream` | SSE source, ConnectionBudget-limited (`:303-307`). |
| `GET /v1/account/:address` | 7 RPC reads plus a liquidation-price bisection, 80 iterations per market (`:308-328`). It catches **every** error as `400 invalid account` (`:327`), which hides RPC outages. |
| `POST /v1/deposit/quote`, `/v1/deposit/execute` | Local simulator only: hardcoded ETH = 2,500 USDC (`:334`), `mint` plus `depositWithAuthorization` with zeroed v/r/s (`:361`). Returns 503 unless devFund (`:350`). |
| `POST /v1/withdraw/{prepare,execute}` | Prepare then execute. Execute verifies the signature (EOA or ERC-1271) and submits through the sender (`:366-367`). |
| `POST /v1/nonce/cancel/{prepare,execute}` | Same pattern (`:368-369`). |
| `POST /v1/close/{prepare,execute}`, `/v1/close/quote` | Same pattern (`:370-371`, `:385`). |
| `POST /v1/session/{prepare,execute}` | Same pattern (`:372-373`). |
| `POST /v1/orders/prepare`, `POST /v1/orders`, `GET /v1/orders/:address`, `POST /v1/orders/:orderId/cancel/prepare`, `POST /v1/orders/:orderId/cancel` | Limit orders (`:374-378`). |
| `POST /v1/quote` | Firm quote (`:379-384`). |
| `POST /v1/prepare` | Binds quote → (account, nonce) and returns typed data (`:386-401`). |
| `POST /v1/approve` | Admission, reservation, quorum, simulation, submission and receipt (`:402-520`). |

**State.** Most state is in memory, inside one closure:
- `quotes`, `quoteReports`, `quoteVersions`, `quoteBindings`, `preparedIntents`, `forcedReduceOnly`, `approvalQuorums` (up to 100k cached promises, `:200`);
- `activeSubmissions`, `completedSubmissions`, `restingOrders`, `deposits`;
- `PendingExposureBook`, `GrossReservationBook`, `LimitTriggerBook`, `FlowRiskTracker`;
- several caches (`:116-163`).

These are the durable tables in the `journalPath` SQLite file:

| Table(s) | Defined at | Purpose |
|---|---|---|
| `commitments`, `deposit_routes`, `resting_orders`, `flow_fills` | `:109` | Commitments, deposits, orders, fill history |
| `approval_artifacts`, `archived_*` | `recovery.ts:14` | Approval payloads and archives |
| `gross_reservations`, `gross_migrations`, `gross_context`, `gross_clock` | `packages/shared/src/gross-reservation-journal.ts:3` | Gross capacity reservations |
| `sender_transactions`, `sender_attempts`, `sender_budget` | `sender.ts:14` | Sponsor transactions and daily budget |

On restart, `restoreApiCommitments` rebuilds active quotes and intents from the approval artifacts (`recovery.ts:18-41`). Open orders are reloaded at `:133` and deposits at `:129-132`.

**Talks to:**
- **Chain** through ethers `JsonRpcProvider` with `batchMaxCount:1` and a `Contract` built from `clearingApiAbi`.
- **Approvers** with `POST {url}/approve` and a bearer token, timeout `approverTimeoutMs` defaulting to 1,000 ms (`:188-202`).
- **Hedger** with `GET /internal/risk` through `HttpHedgeRiskSource` (200 ms cache, 500 ms timeout; `hedge-risk.ts:6`).
- **Oracle** through `OracleSource`, implemented by `CoinbaseMarketDataSource` (local, WebSocket plus REST), `ChainlinkDataStreamsSource` and `PythHermesSource` (authenticated SSE plus REST). All three are in `oracle.ts`.

The API does **not** call the indexer.

**Configuration** (`ApiOptions`, `:34-65`): about 30 optional fields (approvers, chain{rpcUrl, sponsorPrivateKey, clearingAddress, tokenAddress, devFund, devWallet}, journalPath, rate-limit knobs, timeouts, operationsToken, trustedProxy, corsOrigin with default `http://127.0.0.1:4173`). Dev and test defaults are hard-coded and live next to production code: fake prices at BTC 100k and ETH 4k (`:135-138`), a verifying contract of `0x…01` (`:149`) and chainId 31337.

**Port:** 4100.

### 1.2 Approver (`services/approver/src/server.ts`, `buildApprover`)

**Purpose.** An independent maker signer. It re-validates the leader's fully specified envelope against its own RPC (plus a secondary RPC block-hash cross-check), the hedger's risk state, the exposure and stress model, and its own durable gross-reservation book. Only then does it sign the `MakerApproval` digest with the raw key (`wallet.signingKey.sign(digest)`, `:142`).

**Routes:**
- `POST /approve` (bearer `transportToken`), at `:37-149`.
- `GET /internal/recovery` (bearer), which exports active approvals and payloads (`:35`).
- `GET /health` (`:36`).

**State.** SQLite at `databasePath` holds `approvals(digest PK, epoch, expiry_ms, signature, payload)`, `archived_approvals` and the gross journal tables (`:26-31`). The order is: admit in memory, then `BEGIN IMMEDIATE` persist gross plus approval, then `COMMIT`, and only then return the signature (`:136-148`). No `await` happens between admission and commit (comment at `:135`).

**Talks to:**
- primary and secondary RPC;
- the hedger's `/internal/risk` (direct `fetch`, uncached, not injectable; `:111`);
- for Pyth, an `eth_call` of the oracle adapter's `verify` (`:98-106`).

**Config:** see `ApproverOptions` at `:17`. The approver-process entrypoint maps these env vars: `RFQ_APPROVER_KEY`, `RFQ_APPROVER_TOKEN`, `RFQ_APPROVER_DB`, `RFQ_CHAIN_ID`, `RFQ_CLEARING_ADDRESS`, `RFQ_RPC_URL`, `RFQ_SECONDARY_RPC_URL`, `RFQ_RPC_BATCH_MAX_COUNT`, `RFQ_APPROVER_PORT`, `RFQ_MAX_FUTURE_SECONDS`, `RFQ_ORACLE_MODE`, `RFQ_BTC/ETH_FEED_ID/DECIMALS`, `RFQ_HEDGE_RISK_URL/TOKEN/MAX_AGE_MS` and `RFQ_QUOTE_MODEL_VERSION` (`scripts/approver-process.ts:3-9`).

**Ports:** 4201-4203 (local).

Findings:
- In Pyth mode the approver accepts any valid on-chain observation; the comment explains the rationale (`:101-104`). The `quote.bid/ask` used for pricing checks come from the leader's payload (`:55`, `:67`). Only the stress and impact checks use `reportObservation` (`:113-131`). This is a deliberate trust choice that should be documented as such.
- The host profile does not set `expectedQuoteModelVersion` (`scripts/persistent-service.ts:36`), but the dev entrypoint does (`approver-process.ts:8`). That check is therefore off in production (inferred).
- The no-chain path (`clearing` undefined) skips most checks (`:48`, `:65`, `:137`) and is reachable only when no `rpcUrl` is given. That is a test-only mode living in the production file.

### 1.3 Gateway (`services/gateway/src/server.ts`)

**Purpose.** A stateless, secret-free SSE fan-out. It holds one upstream SSE connection to the API's `/v1/markets/stream`, with a reconnect backoff of 100 ms to 5 s and a stall watchdog (`:12`). It replays the latest frame to new clients and evicts slow consumers above 256 KB (`fanout.ts:10`).

**Routes:**
- `GET /health`
- `GET /v1/markets/history?market=&limit=` (in-memory, 1,800 points per market; `history.ts`)
- `GET /v1/markets/stream` (`:14-16`)

**State:** in memory only. **Port:** 4500.

### 1.4 Indexer (`services/indexer/src/server.ts`)

**Purpose.** A disposable read model of clearing events and account snapshots.

**Routes** (`:86-97`):
- `GET /health`
- `GET /v1/updates/stream` (SSE invalidations)
- `GET /v1/account/:address`, `GET /v1/account/:address/activity?cursor=&limit=`
- `GET /v1/activity?kind=&market=&finalized=`
- `GET /v1/exposure?finalized=` (reads the contract live, not the database)
- `GET /v1/risk?finalized=`
- `GET /v1/positions?finalized=&market=&cursor=`
- `GET /v1/protocol` (live contract reads)

**State.** SQLite tables `blocks`, `activity`, `accounts`, `finalized_accounts`, `metadata` (`:18`), plus two in-memory `RiskProjection` aggregates.

**Mechanics:**
- It polls every `pollMs` (500 ms), calls `getLogs` over a window of up to 10,000 blocks, and re-reads each affected account (`collateralOf`, plus `positionOf` ×2) at the event block (`:27-30`, `:59`).
- "Finalized" means `head - confirmations` (2 by default, 12 on the host per `persistent-service.ts:34`). It is **not** the `finalized` block tag used by the API, approver and `finalized-clock.ts`, so the system has two different finality definitions.
- A reorg is detected only at the stored tip hash. Any mismatch calls `reset()`, which **deletes all derived state and rebuilds from the start block** (`:26`, `:46`, `:78`).
- Every read endpoint first `await sync()`s (coalesced), so read latency is coupled to RPC latency (`:86-97`).
- `/v1/updates/stream` has **no ConnectionBudget** and no auth (`:87`), unlike the API and gateway streams.
- CORS defaults to `127.0.0.1:4173/4174` (`:12`).

**Port:** 4300.

### 1.5 Keeper (`services/keeper/src/server.ts`, `engine.ts`)

**Purpose.** An independent, single-writer bot with its own sponsor key. Each cycle (2 s) it:
1. reconciles its sender journal;
2. refreshes stale oracle marks (>5 s);
3. simulates `declareResolution` as the "incident" trigger;
4. scans 25 open positions from the indexer (`/v1/positions?finalized=false`), each time first checking that the indexer's `/health` lag is at most 12 (`server.ts:22`);
5. **tries `liquidate` on every scanned account**, using `eth_call` simulation as the health test (`engine.ts:54-60`, `server.ts:29`);
6. during resolution, submits 3 samples per market and then calls `processResolution` in pages of 50 (`engine.ts:42-46`).

A cycle performs at most 4 transactions (`engine.ts:23`).

**Routes:** `GET /health`, `GET /internal/metrics` (bearer) at `server.ts:35-36`.

**State:** SQLite with the sender tables, plus a `gross_context` binding used only as a database identity check (`server.ts:15`).

**Config:** `KeeperOptions` (`server.ts:11`). Explicit budgets are mandatory (`:13`). **Port:** configured on the host. The keeper is **not started** by either `scripts/local-stack.ts` or `scripts/base-sepolia-stack.ts`, so the local and testnet stacks have no liquidation bot. The doc says local work delegates this to "independent keepers" (LOCAL-DEVELOPMENT.md step 1).

Findings:
- Liquidation detection is brute force. Each account costs one oracle proof, one `updateFee` call and one `eth_call`. For N open accounts a full sweep takes N/25 × 2 s, so 1,000 accounts take about 80 s (inferred). The repo already has the margin math (`packages/shared/src/account-risk.ts`, `pricing.marginRate`, API `/v1/account` at `server.ts:313-324`) to pre-filter candidates.
- It probes only one market per account: BTC if non-zero, otherwise ETH (`engine.ts:58`).
- The keeper imports `../../api/src/sender.js` and `../../api/src/oracle.js` (`server.ts:6-7`), creating cross-service coupling to the API's internals.

### 1.6 Hedger (`services/hedger/src/server.ts`, `hyperliquid.ts`, `hyperliquid_bridge.py`)

**Purpose.** Each tick (1 s) the hedger:
1. reconciles outstanding hedge orders;
2. reads `indexer /v1/exposure?finalized=true`;
3. compares each market's `aggregateBase` (the customer net) with the venue position;
4. if the gap exceeds `bandUsdc` (default 25k USDC), sends a capped IOC order toward the middle of the band, with a deterministic `clientId = keccak(rfq:block:market:target:current)` (`server.ts:39-41`).

It also publishes a hedge risk snapshot (`normal`/`guarded`/`reduce_only`) consumed by the API and the approvers (`:49`).

**Routes** (`:50-54`):
- `GET /health`
- `GET /internal/risk` (bearer required)
- `GET /v1/status`, `GET /v1/status/stream` (SSE)
- `POST /v1/tick`

The last three are authenticated **only if** `healthToken` is set (`:48`); without it they are open.

**State:**
- SQLite table `hedge_orders`, migrated through ad-hoc `ALTER`s (`:26-28`);
- `local_venue_*` tables for the simulator venue (`:18`);
- in-memory `lastExposure`, `lastVenuePositions` and `lastExecution`.

**Venue adapters.** `LocalHedgeVenue` (SQLite) and `HyperliquidVenue`, a JSON-lines RPC to a long-lived Python child process (`hyperliquid.ts:59-76`). The child gets the agent key through a scrubbed environment (`packages/shared/src/process-environment.ts`). The bridge (`hyperliquid_bridge.py`) uses the official `hyperliquid-python-sdk==0.24.0`:
- verifies the named agent;
- caches the position for 250 ms and capital for 5 s;
- sends IOC orders with a 10 s expiry, rounding the price inward (`venue_price`, `:61-68`);
- maps the `cloid` to the first 16 bytes of the clientId (`:46-49`);
- sweeps the L2 book for execution-cost and basis signals (`:108-137`).

Findings:
- **Both the TypeScript and Python sides are pinned to testnet** (`hyperliquid.ts:49`, `hyperliquid_bridge.py:32-33`). `persistent-service.ts:38` passes the mainnet URL for `base-mainnet` (`persistent-config.ts:21`), so a mainnet hedger cannot start. Production hedging is not implemented.
- The hedger does **not** independently verify chain state, even though HEDGING-OPERATIONS.md hedge-loop step 1 says to "independently verify the block and aggregate market state through an RPC". It trusts the indexer's `/v1/exposure` (`server.ts:38`).
- CORS origin `http://127.0.0.1:4174` is hard-coded in two places (`:25`, `:53`).
- `parse_order_status` sums `info.user_fills(ACCOUNT)`, which returns only recent fills, by `oid`. Old orders could be undercounted (inferred; bridge `:158`).
- `capital_cache` queries `activeAssetData` for BTC only (`:88`).

**Port:** 4400.

### 1.7 Shared package (`packages/shared/src`)

There is no `package.json`; the package is imported by relative path (`../../../packages/shared/src/x.js`) from every service.

| Module | Contents |
|---|---|
| `abi.ts` | Human-readable ABI fragments (4 subsets) |
| `eip712.ts` | Typed-data definitions, hash/recover helpers, `*ToWire` serializers (8 near-identical functions, `:76-89`) |
| `pricing.ts` | `constructQuote` as a single 1,700-char line (`:40`), adaptive spread, quadratic inventory impact, four-corner pending envelope, margin tiers |
| `policy.ts` | Zod `quoteRequestSchema`; re-exports pricing |
| `wire.ts` | `quoteToWire` |
| `approver-payload.ts` | Zod schema of the leader-to-approver envelope |
| `exposure-admission.ts` | Funding projection, gross/net/side caps, stress |
| `gross-reservations.ts`, `gross-reservation-journal.ts` | Escaped-approval capacity book plus its SQLite journal |
| `expiry-index.ts` | Indexed min-heap |
| `finalized-clock.ts` | Reads the `finalized` tag, optionally cross-checked against a secondary RPC |
| `account-risk.ts`, `hedge-risk.ts`, `connection-budget.ts`, `streams.ts` (Chainlink v3 decode), `process-environment.ts` | Smaller helpers |

---

## 2. End-to-end flows

### 2.1 Market order (firm RFQ)

1. **Indicative price.** The browser subscribes to the gateway at `:4500/v1/markets/stream`, which re-broadcasts the API's `markets` frames. A frame contains bid/ask, funding, settled exposure, the pending envelope, the risk mode and spread components (`server.ts:236-256`). The browser computes an indicative price locally with the shared pricing function.
2. **`POST /v1/quote`** (`:379`) goes through `admitQuoteWork`, a per-IP and global token bucket (`admission.ts`), and then `createQuote` (`:258-288`):
   - reads a cached (100 ms) block-pinned snapshot: markets, limits, epoch, versions, paused (`:231-234`);
   - if the *other* market has outstanding gross exposure and a stale mark (>8 s), **the leader itself submits `refreshOracle`** through the sender before quoting (`:267`);
   - pulls the settlement oracle quote (Pyth REST batch) (`:268`);
   - applies `hedgeAdmission` (`:276`), toxicity (`FlowRiskTracker`) and the adaptive spread (`:277`);
   - computes `constructQuote` with the pending four-corner envelope;
   - binds the quote expiry to the oracle report's `validUntil - 4s` (`:284`).
3. **`POST /v1/prepare`** (`:386-401`) binds quoteId to (account, nonce) and returns EIP-712 `TradeIntent` typed data. The deadline is `blockTimestamp+30` and `maxFee` is derived from `worstPrice` (`makeIntent`, `:204-211`).
4. **The user signs** in the wallet (EOA, ERC-1271, or a session key).
5. **`POST /v1/approve`** (`:402-520`):
   - Idempotency is handled with `completedSubmissions` and `activeSubmissions` (`:405-409`).
   - Signature check (`:418`): EOA, then ERC-1271 at the pinned block, then a session lookup (`clearing.sessions(signer)`).
   - The quote is re-priced with `createQuote(…, persist=false, exactBaseDelta)` and rejected if it is beyond the signed limit or fee (`:429-430`).
   - The loop runs up to 2 attempts and 8 revision conflicts. It reads the gross snapshot (exposure books, markets, position, limits, backing, floor, finalized clock) at one block (`:446-451`). It then takes the in-process **reservation lock**, which is a promise chain (`:67`, `:452`). Under the lock it finalizes expired reservations, computes `pendingMakerDebit` and runs `GrossReservationBook.admit` with gross, net, stress and capital checks (`:456-465`). It persists `approval_artifacts`, `commitments` and `gross_reservations` in one transaction **before any approver sees the payload** (`:470-474`), then reserves in memory and releases the lock.
   - **Quorum:** `collectApprovals` fans out to all 3 approvers in parallel and resolves on the first 2 distinct valid signers (`quorum.ts`). Each response is checked with `recoverAddress` and `clearing.isApprover(signer)` (`:188-202`, `:478-480`).
   - The inclusion budget must be at least 4 s, otherwise it retries once (`:481-482`).
   - It simulates `executeTrade` with `provider.call` and the oracle `updateFee` (`:484-490`).
6. **Approver**, per §1.2: it independently checks the envelope, persists, signs and returns.
7. **Sender broadcast** (`:497-515`). On the dev chain, autofund runs first (`:499-503`). Then `sender.submit("trade:"+quoteId, …, gasLimit 2,000,000)`. `DurableSender.submitLocked` (`sender.ts:17-42`):
   - is a single global promise chain;
   - refuses new operations while any operation is unresolved (`:26`);
   - reads the `pending` nonce, then builds and signs the raw transaction;
   - **writes the signed raw tx and the budget reservation in one transaction before broadcast** (`:31`, `:43`);
   - broadcasts, then polls the receipt for 8 s;
   - replaces the transaction once with a fee bump of at least 15% and waits 30 s;
   - records the receipt.
   
   The API then requires the `TradeExecuted` log with a matching `intentHash` (`settlement-event.ts`). Otherwise it marks the commitment `ambiguous` (`:505`). Finally it moves pending into settled exposure, records the fill for toxicity, and publishes to SSE (`:508-513`).
8. **Indexer:** the next 500 ms poll sees `TradeExecuted` via `getLogs`, re-reads the account at that block, updates `accounts` and `RiskProjection`, and emits an `indexed` SSE invalidation (`indexer/server.ts:44-70`, `:24`).
9. **Expiry and reservation release:** there is no keeper involvement. The API and each approver release gross reservations only when the **finalized** block timestamp passes the approval deadline (`finalizeGross`, `gross-reservations.ts:22-29`). The API does this at the next approval or reservation pass (`server.ts:458`); the approver does it in `/approve` (`:124`). Expired API commitments are archived in the same transaction (`server.ts:168`, `recovery.ts:44-53`). This happens only on request traffic, with no timer, so on an idle system reservations stay held until the next request (inferred, and safe by construction).
10. **Keeper:** liquidation, oracle refresh, incident trigger and resolution, as in §1.5.
11. **Hedger:** on its next tick it reads `/v1/exposure?finalized=true` from the indexer. That route reads the contract at `head-confirmations`. The hedger then trades the gap. Its snapshot feeds the API (`hedgeRisk()`, `server.ts:176`) and every approver (`approver/server.ts:111`) as a `normal`/`guarded`/`reduce_only` gate.

### 2.2 Limit orders

- **`POST /v1/orders/prepare`** (`:374`) creates an unpersisted quote to size the base delta. It builds a `TradeIntent` with `limitPrice` and a deadline of 300 s to 30 days, and holds it in memory as `prepared` for 5 min.
- **`POST /v1/orders`** (`:375`) verifies the signature (EOA, or an inline ERC-1271 check that duplicates `owner-signature.ts`), stores the order in `resting_orders` and adds it to `LimitTriggerBook`, which uses per-market buy/sell heaps plus an expiry heap (`limit-book.ts`).
- **Trigger.** An oracle tick calls `scheduleOrderCheck` (25 ms debounce), and a 30 s reconcile timer also runs (`:541`). `checkRestingOrders` (`:521-540`) does the following:
  - pops up to 16 orders per market whose raw limit crosses the oracle bid/ask;
  - checks `nonceUsed`, an indicative quote, then a persisted firm quote;
  - overwrites quote fields with the order's exact base (`:532`);
  - executes **by calling its own route `app.inject POST /v1/approve`** (`:535`).
- That loopback goes through the public `onRequest` rate limiter, keyed by `request.ip`. All order executions therefore share one `127.0.0.1` bucket and the global write bucket with public traffic (inferred from `:103` and `:535`). Under load, public traffic can starve limit-order execution. The order then returns to `open` with `lastError`.
- If the nonce has been consumed without a recorded transaction hash, the order is marked `cancelled` even if it was filled through another path (`:528`).
- **Cancel** consumes the nonce on-chain through `cancelNonceWithSignature` (`:377-378`).
- Fills are all-or-none, as PRODUCT-READ-MODEL-AND-ORDERS.md specifies.

### 2.3 Streaming

| Stream | Source | Mechanics |
|---|---|---|
| API `/v1/markets/stream` | API | Upstream for the gateway only. Driven by oracle subscriptions (`scheduleStreamPublish`, 40 ms coalescing), suppresses duplicate payloads, sends heartbeats every 15 s, handles backpressure with a 256 KB destroy threshold (`server.ts:160-174`, `:290-295`). |
| Gateway `/v1/markets/stream` | Gateway | Public fan-out with one serialization per frame (`fanout.ts:12`). |
| Indexer `/v1/updates/stream` | Indexer | Invalidation events only; clients re-fetch. |
| Hedger `/v1/status/stream` | Hedger | Ops dashboard, 64 KB slow-client cut. |
| Oracle ingress | Pyth / Coinbase | Pyth Hermes authenticated SSE (`oracle.ts:137-142`) and Coinbase WebSocket (`oracle.ts:40-52`). |

That makes four hand-written SSE writers and two hand-written SSE parsers (`gateway/fanout.ts:18-24`, `oracle.ts:140-141`).

### 2.4 Admin and operations

- **Private hedge dashboard** (`apps/admin`, port 4174) reads hedger `/v1/status(/stream)`.
- **Bearer-protected endpoints:** API `/internal/metrics`, keeper `/internal/metrics`, approver `/internal/recovery`, hedger `/internal/risk` and `/v1/tick`.
- **Scripts:** journal snapshot/restore, `import-approver-recovery.ts`, `operations-alerts.ts` (thresholds in `deploy/operations/alerts.json`), `production-topology.ts` (validates `deploy/host/PRODUCTION-TOPOLOGY.example.json`).
- **Runbook:** `deploy/operations/INCIDENT-RUNBOOK.md` maps each alert to a pause action and a recovery gate.
- **No structured logging** exists in any service: `logger:false` everywhere and no `console` calls in `services/`. Errors are mostly swallowed into status strings (for example `keeper_cycle_failed` at `engine.ts:28`). Operating this system relies entirely on polling `/health` and `/internal/metrics`.
- **Shared bearer secret (inferred from wiring):** the host API uses its `operationsToken` as the hedger token (`persistent-service.ts:37`), and approvers carry the same value as `hedgeToken` (`:36`). One bearer is therefore shared across the API, hedger and three approver hosts. Any one of those hosts can call hedger `/v1/tick` and read hedge strategy state.

---

## 3. Runtime topology

### Local (`npm run dev:services` → `scripts/local-stack.ts`)

A single Node process starts the indexer (4300), hedger (4400, `LocalHedgeVenue`), API (4100, Coinbase oracle, devFund) and gateway (4500). It spawns **3 child approver processes** (`scripts/approver-process.ts`, ports 4201-4203) with scrubbed environments (`childEnvironment`). All three approvers point at the same Hardhat RPC, which is also their "secondary" RPC (`local-stack.ts:30`).

The hedge token is fixed: `local-development-hedge-token` (`:21`). State lives in `.local-state/<deploymentId>/*.sqlite`. Contracts come from `npm run dev:chain` plus `deploy:local`. No keeper runs.

### Base Sepolia (`npm run dev:testnet-services` → `scripts/base-sepolia-stack.ts`)

Same shape as local, with Pyth Hermes, optionally the Hyperliquid testnet bridge, and public RPC lists rotated per approver (`:25`, `:35`). It reads all identities, including every approver key, from one JSON bundle (`:20`). No keeper runs.

### Persistent host (production profile; `Dockerfile.host` + `deploy/host/rfq@.service` + `scripts/persistent-service.ts`)

- **One systemd instance per role** (`rfq@api`, `rfq@approver`, …), each with its own `User=rfq-%i`.
- `flock --exclusive --nonblock` on `/var/lib/rfq/%i/writer.lock`, giving a single writer per volume.
- Hardening: `ProtectSystem=strict`, `ReadWritePaths=/var/lib/rfq/%i`, `UMask=0077`.
- The entrypoint `persistent-service.ts ROLE CONFIG SECRET`:
  - validates the config with zod (`persistent-config.ts`) and the secrets with a strict per-role schema (`:21`);
  - enforces file mode 0600 and state under `/var/lib/rfq/`;
  - validates the chain, the token and the full runtime identity on **two RPCs at one block hash**: implementation slot, code hashes, linked libraries, authorities, approvers, feeds (`runtime-identity.ts:10-27`);
  - checks that exposure migration is ready and that the sponsor is not an authority;
  - builds the role and listens on **127.0.0.1** only.
- Cross-host transport (API to approvers on other providers) is therefore expected through a sidecar or tunnel (deploy/host/README.md); the repo does not implement it.
- The example topology is api-active, api-standby, 3 approvers on 3 providers, keeper, indexer, hedger and gateway (`PRODUCTION-TOPOLOGY.example.json`).
- **The standby API, leader election and fenced promotion described in SIMPLIFIED-DESIGN.md are not implemented** (inferred: no election code; the README says to fence manually).

`Dockerfile.host` is a pinned Wolfi base with Node 24, Python 3.11, a hash-locked SDK venv and `npm ci --omit=dev`, running as uid 65532. It runs TypeScript through `tsx` at runtime; there is no build step (`ENTRYPOINT node --import tsx scripts/persistent-service.ts`).

### Cloudflare Container: one container ran everything, now disabled

`deploy/cloudflare/runtime/wrangler.jsonc` defines one Durable-Object-backed container (`max_instances: 1`) built from `Dockerfile.cloudflare`. The worker routes by path to the in-container ports `[4100, 4201-4203, 4300, 4400, 4500]` (`worker.mjs:6-12`, `routing.mjs`), so yes, every role ran in one container. That includes all three approvers and the sponsor key, delivered through one `RFQ_RUNTIME_ENV_JSON` secret built by `scripts/prepare-cloudflare-runtime.ts`, which bundles sponsor, approver and Hyperliquid identities (`:22-25`).

That container entrypoint now throws immediately: `scripts/cloudflare-container.ts:2` reads "Financial runtime requires persistent journals; Cloudflare Container disk is ephemeral." The following are now dead code paths and should be deleted:
- `Dockerfile.cloudflare` (unpinned Python requirements, `--include=dev`);
- `prepare-cloudflare-runtime.ts`;
- the runtime worker's `RFQRuntimeContainer`.

The edge admission and static workers remain relevant (`deploy/cloudflare/static`).

---

## 4. Code quality assessment

### 4.1 Readability

This is the dominant problem. Production TypeScript is written as minified prose. Examples:
- `server.ts:267` is a single 1,500-character statement covering the cross-market oracle-refresh branch.
- `server.ts:371` (close execute) is about 3,000 characters with no line breaks.
- `pricing.ts:40` puts all of `constructQuote` on one line.
- `indexer/server.ts:96` is an entire paginated route on one line.

Single-letter and abbreviated names are rare, so the code is *locally* precise, but:
- reviewing diffs is very hard, because any change rewrites a 1-3 KB line;
- `git blame` is useless;
- debuggers and coverage tools report statement locations on huge lines;
- the economic-safety reasoning (which the docs show is subtle) is not reviewable at a glance.

Comments are sparse but high-signal where they exist (for example `server.ts:206-208`, `:422-423`, `:468-469`, `approver/server.ts:101-104`). There is no formatter or linter config (no Prettier, ESLint or Biome).

The Python bridge, by contrast, is cleanly formatted and readable.

### 4.2 Structure

- `buildApi` is a **450-line closure** holding about 40 mutable variables plus all routes, timers, the SSE server, the limit-order engine, the deposit simulator and dev-chain hacks. There is no module boundary between quoting, admission, submission and read models, despite SIMPLIFIED-DESIGN.md saying "keep these as internal modules for testing".
- The small modules are well factored: `quorum.ts`, `admission.ts`, `limit-book.ts`, `bounded-state.ts`, `metrics.ts`, `flow-risk.ts`, `expiry-index.ts`, `gross-reservations.ts`, `keeper/engine.ts` (dependency-injected and easy to test). These are the model to follow.
- Cross-service imports (`keeper` → `api/src/sender.ts`, `api/src/oracle.ts`; scripts → every service) mean the "services" are folders of one program, not packages.
- Dev and test behavior is mixed into production code paths:
  - `devFund` autofund, mint and clock advance (`server.ts:223-229`, `:262`, `:499-503`);
  - fake default prices (`:135-138`);
  - `process.env.NODE_ENV==="test"` error detail branches (`server.ts:479`, `:489`; `approver/server.ts:39`, `:132`);
  - the approver's no-chain mode.
- Schema migration is ad hoc. It is a mix of `CREATE TABLE IF NOT EXISTS`, `PRAGMA table_info` + `ALTER` (`approver:27`, `hedger:27-28`, `gross-journal:3`) and `migrateGross` named backfills. There is no versioned migration table per database.

### 4.3 Duplication (DRY opportunities)

1. **Funding-index projection and APR clamp**, implemented three times: `exposure-admission.ts:18-19` (`pendingMakerDebit`), `exposure-admission.ts:31-32` (`exposureAdmission`), `api/server.ts:247-249` (`readMarkets`). Extract a `projectFunding(market, cap, timestamp)` helper.
2. **Contract struct → bigint DTO converters.**
   - `ExposureMarket`: `api/server.ts:449` (`state`) and `approver/server.ts:117` (`riskMarket`).
   - `ExposureBook`: `approver/server.ts:118`; the API passes raw ethers Results at `:450`.
   - Positions: `{size, entryPrice, lastFundingIndex}` built inline at `server.ts:449`, `approver:120`, `:128`.
   
   Put typed readers in a shared `clearing-reader.ts`.
3. **`marketNotional(state, mark)`**, implemented twice: `api/server.ts:269`, `approver/server.ts:115`.
4. **Oracle report tuple encoding** `tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)` appears 4 times in `api/server.ts` (`:267`, `:283`, `:371`, `:439`) and in `oracle.ts:38`. Decoding appears in `approver:76`. The `updateFee(bytes)` adapter `Contract` is built ad hoc in `api/server.ts:267`, `:371`, `:486`, `approver:99` and `keeper/server.ts:27`. Create an `oracle-report.ts` with `encodeLocalReport`, `decodeLocalReport` and `oracleFee(clearing, report)`.
5. **ERC-1271 / session authorization**, implemented four times:
   - `owner-signature.ts:4-12` (`validOwnerSignature`);
   - inline in `/v1/orders` (`server.ts:375`);
   - inline in `/v1/approve` (`:418`, including the session check);
   - approver (`:86`, `:92-93`, `:109`, session check).
   
   One `authorizeIntent(domain, intent, signature, {provider, clearing, blockTag})` function should serve both the API and the approver.
6. **Prepare/execute signed-action routes.** withdraw, cancel, close and session all repeat the same sequence: zod parse, `getAddress`, build intent, deadline check, `validOwnerSignature(TypedDataEncoder.hash(...))`, chain availability check, `sender.submit(id, encodeFunctionData)`, `settlementEvent`, `publicError` (`server.ts:366-373`, `:377-378`). A generic `signedAction({schema, types, toIntent, encode, operationId, event})` helper would cut about 8 kB.
7. **Wire↔bigint codecs**, written by hand in many places:
   - eight `*ToWire` functions (`eip712.ts:76-89`) plus `quoteToWire` (`wire.ts`);
   - inverse parsers in `recovery.ts:10-11`, `:37-38`, `approver/server.ts:43-44` and `server.ts:133`.
   
   Zod 4 codecs (`z.codec`), or a single `bigintString` schema with `.transform`, would give one bidirectional schema per type.
8. **Two heap implementations**: `packages/shared/src/expiry-index.ts` (indexed min-heap) and the `Heap` class in `api/src/limit-book.ts:5-18`.
9. **SSE server boilerplate** (`writeHead` with the same headers, heartbeat, slow-client cut) appears four times: `api/server.ts:160-174`, `:303-307`, `gateway/server.ts:16`, `indexer/server.ts:24`, `:87`, `hedger/server.ts:45`, `:53`. SSE parsing appears twice: `gateway/fanout.ts:18-24` and `oracle.ts:140-141`. A shared `sse.ts` would provide `openSse(reply, cors)` and a `parseSse(stream)` async iterator.
10. **Oracle source boilerplate.** Three classes each re-implement the `cached`/`inFlight` coalescing, `listeners`, `MarketSignalTracker` and `status()` (`oracle.ts:18-63`, `:65-88`, `:93-158`). Use a base class or composition.
11. **Gap and notional math in the hedger**, computed three times (`hedger/server.ts:39`, `:44`, `:49`), with `abs` written inline each time.
12. **`abs` helper** re-defined or inlined in many files: `server.ts:88`, `exposure-admission.ts:3`, `gross-reservations.ts:41-43` (inline), `hedge-risk.ts:9`, `account-risk.ts:5`.
13. **`BASE`, `RATE` and `MASK` constants** redefined in `exposure-admission.ts:2`, `gross-reservations.ts:6` and `server.ts:86`, even though `pricing.ts:1-3` exports them. Hedger uses the literal `10n**18n` (`:39`). `limits & ((1n<<128n)-1n)` / `>>128n` decoding repeats in `server.ts:89`, `approver:107`, `:111`, `gross-reservations.ts:41`, `exposure-admission.ts:45-46`.
14. **The `"BTC"|"ETH"` market type is declared 6 times**: `Market` in pricing.ts, `ExposureMarket` in `bounded-state.ts:1` (which also collides with a different `ExposureMarket` interface in shared), `LimitMarket`, `OracleMarket`, `HedgeMarket`, `HistoryMarket`. The index mapping `market==="BTC"?0:1` appears about 15 times.
15. **`QuoteRequest` declared twice**: `pricing.ts:7` and `policy.ts:10`.
16. **Three composition roots** wire the same services with slightly different options: `local-stack.ts`, `base-sepolia-stack.ts` and `persistent-service.ts`. Divergence is already visible in `expectedQuoteModelVersion`, confirmations 2 vs 12, and `approverTimeoutMs` (1 s default on the host versus 5 s on testnet; inferred risky for cross-provider approvers that make about 20 sequential single-request RPC calls each).
17. **`BEGIN IMMEDIATE … COMMIT/ROLLBACK`** is hand-written 9 times. The indexer has an `atomic()` helper (`indexer/server.ts:25`); share it.

### 4.4 Error handling

- **Fail-closed by design**, mostly done well: unresolved sender rows block new submissions (`sender.ts:26`), stale hedge snapshots map to `reduce_only` (`server.ts:176`), and approvers return 503 on any read failure.
- **Over-broad `catch{}`** obscures causes:
  - `/v1/account/:address` turns RPC failures into `400 invalid account` (`server.ts:327`);
  - `prepare` routes return `400` for any error (`:366`, `:368`, `:370`, `:372`);
  - the Coinbase WebSocket parser swallows all errors (`oracle.ts:48`);
  - Chainlink stream normalization errors are silently dropped (`oracle.ts:78`);
  - the indexer `sync()` stores `String(error)` but never logs it (`:82`).
- `publicError` (`public-error.ts`) is a good idea (it does not leak provider URLs), but the error-selector table is hand-maintained (`:8`). `Insolvent` and `OracleInvalid` names have no selectors. Derive the table from the contract ABI's custom errors.
- `DurableSender` behavior:
  - It treats any broadcast error containing "already known" or "nonce too low" as success (`sender.ts:57`). "Nonce too low" can also mean that another transaction consumed the nonce. Reconcile then marks the row ambiguous, so this is safe but slow.
  - The status `reorged` is checked (`server.ts:298`, `sender.ts:26`) but never written. Reorg of an included sponsor transaction is not modeled explicitly.
  - **`reconcileLocked` re-reads receipts for every attempt ever sent, every 5 s.** It runs `SELECT … FROM sender_attempts` with no filter, plus rows with status `included`/`reverted` (`sender.ts:65-67`). The cost is O(history) RPC calls per tick with `batchMaxCount:1`. This is a growing performance and RPC-quota bug for both the API and the keeper (inferred).
- Concurrency: the sender is one promise chain per process, and each operation can wait up to 8 s + 30 s. All sponsored writes (trades, deposits, withdrawals, oracle refreshes) are therefore serialized. Peak throughput is about one transaction per inclusion latency per leader (inferred; SCALE-AND-STREAMING.md acknowledges "sponsor nonce sequencing" as a bottleneck).

### 4.5 Type safety

- The `strict` tsconfig passes, and there are only 3 occurrences of `any` in non-test code. Good.
- Most real looseness comes from **ethers v6 `Contract` method calls**, which return `any`-typed `Result`s. For example `clearing.markets(...)` values are cast through `BigInt(x as bigint)` everywhere (`server.ts:89`, `:263` destructures `values:any[]`). Typed ABIs would remove whole classes of bugs, using viem/abitype `as const` ABIs or ethers TypeChain.
- JSON from internal services is cast without validation:
  - the hedge snapshot (`hedge-risk.ts:6`, `approver:111`);
  - the indexer pages consumed by the keeper (`keeper/server.ts:22`);
  - the indexer exposure consumed by the hedger (`hedger/server.ts:38`).
  
  The approver payload is the only inter-service contract validated with zod (`approver-payload.ts`).
- SQLite rows are cast with `as {…}` (for example `server.ts:126`, `:131`, `:133`) with no runtime validation.

### 4.6 Zod and Fastify usage

- **zod 3.25.76.** It is used for public request bodies (`server.ts:67-82`), the approver envelope and host config. It is not used for response schemas, query strings (the indexer and gateway parse queries by hand, e.g. `indexer/server.ts:83-84`) or environment. `.safeParse` + `reply.code(400)` is repeated by hand in every route.
- **Fastify 5.12.** It is used only as a router. No schema-based validation or serialization (`fastify-type-provider-zod`), no plugins or encapsulation, no `logger`, no `onError` hooks, no `@fastify/rate-limit`, no `@fastify/under-pressure`. SSE is done by `reply.hijack()` and raw writes. CORS uses `@fastify/cors` in the API, indexer and hedger, but the SSE routes set `access-control-allow-origin` by hand.
- The internal `app.inject` loopback for limit orders (`server.ts:535`) is a misuse. Executing through the public route also re-applies public rate limits (§2.2).

### 4.7 Tests

- **Strengths:** deterministic tests for the hard parts.
  - Quorum with stalled or duplicate signers.
  - Sender crash, restart, rebroadcast, ambiguity and budget handling (8 tests).
  - Gross reservation finality and restart (`scripts/gross-reservations.test.ts`).
  - Recovery consistency.
  - Gateway with 100k in-memory clients.
  - Hedger restart and partial fills (10 tests).
  - Oracle sources with stubbed transports.
- The API integration test (`server.test.ts`, 30 tests) builds real approvers in-process.
- **Gaps:**
  - no approver unit tests for each rejection branch;
  - no keeper RPC adapter tests;
  - no indexer reorg test against a forked chain (2 indexer tests);
  - no Python unit tests for `hyperliquid_bridge.py` (`venue_price`, `parse_order_status`);
  - no coverage measurement;
  - shared-package tests live under `scripts/`.
- The `test:services` glob `services/**/*.test.ts` relies on Node's own glob expansion because `sh` has no globstar. It works, but it is fragile.
- Contract-level end-to-end tests (`scripts/*-e2e.mjs`) exist under `test:contracts`; I did not run them.

---

## 5. Design decisions and whether they hold up

| Decision | Assessment |
|---|---|
| **Single active API leader with an in-process reservation lock** (`server.ts:66-67`) | Sound and simple for a single writer. Admission is serialized by a promise chain, and contract limits remain the final guard. Leader failover (epoch bump, warm standby) is **designed but not implemented**: no standby code and no election. Recovery is manual (deploy/host/README.md). Acceptable for testnet, a gap for mainnet. |
| **Durable-before-escape journals for the leader and approvers** | Strong. The API writes the approval artifact, commitment and gross reservation in one transaction before contacting approvers (`server.ts:470-474`). The approver commits gross reservation plus signature before responding (`approver:143-146`). Release happens only on finalized time past the deadline (`gross-reservations.ts:22-29`). Restart recovery fails closed on inconsistent artifacts (`recovery.ts:32-36`). This is the most carefully reasoned part of the codebase. Cost: every approval is a synchronous SQLite fsync on 4 hosts, which is fine at RFQ volumes. |
| **2-of-3 approvers that independently re-read chain state** | Holds up. Each approver uses its own RPC plus a secondary block-hash check, re-runs exposure, stress and impact, and checks the hedge state. Caveats: (a) in Pyth mode the price inputs for the spread check are the leader's claimed `quote.bid/ask`, while impact and stress use the on-chain verified observation (`approver:55`, `:113`); document this trust split explicitly. (b) The approver depends on the hedger for liveness: when the hedger is down, everything becomes reduce-only, which is the intended fail-safe. (c) About 20 sequential single-request RPC calls per approval with `batchMaxCount:1` are the latency floor. |
| **Signed-before-broadcast sender** (`sender.ts:31`, `:43`) | Correct crash semantics: a raw transaction is journaled before broadcast, rebroadcast on restart, attempts are tracked for replacement, and an unresolved operation fences new ones. Weaknesses: a global serial queue limits throughput (§4.4); reconcile cost is O(history) (§4.4); `reorged` is never set; `findIncluded` does `Promise.all` over all attempts. For scale, move to N sponsor wallets (one nonce lane each) or Base's EIP-7702/AA flow later, and prune terminal rows from reconcile. |
| **In-process state + SQLite (`node:sqlite`)** | Fine for single-writer-per-volume with a systemd `flock`. Concerns: `node:sqlite` is still experimental or release-candidate on Node 22/24 (warnings in the test run); there are no migrations; backup relies on custom scripts. `DatabaseSync` calls block the event loop. They are small today, but `restoreGross` and `SELECT * FROM approval_artifacts` at startup scale with the active set (inferred). Use better-sqlite3 (or stay on `node:sqlite` once stable), a migration table, and Litestream/LiteFS for continuous off-host WAL backup. |
| **Custom SQLite indexer instead of Ponder** | Pragmatic. INDEXER-DESIGN.md records Ponder 0.17.10 audit findings as the reason. Weaknesses: full rebuild on any tip mismatch; per-account RPC re-reads (N+1); synchronous `sync()` inside reads; `head-confirmations` finality instead of the `finalized` tag; unbounded SSE clients; no funding-index or margin projection, despite PRODUCT-READ-MODEL-AND-ORDERS.md and INDEXER-DESIGN.md describing margins on `/v1/account`. The docs also say SIMPLIFIED-DESIGN's "Ponder is the sole read model", which is now stale. |
| **Python bridge for Hyperliquid** | Isolation is reasonable: separate process, scrubbed environment, official SDK, hash-locked wheels in `Dockerfile.host`. Costs: a second runtime in the image, a JSON-lines RPC with 30 s timeouts that kills the child on any timeout, testnet-only pins, and float conversion at the SDK boundary. In 2026 there are maintained TypeScript SDKs (e.g. `@nktkas/hyperliquid`), and signing Hyperliquid actions is plain EIP-712 plus msgpack. A native TypeScript venue adapter behind `HedgeVenue` would remove Python from the runtime. Keep the bridge only if the official SDK's signing behavior is a compliance requirement. |
| **Hedger trusts the indexer's finalized exposure** | Simple, but it contradicts HEDGING-OPERATIONS.md step 1 (independent RPC verification). `/v1/exposure` reads the contract at `head-12` through the indexer's RPC, so a compromised indexer can misdirect hedges. The hedger should read the clearing contract directly; it is two `markets()` calls. |
| **Secret-free SSE gateway separated from the leader** | Good. It is the correct shape (SCALE-AND-STREAMING.md). |
| **Keeper scans via the indexer and simulates every account** | Correct (simulation is authoritative) but O(N) RPC per sweep. Pre-filter with local margin math, which already exists in `/v1/account`. |
| **Cloudflare Container "run everything"** | Correctly abandoned, because ephemeral disk loses journals and all keys sat in one environment variable. The leftover files are dead weight. |
| **Runtime identity attestation at startup** (`runtime-identity.ts`) | Excellent hardening: two RPCs agree on block, code hashes, implementation slot, linked libraries, authorities and feeds. |
| **No logging** | Does not hold up for production. Incidents will be undiagnosable without structured logs (pino is built into Fastify) carrying correlation IDs (quoteId, intentHash, operationId). |

---

## 6. Tech stack assessment and recommended upgrades

| Area | Current | Recommendation |
|---|---|---|
| Type checker | **TypeScript 7.0.2 (native)** already, `noEmit`, typecheck about 2 s | Keep. Add `"erasableSyntaxOnly": true`, `"verbatimModuleSyntax": true`, `"noUncheckedIndexedAccess": true` and `"exactOptionalPropertyTypes"` (gradually). 14 files use constructor parameter properties (`constructor(private …)`), which are not erasable, so they must be refactored before native type stripping. |
| Runtime TS | `tsx` 4.23 at runtime in production (`Dockerfile.host` ENTRYPOINT) | Node ≥22.18/24 strips types natively. After the `erasableSyntaxOnly` refactor, run `node src/main.ts` directly and drop tsx and esbuild from the production image, or bundle each service with `tsdown`/esbuild into one JS file for a smaller attack surface. Keep tsx for dev if desired. |
| Validation | zod 3.25.76 | Move to **zod 4** (`zod/v4` is already importable from 3.25; then 4.x). It is faster and smaller, and gives `z.codec` for bigint-string wire types (removes §4.3 #7), `z.bigint()` coercion and better error output. Pair with `fastify-type-provider-zod` for typed route schemas, which also fixes query parsing in the indexer and gateway. |
| Ethereum lib | ethers 6.17 (untyped `Contract`) | **viem** with `as const` ABIs (abitype) for typed reads and writes, `multicall` to batch the 10-20 reads per approval and per quote (big latency win where `batchMaxCount:1` is forced), first-class `verifyTypedData`/ERC-1271 (`verifyHash` handles 6492/1271), and `fallback`/`createPublicClient` transports. This is the single most valuable library change for type safety. Keep ethers only where hardhat-ethers is needed in contract scripts. |
| HTTP | Fastify 5 as a bare router | Keep Fastify, but use it properly: `logger: pino` with redaction of keys, tokens and signatures; plugins per domain; schema-validated routes; `@fastify/rate-limit` (or keep the custom bucket but outside the public hook for internal calls); `@fastify/under-pressure`; a small SSE helper. Hono is a reasonable alternative if the edge and origin should share code, but it is not required. |
| Database | `node:sqlite` per service, ad-hoc migrations | Short term: keep SQLite (single writer per role is the right model). Add a migration runner (e.g. `umzug`, or a `user_version` pragma ladder) and Litestream for continuous encrypted off-host WAL replication, which closes the "off-host restore qualification" gap in deploy/host/README.md. Consider better-sqlite3 until `node:sqlite` is stable. Medium term: Postgres only for the indexer/read model (multiple readers, analytics). Signer and sender journals should stay local SQLite: locality is a security property here. |
| Indexing | Custom poller | Options: (a) keep the custom indexer but switch to `finalized` tag semantics, a parent-hash walk-back for reorgs instead of a full reset, and emitted account-state events (contract change already proposed in INDEXER-DESIGN.md); (b) **Ponder** (0.11+/1.x) on Postgres now that the audit findings that blocked 0.17.10 should be re-checked; it handles reorgs, typed schemas and GraphQL/SQL over HTTP; (c) Envio HyperIndex or rindexer for higher throughput. Recommendation: re-evaluate Ponder first. If its audit tree is still unacceptable, keep the custom one with the fixes in (a). |
| Hyperliquid | Python SDK bridge | A TypeScript adapter (`@nktkas/hyperliquid` or a hand-rolled EIP-712 + msgpack signer behind `HedgeVenue`). Remove the testnet pin behind an explicit, reviewed mainnet profile flag. |
| Monorepo | Single root `package.json`, no workspaces, relative `../../../packages/shared/src` imports, tests for shared in `scripts/` | **pnpm workspaces** (strict, content-addressed, good for supply-chain review), plus **Turborepo** or Nx for cached `typecheck`/`test`/`build` per package. Give each service its own `package.json` with only its dependencies; for example the gateway needs only fastify, and approvers do not need `@chainlink/data-streams-sdk` or `@cloudflare/containers`. Smaller per-role images and SBOMs follow. Use `tsconfig` project references, and path aliases such as `@rfq/shared`. |
| Lint/format | None | Biome (fast, one tool) or ESLint + Prettier. **Formatting the codebase is the cheapest large quality win.** Run it in one mechanical commit, verified by tests passing unchanged. |
| Testing | `node:test` + tsx | Fine. Add `--experimental-test-coverage` (or c8), Python `pytest` for the bridge, and property tests (fast-check) for pricing, exposure and gross invariants (some seeded tests already exist). |
| Observability | `/health` + bearer metrics JSON | pino logs, OpenTelemetry traces through quote → approve → approver → sender → receipt, and a Prometheus endpoint (`prom-client`) matching `deploy/operations/alerts.json` thresholds. |
| Containers | Wolfi pinned (good) plus a dead Cloudflare Dockerfile | Delete `Dockerfile.cloudflare`. Build per-role images, with Python only in the hedger image (or none after the TypeScript adapter). |

---

## 7. Proposed restructure (a layout I would own)

Goals:
- one composition root per role;
- domain logic as pure, testable modules with no I/O;
- I/O adapters behind interfaces;
- no cross-service internal imports;
- dev and test helpers out of production code.

```
rfq/
├─ package.json                # pnpm workspace root; turbo.json; biome.json
├─ tsconfig.base.json          # strict + erasableSyntaxOnly + noUncheckedIndexedAccess
├─ packages/
│  ├─ protocol/                # @rfq/protocol: pure, no I/O
│  │  ├─ markets.ts            # Market = "BTC"|"ETH", index<->name, constants BASE/RATE/USDC/MASK
│  │  ├─ eip712/               # typed-data defs + zod codecs (bigint<->string) per type
│  │  ├─ pricing/              # spread.ts, impact.ts, quote.ts (constructQuote), margin.ts
│  │  ├─ risk/                 # funding.ts (single projectFunding), exposure-admission.ts,
│  │  │                        # stress.ts, gross-reservations.ts, pending-envelope.ts
│  │  ├─ oracle-report.ts      # encode/decode local tuple, Pyth envelope, Chainlink v3 decode
│  │  └─ errors.ts             # custom-error selectors derived from ABI → public messages
│  ├─ chain/                   # @rfq/chain: viem clients, typed ABIs, ClearingReader
│  │  ├─ abi.ts                # `as const` ABIs generated from artifacts
│  │  ├─ clearing-reader.ts    # readSnapshot(blockTag): markets, books, limits, versions (multicall)
│  │  ├─ authorize-intent.ts   # EOA | ERC-1271 | session (one implementation)
│  │  ├─ finalized-clock.ts
│  │  └─ sender/               # DurableSender (pruned reconcile, explicit reorg state, N lanes)
│  ├─ journal/                 # @rfq/journal: sqlite wrapper, migrations, atomic(), snapshot/restore
│  ├─ runtime/                 # @rfq/runtime: fastify factory (pino, zod type provider, health),
│  │                           # sse.ts (server + parser), rate-limit, config loader (zod), secrets
│  └─ oracle/                  # @rfq/oracle: OracleSource interface + pyth/, chainlink/, coinbase/ (dev)
├─ services/
│  ├─ api/                     # @rfq/api
│  │  ├─ main.ts               # composition root: load config → build deps → start
│  │  ├─ app.ts                # registers plugins only
│  │  ├─ quoting/              # QuoteService (createQuote), routes: /v1/quote, /v1/close/quote, /v1/markets(+stream)
│  │  ├─ execution/            # AdmissionService (reservation lock + gross journal), QuorumClient,
│  │  │                        # ExecutionService (prepare/approve/submit), routes: /v1/prepare, /v1/approve
│  │  ├─ actions/              # generic signedAction() + withdraw/cancel/close/session definitions
│  │  ├─ orders/               # LimitBook + OrderExecutor calling ExecutionService directly (no app.inject)
│  │  ├─ account/              # /v1/account read model
│  │  └─ recovery/             # restore commitments, archive
│  ├─ approver/                # @rfq/approver: main.ts, policy/ (pure checks, one file per rule
│  │                           # family, unit-tested per rejection), signer.ts, journal.ts, routes.ts
│  ├─ gateway/                 # unchanged shape; uses @rfq/runtime/sse
│  ├─ indexer/                 # either Ponder project or custom: sync/ (reorg walk-back), projections/, routes/
│  ├─ keeper/                  # engine.ts (as today) + candidates.ts (local margin pre-filter) + adapters
│  └─ hedger/                  # loop.ts (pure planner: target/gap/slice), venues/{local,hyperliquid}.ts,
│                              # chain-exposure.ts (direct RPC, not indexer), routes.ts
├─ dev/                        # NOT shipped: local-stack.ts, testnet-stack.ts, devFund helpers
│  └─ dev-chain/               # clock advance, autofund, mock deposit route (removed from api)
├─ deploy/
│  ├─ host/                    # systemd units, per-role Dockerfiles (Python only if still needed)
│  └─ cloudflare/static/       # edge only; delete runtime container profile
└─ tests/
   ├─ e2e/                     # hardhat-backed flows (existing scripts/*-e2e)
   └─ smoke/                   # live smokes, gated
```

Concrete steps in priority order. Each step is mechanically verifiable with the existing 166 tests plus typecheck.

1. **Format everything** with Biome or Prettier in one mechanical commit. Make no logic changes. This is the prerequisite for any review.
2. Delete the dead Cloudflare runtime (`Dockerfile.cloudflare`, `scripts/cloudflare-container.ts`, `scripts/prepare-cloudflare-runtime.ts`, `deploy/cloudflare/runtime/worker.mjs` container class) after confirming nothing deploys it.
3. Extract `@rfq/protocol` pure modules and remove duplicates #1, #3, #4, #12-15 from §4.3. Move the shared tests out of `scripts/`.
4. Introduce `ClearingReader` and `authorizeIntent` (duplicates #2 and #5), first with ethers, then swap to viem multicall.
5. Split `buildApi` into the services above. Replace `app.inject` with direct calls. Move devFund code to `dev/`.
6. Fix the sender: prune terminal rows from reconcile, add explicit reorg handling, and stop flagging normal in-flight transactions in `/health`.
7. Add pino logging plus correlation IDs, and zod-validate every inter-service JSON payload (hedge snapshot, indexer pages, exposure).
8. Hedger: read exposure directly from the chain, make CORS configurable, and require the token unconditionally. Plan the TypeScript Hyperliquid adapter.
9. Move to pnpm workspaces + Turborepo, give each service its own `package.json`, build per-role images, and run on Node 24 with type stripping (`erasableSyntaxOnly`). Drop tsx in production.
10. Indexer: walk back reorgs instead of resetting, use the `finalized` tag, add a ConnectionBudget on SSE, decouple `sync()` from reads. Alternatively, re-evaluate Ponder.
11. Wire the keeper into the local and testnet stacks so liquidation is exercised in development, and add the margin pre-filter.

---

## Appendix: notable specific issues (quick list)

- `services/api/src/sender.ts:65-67`: reconcile re-polls receipts for **all historical** attempts every 5 s (`server.ts:541`). This is O(history) RPC load.
- `services/api/src/server.ts:298`: `/health` is `ok:false` during every normal in-flight transaction (`signed`/`submitted`).
- `services/api/src/server.ts:535`: limit orders execute through `app.inject` and share the `127.0.0.1` public write rate-limit bucket.
- `services/api/src/server.ts:327`: account read maps all errors to `400 invalid account`.
- `services/api/src/server.ts:528`: an order whose nonce was consumed elsewhere is marked `cancelled`.
- `services/api/src/server.ts:324`: `liquidation=size>0n?high:high` is a redundant ternary.
- `services/indexer/src/server.ts:87`: SSE has no connection cap. `:46`/`:78`: any reorg wipes and rebuilds the whole index.
- `services/hedger/src/server.ts:48`: status/stream/tick are unauthenticated when `healthToken` is unset. `:25`, `:53` hard-code CORS.
- `services/hedger/src/hyperliquid.ts:49`, `hyperliquid_bridge.py:32`: testnet-only, while `persistent-config.ts:21` selects mainnet for `base-mainnet`.
- `scripts/persistent-service.ts:36-37`: approver `expectedQuoteModelVersion` is unset in production. One operations token is shared across the API, hedger and approvers. The API `approverTimeoutMs` defaults to 1 s for cross-provider approvers.
- `scripts/local-stack.ts`, `scripts/base-sepolia-stack.ts`: the keeper is not started.
- `scripts/cloudflare-container.ts:2`: the container entrypoint unconditionally throws, so the Cloudflare runtime profile is dead.

Doc drift:
- LOCAL-DEVELOPMENT.md step 3 says `TradeIntent` contains the leader epoch and policy version; it does not (`eip712.ts:7-12`).
- SIMPLIFIED-DESIGN.md names Ponder as the sole read model; the implementation uses the custom indexer.
- HEDGING-OPERATIONS.md says the hedger verifies exposure through an RPC; it reads the indexer.
- PRODUCT-READ-MODEL-AND-ORDERS.md names Chainlink as the oracle; the host profile uses Pyth.
