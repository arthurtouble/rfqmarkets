# RFQ Markets audit: operational scripts and the Python simulator

Audit date: 2026-10-06. Repository: `/home/claude/rfqmarkets` at HEAD `bae3332` ("coomit", 2026-09-20). I made no changes to the repository, deployed nothing and touched no external network.

**Commands run (all local):**
- `npm run test:python`: **50 tests, all OK, 0.347 s** (Python 3.13.16).
- `node --import tsx --test scripts/*.test.ts scripts/*.test.mjs`: **53 tests, all pass, 3.8 s**. I ran this as extra coverage. These tests are offline. `qualification-retry.test.ts` uses an overridden provider, and `spread-parity.test.ts` starts `python3` locally.

Notes on the evidence:
- Line references are `file:line` relative to the repo root.
- Most scripts are written as dense one-liners, so one line can hold a whole function. For example, `production-topology.ts:4` is 1,803 characters long and `base-sepolia-hedge-e2e.ts:58` is 1,484.
- Anything I inferred rather than read directly is marked *(inferred)*.

---

## 0. Executive summary

1. **The operational tooling is functional and fails closed, but it is spread out and duplicated.** There are about 95 files in `scripts/` and 70+ npm scripts. They share no API client, manifest loader, identity loader or polling/retry helper. Each Base Sepolia script re-reads `.local-state/*.json` with its own ad-hoc type cast.

2. **Qualification tooling is complete, but there is no qualifying evidence.**
   - The tooling chain is canary → soak → release-evidence checker. `R16` is still "pending" (`PRODUCTION-IMPLEMENTATION-PLAN.md:35`), and the soak checklist item is unchecked (`PRODUCTION-RELEASE-CHECKLIST.md:26`).
   - Only a one-cycle soak has passed (`VALIDATION-REPORT.md:105,115`).
   - The last six commits (2026-09-16 to 09-20) were all about making the testnet canaries survive testnet flakiness by widening retry classifiers.

3. **Three problems found in qualification:**
   - **The two canaries use inconsistent retry policies.** `qualification-retry.ts:7-8` says it will never retry an ambiguous submission, a timeout or a generic "policy rejected". `base-sepolia-hedge-e2e.ts:56` retries exactly those, up to 12 attempts with 40 s waits.
   - **Retries are invisible in the soak evidence** (`base-sepolia-soak.ts:18` keeps only a fixed list of keys). So "failures: 0" over 72 h does not mean zero rejections.
   - **The vulnerability-exception waiver has expired.** `security/vulnerability-exceptions.json` expired on 2026-09-30. `release-image.yml` runs `scripts/vulnerability-gate.mjs`, which throws `Expired vulnerability exception` (`vulnerability-gate.mjs:11`), so the host-image release gate now fails on every run *(inferred from the code path; I did not run CI)*. The unit test still passes because it pins `now` to 2026-09-16.

4. **Economic constants are copied 4–7 times across Solidity, TypeScript, `.mjs` scripts and Python.** Some copies are deliberate independent oracles with parity tests. Others have drifted with no test:
   - `simulator/accounting.py` margin tiers differ from Solidity.
   - There are two incompatible Python oracle-mode models.
   - `market_making_scenarios.py` has a float spread mirror with different rounding and units.
   - `base-sepolia-hedge-e2e.ts:30` hand-copies the stress scenarios.

5. **The simulator is small (about 1.7k LOC), stdlib-only and fast.** It is worth keeping as an independent oracle, but it should be:
   - made a real differential check against Solidity (only TS↔Python parity exists today),
   - pruned of its drifted float models,
   - fed from one shared parameter file.

---

## 1. Script inventory

Network key:
- **local**: local Hardhat node and loopback services.
- **in-proc**: no network; Fastify `inject` or pure functions.
- **BaseSep**: Base Sepolia RPCs (public endpoints plus `RFQ_BASE_SEPOLIA_RPC_URL`).
- **Pyth**: authenticated Pyth Hermes (`PYTH_API_KEY`).
- **HL-test**: Hyperliquid testnet.
- **CB/BN**: Coinbase/Binance public market data.
- **offline**: files only.

Kind: **test** (automated gate), **smoke** (manual check against a running stack), **ops** (repeatable operations), **one-off** (migration or ceremony).

### 1a. Unit-test files (run by `npm run test:services` via `scripts/*.test.ts|mjs`)

| File | What it tests | Network |
|---|---|---|
| `account-risk.test.ts` | `openingPnl`/`positionPnl` rounding (packages/shared) | in-proc |
| `connection-budget.test.ts` | Global/per-client lease budget | in-proc |
| `deployment-config.test.ts` | zod env schema: HTTPS RPC, distinct roles, Pyth fallback, faucet capital floor | in-proc |
| `exposure-admission.test.ts` | Gross/side/net caps, stale gross, capital floor, `makerStress` rounding, 10k seeded pending-debit envelope | in-proc |
| `gross-reservations.test.ts` | Reservation book, SQLite journal, finality clock, expiry index, context binding | in-proc (sqlite :memory:) |
| `journal-snapshot.test.ts` | Snapshot/restore round trip and tamper rejection (spawns the two scripts) | offline |
| `mainnet-manifest.test.ts` | Mainnet manifest validation and unsigned plan | offline |
| `market-flow-normalizer.test.ts` | Coinbase/Binance trade normalisation, BBO join | in-proc |
| `operations-alerts.test.ts` | Alert evaluator against `deploy/operations/alerts.json` | offline |
| `persistent-config.test.ts` | Host config: chain↔env, official USDC, venue URL | in-proc |
| `pricing.test.ts` | Exact-base close quote | in-proc |
| `process-environment.test.ts` | `childEnvironment` strips parent secrets | in-proc |
| `production-topology.test.ts` | Topology independence rules | in-proc |
| `qualification-retry.test.ts` | Retry classifier and qualification app restart | in-proc (fake provider) |
| `release-evidence.test.ts` | Release-evidence checker | offline (tmpdir) |
| `spread-parity.test.ts` | **TS↔Python parity**: 1,002 spread vectors and 1,000 full-quote vectors (spawns `python3`) | local subprocess |
| `supervise.test.ts` | Child supervisor: output bound, deadline/kill, abort | local subprocess |
| `vulnerability-gate.test.mjs` | SARIF waiver policy (pinned date) | in-proc |

### 1b. Contract/e2e scripts (another reviewer's area; skimmed for duplication only)

| File | npm script | Network | Kind |
|---|---|---|---|
| `compile-contracts.mjs` | `compile:contracts` | offline | build |
| `contract-e2e.mjs`, `clearing-e2e.mjs`, `bankruptcy-e2e.mjs`, `exposure-e2e.mjs`, `risk-differential.mjs`, `stateful-clearing-e2e.mjs` | `test:contracts` (hardhat run) | local (hardhatOp in-process) | test |
| `api-settlement-e2e.mjs`, `gross-reservation-e2e.mjs`, `keeper-e2e.mjs`, `account-response-e2e.mjs` | `test:contracts` (node) | local | test |
| `link-artifact.mjs` (+ `.d.mts`) | library used by 10 deploy/e2e scripts | – | lib |
| `deploy-local.ts` | `deploy:local` | local | ops |
| `deploy-base-sepolia.ts` | `deploy:base-sepolia` | BaseSep | one-off/ops |
| `deploy-base-sepolia-iteration.ts` | `deploy:base-sepolia-iteration`. A 12-line wrapper that mutates `process.env` then `await import("./deploy-base-sepolia.js")` (`:9-12`) | BaseSep | ops |
| `upgrade-base-sepolia-iteration.ts` | `upgrade:base-sepolia-iteration` | BaseSep | ops |
| `upgrade-base-sepolia-pyth.ts` | `upgrade:base-sepolia-pyth` (Safe/timelock adapter swap) | BaseSep | **one-off** |
| `deploy-testnet-governance.ts` / `finalize-testnet-governance.ts` | `deploy:/finalize:base-sepolia-governance` (Safe and timelock ceremony) | BaseSep | one-off |

### 1c. Local stack and local smoke/drills (this area)

| File | What it does | npm script | Network | Kind |
|---|---|---|---|---|
| `local-stack.ts` | Starts indexer :4300, hedger :4400 (simulated venue), 3 approver **child processes** :4201-3, API :4100 (Coinbase WS oracle), gateway :4500. Reads `.local-state/deployment.json` (`:12`); the hedge token is hard-coded (`:21`). | `dev:services` | local + **CB** public WS | ops/dev |
| `approver-process.ts` | Env-driven entrypoint for one approver process | (spawned by both stacks) | local/BaseSep | lib/entry |
| `live-smoke.ts` | Full user journey: deposit, withdraw, nonce cancel, session grant, 2-of-3 session trade, indexer and finalized projections, hedger tick (`evm_mine` at `:45`) | `smoke:local` | local | smoke |
| `reorg-smoke.ts` | `evm_snapshot`/`evm_revert` fork: an orphaned deposit must disappear from the indexer | `smoke:reorg` | local | smoke/drill |
| `leader-failover-smoke.ts` | Advances the leader epoch and checks that an old intent is re-quorumed under the new epoch | `smoke:failover` | local | drill |
| `approver-outage-smoke.ts` | Sends SIGSTOP to approver PIDs: 1 down still trades, 2 down gives 503 | `smoke:approver-outage` | local | drill |
| `sender-replacement-smoke.ts` | Automine off, then a forced same-nonce fee bump in `DurableSender` | `smoke:sender-replacement` | local | drill |
| `settlement-concurrency-smoke.ts` | 24 parallel funded wallets: open, idempotent retry, close; custody conservation | `smoke:settlement-concurrency` | local | smoke/load |
| `quote-load-smoke.ts` | 50 concurrent quotes, p95 < 2 s | `smoke:quote-load` | local API | smoke |
| `adversarial-load.ts` | In-process API: 10k quotes, exact capacity accept/reject, malformed amount | `smoke:adversarial-load` | in-proc *(inferred: default buildApi oracle, no chain)* | smoke |
| `limit-order-smoke.ts` | Deposit, marketable limit fills, non-marketable limit cancelled | `smoke:limit-order` | local | smoke |
| `live-market-data-smoke.ts` | Asserts the API oracle is Coinbase, BBO is fresh, $100/$10k quotes are consistent and fee = 2 bps (`:12`) | `smoke:live-market` | local API + **CB** | smoke |
| `sse-gateway-load.ts` | 1,000 SSE clients plus a 50% reconnect storm | `smoke:sse-gateway` | local gateway | load |
| `runtime-readiness.ts` | Health of all 7 services, config chain, 2 quotes, history, indexer lag | `smoke:runtime-readiness` | any URL (default loopback) | ops |
| `runtime-soak.ts` | N quotes at concurrency C plus SSE reconnects, p95 gate | `soak:runtime` | any URL | load |

### 1d. Base Sepolia / Hyperliquid qualification and ops

| File | What it does | npm script | Network | Kind |
|---|---|---|---|---|
| `prepare-testnet-identities.ts` | Creates or extends `.local-state/testnet-identities.json` (all private keys: deployer, 6 Safe owners, sponsor, 3 approvers, HL agent) and writes `base-sepolia.env` with the deployer key (`:18`) | `prepare:base-sepolia` | offline | one-off |
| `deployment-config.ts` | zod env loader for Base Sepolia (RPC, roles, feeds, risk capital) | lib (9 importers) | – | lib |
| `probe-base-sepolia.ts` | Chain ID on standard and preconf RPCs, USDC/Pyth bytecode, USDC decimals | `probe:base-sepolia` | BaseSep | ops |
| `preflight-base-sepolia.ts` | Chain ID, deployer ≥ 0.001 ETH, code at role addresses, USDC decimals | `preflight:base-sepolia` (also inside `deploy:base-sepolia`) | BaseSep | ops |
| `verify-base-sepolia.ts` | Verifies the deployed wiring: roles, ProxyAdmin, timelock, Safes, feeds, approvers, exposure-book readiness/limits | `verify:base-sepolia[-iteration]` | BaseSep | ops |
| `fund-base-sepolia.ts` | Deployer tops up maker backing and insurance to targets, checks the on-chain floor | `fund:base-sepolia[-iteration]` | BaseSep | ops (moves funds) |
| `bootstrap-base-sepolia-user.ts` | Sends gas to the **sponsor** identity, which is also the test trader (`:7`); deposits collateral; optionally funds the maker | `bootstrap:base-sepolia[-iteration]-user` | BaseSep | ops (moves funds) |
| `pyth-base-sepolia-smoke.ts` | Deployer sends `refreshOracle` with live Pyth updates for BTC/ETH | `smoke:base-sepolia[-iteration]-pyth` | BaseSep + Pyth | smoke (gas) |
| `base-sepolia-e2e.ts` | **BTC canary**: in-process API and 3 approvers; close any stale position, open $1 BTC, close, assert flat | `smoke:base-sepolia[-iteration]-e2e` | BaseSep + Pyth | qualification |
| `base-sepolia-hedge-e2e.ts` | **ETH hedge canary**: spawns `base-sepolia-stack.ts` with Hyperliquid testnet venue, opens $11.5 ETH, waits for a filled hedge, closes, waits for the venue unwind and a flat indexer | `smoke:base-sepolia[-iteration]-hedge-e2e` | BaseSep + Pyth + **HL-test** | qualification |
| `base-sepolia-stack.ts` | Disposable testnet runtime (indexer, hedger with optional HL venue, approver processes, API with Pyth, gateway). Accepts the manifest and identities via env JSON (`:19-20`). Enforces chain 84532 (`:21`) | `dev:testnet-services` | BaseSep + Pyth (+HL) | ops |
| `base-sepolia-soak.ts` | Supervised loop running both canaries per cycle; binds commit, candidate hash and deployment hash; writes v3 report | `soak:base-sepolia-iteration` | BaseSep + Pyth + HL | qualification |
| `hyperliquid-testnet-smoke.ts` | Verifies the HL agent and reads positions. Optional `--exercise-signer` (non-marketable order) and `--exercise-roundtrip` (real BTC fill then flatten) | `smoke:hyperliquid-testnet` | HL-test | smoke (can trade) |
| `qualification-retry.ts` | Retry classifier for the BTC canary and fresh-instance API startup | lib | – | lib |
| `supervise.ts` | Process-group child supervisor with deadline and output cap | lib | – | lib |
| `candidate-identity.ts` | Source inventory and SHA-256 "candidate hash" | lib | offline | lib |
| `observe-runtime-identity.ts` | Records bytecode hashes and validates them on two RPCs; result is "requires independent review" | (documented in `deploy/host/README.md`) | BaseSep (×2 RPC) | ops |
| `runtime-identity.ts` | `validateRuntimeIdentity()`: two-RPC block, code, role, feed and link checks | lib (persistent-service, observe) | – | lib |

### 1e. Production host, release, recovery and market data

| File | What it does | npm script | Network | Kind |
|---|---|---|---|---|
| `persistent-service.ts` | **Production role entrypoint** (`api`/`approver`/`indexer`/`gateway`/`hedger`/`keeper`): file modes 0600, `/var/lib/rfq/`, two-RPC identity check, exposure-migration and sponsor-independence gates | via `deploy/host/rfq@.service`, `Dockerfile.host` | Base (main/Sep) + Pyth + HL | runtime |
| `persistent-config.ts` | zod host config (official USDC per env, HTTPS RPCs) | lib | – | lib |
| `journal-snapshot.ts` / `journal-restore.ts` | SQLite `VACUUM INTO` plus manifest hash; verified restore | host README | offline | ops |
| `approver-recovery.ts` / `import-approver-recovery.ts` | Re-import signed approvals and gross reservations into a fenced approver journal, with full signature re-verification | host README | offline | ops (incident) |
| `operations-alerts.ts` | Evaluates a snapshot JSON against thresholds; exit code 2 means page | `check:operations-alerts` | offline | ops |
| `production-topology.ts` | Validates host/provider independence | `validate:production-topology` | offline | release |
| `mainnet-manifest.ts` | Validates the capped-canary manifest and emits an unsigned plan (`executionAuthorized:false`) | `prepare:mainnet-plan` | offline | release |
| `supply-chain-evidence.ts` | npm/pypi component list and lock hashes bound to the candidate hash and image digest | `evidence:supply-chain` (CI `release-image.yml:160`) | offline | release |
| `release-evidence.ts` / `check-release.ts` | Final gate: 16 work items, 3 audits, 72 h soak, supply chain, chain 8453 | `release:check` | offline | release |
| `vulnerability-gate.mjs` | SARIF high findings and expiring waivers | CI only (`release-image.yml:104,149`) | offline | release |
| `validate-cloudflare-static.mjs` | Security headers present and no loopback URLs in `dist/` | `validate:cloudflare-static` (in `npm test`) | offline | test |
| `prepare-cloudflare-runtime.ts` | Builds `.local-state/cloudflare-runtime-secret.json` containing the **sponsor key, all 3 approver keys and the HL agent key** (`:24`) | `prepare:cloudflare-runtime` | offline | **obsolete** (see §5) |
| `cloudflare-container.ts` | Tombstone that always throws (`:2`); it is the `CMD` of `Dockerfile.cloudflare:21` | – | – | guard/obsolete |
| `capture-market-flow.ts` + `market-flow-normalizer.ts` | Records the Coinbase+Binance trade/BBO WebSocket feed to an immutable CSV, with progress, sequence gaps and SHA-256 summary | `capture:market-flow` | **CB/BN** public WS | research ops |

### 1f. Python simulator entrypoints (`simulator/`)

| File | npm script | Network |
|---|---|---|
| all `test_*.py` | `test:python` | offline |
| `walk_forward_calibration.py` | `calibrate:quotes` | offline |
| `flow_calibration_lab.py` | `calibrate:market-flow` | offline (reads the capture CSV) |
| `fetch_coinbase_candles.py` | none (manual) | **Coinbase REST** |
| `historical_replay.py`, `market_making_scenarios.py`, `fault_harness.py` | none (manual CLI) | offline |
| `live_quote_replay.py` | spawned by `spread-parity.test.ts` | offline |

---

## 2. The qualification process

### 2.1 Pipeline

1. **Identities and deploy (one-off):** `prepare:base-sepolia` → `deploy:base-sepolia-iteration` → `fund:base-sepolia-iteration` → `bootstrap:base-sepolia-iteration-user` (sets `RFQ_TESTNET_MAKER_TARGET_USDC=25` inline in `package.json`) → `verify:base-sepolia-iteration` → `smoke:base-sepolia-iteration-pyth`.

2. **Canary A, BTC (`base-sepolia-e2e.ts`):**
   - Starts 3 approvers in-process. All share the primary RPC `https://base-sepolia-rpc.publicnode.com` (`:65`) and use `RFQ_BASE_SEPOLIA_RPC_URL` as secondary (`:68`).
   - Starts the API through `startQualificationApp`, which retries startup DNS failures by building a fresh instance (`qualification-retry.ts:36-41`).
   - Closes any leftover BTC position (`:75`), opens $1 BTC, asserts 2 distinct signers (`:77`), closes, and asserts on-chain size 0 (`:80`).
   - Prints a JSON object with `verified:true` (`:81`).
   - Retries follow `btcRetryDelay` (`qualification-retry.ts:9-17`): price moved → 250 ms; "fresh settlement price unavailable" → 5 s; approver quorum where *every* detail is a `TimeoutError` → 40 s. Ambiguous submissions and generic policy rejections are never retried.

3. **Canary B, ETH plus Hyperliquid hedge (`base-sepolia-hedge-e2e.ts`):**
   - Spawns the full `base-sepolia-stack.ts` on random ports with `RFQ_HEDGE_VENUE=hyperliquid-testnet`, band 1 USDC, min 10, max 25 USDC (`:21`).
   - Waits for a healthy hedge loop and ETH risk mode `normal` (`:63-65`) and flattens leftovers (`:68-69`).
   - Runs a **maker-capital preflight** that re-implements the on-chain stress test (`:30-40`).
   - Opens $11.5 ETH and requires a journaled filled opening hedge with no `reason` (`:73-76`).
   - Closes, then requires customer = venue = 0 for ETH *and* BTC, unique client IDs, venue order IDs, and an indexed flat account (`:77-84`).
   - Prints `verified:true` with the transaction hashes and HL order IDs (`:85`).

4. **Soak (`base-sepolia-soak.ts`):**
   - Validates the env bounds (≤168 h, ≤20k cycles) (`:8`).
   - Pins the git commit, candidate hash (all source under `.github contracts services packages scripts apps deploy security simulator` plus root build files; `candidate-identity.ts:5-6`) and the deployment manifest hash (`:9-11`).
   - Each cycle re-checks all three hashes (`:25`), then runs both canaries through `supervise('npm',['run',...])` with a per-child deadline (default 15 min) and process-group kill (`supervise.ts`).
   - Scrapes child stdout for a `verified:true` JSON object (`:17-19`).
   - **Stops on the first failure** (`:26`).
   - Writes an atomic 0600 checkpoint to `.local-state/testnet-soak-<uuid>.json` and `-latest.json` (`:16`).
   - Status is one of `completed|incomplete|interrupted|failed`; the final hashes are re-checked (`:30`).

5. **Release gate (`release-evidence.ts`):**
   - Report `version:3`, `status:'completed'`, `failures:0`, `requestedHours≥72`, monotonic `elapsedMs≥72h` (`:19`).
   - Start and final candidate hash equal the reviewed candidate, and the deployment hash is unchanged (`:20`).
   - Exactly two verified results per completed cycle, with both BTC and ETH present (`:21-22`).
   - In addition: 16 `R1..R16` verified work items (`:5,8`), 3 audits with distinct scopes bound to the candidate hash (`:16-17`), supply-chain lock hashes matching the candidate (`:14`), and `chainId:'8453'`.

### 2.2 Status

- **Tooling:** complete and unit-tested (`supervise.test.ts`, `qualification-retry.test.ts`, `release-evidence.test.ts`).
- **Evidence:** one clean soak cycle (`VALIDATION-REPORT.md:105,115`). The 72 h run has not been done: R16 is "pending" (`PRODUCTION-IMPLEMENTATION-PLAN.md:35`) and the checklist item is unchecked (`PRODUCTION-RELEASE-CHECKLIST.md:26`). There is no `.local-state/` in this checkout, so no soak artefact exists here.
- **Recent churn:** 6 consecutive commits loosened or extended canary retries: `5fdac0e`, `f0d3e33`, `24fd00f`, `29fbfa0`, `c8b2323`, `6266458`, `bae3332`. For example, `c8b2323` added retries on `TimeoutError`, "chain submission failed", hedge-risk-unavailable and approval-risk-changed, raised the approve timeout to 90 s, and moved the indexer start block to `head-20`.
- **Waiver expired:** `security/vulnerability-exceptions.json` expired on 2026-09-30, so the image release gate now fails closed (see §0).

### 2.3 Findings on qualification rigour

| # | Finding | Evidence | Recommendation |
|---|---|---|---|
| Q1 | **The two canaries use opposite retry policies.** The BTC canary refuses ambiguous submissions, timeouts and "policy rejected" (`qualification-retry.ts:7-8`, tested at `qualification-retry.test.ts:16-19`). The ETH canary retries `policy rejected`, any `TimeoutError`, and `"chain submission failed"` (`base-sepolia-hedge-e2e.ts:45-50,56`), 12 attempts × 40 s = up to 8 min. It does flatten after a chain-submission failure (`:58`). | as cited | Move the hedge canary onto `qualification-retry.ts` with an explicit, tested classifier. Do not retry `policy rejected` or ambiguous submissions without first reconciling the nonce or intent. |
| Q2 | **Retries are invisible in the evidence.** The soak keeps only a fixed key list (`base-sepolia-soak.ts:18`). Attempt counts, latencies and rejection classes are printed (`hedge-e2e:58`) but discarded. A 72 h "0 failures" can hide many rejections. | `:18`, `release-evidence.ts:19-22` | Have the canaries write a structured evidence file (attempts, rejection codes, approval→inclusion ms). The release gate should bound the retry/rejection rate and the p95 latency. |
| Q3 | **Errors are classified by substring.** `String(error).includes("...")` on human-readable messages (`hedge-e2e:41-50`), and on JSON fragments such as `'"error":"chain submission failed"'`. This breaks silently if API wording changes. | as cited | The API should return stable machine error codes, and both canaries should switch on those codes. |
| Q4 | **Evidence is scraped from stdout.** A brace-matching scanner over up to 1 MB of stdout (`soak:17-19`, `supervise.ts:12`). | as cited | Pass `--evidence <path>` to children and read the file instead. |
| Q5 | **RPC independence is not exercised.** All three approvers use the same public primary RPC in both canaries (`e2e:65,68`; `hedge-e2e:22` passes `fastPrimary` three times). The report itself admits shared public infrastructure (`VALIDATION-REPORT.md:123`). | as cited | Read per-approver RPCs from config in qualification, as `base-sepolia-stack.ts:25` already supports. |
| Q6 | **Trader = sponsor.** The canary trades from `identities.sponsor` (`e2e:26`, `hedge-e2e:17`), and bootstrap funds the sponsor as the trader (`bootstrap-base-sepolia-user.ts:7`). Production forbids the sponsor sharing other roles (`persistent-service.ts:29`), but never tests a separate trader identity. | as cited | Add a dedicated `trader` identity. |
| Q7 | **Indexer start block is shifted.** Hedge e2e sets `deploymentBlock = max(manifest, head-20)` (`hedge-e2e:20`). The hedger reads `/v1/exposure` (`services/hedger/src/server.ts:38`), which reads contract state directly, so hedge correctness is unaffected *(inferred)*. Account activity is only indexed from 20 blocks back. | as cited | Acceptable as a stall workaround, but document it. A persistent indexer would be better. |
| Q8 | **The stress formula is hand-copied into the preflight.** `hedge-e2e:30` duplicates `RFQRiskMath.stressLoss` and `backing/4`. | see §3.3 | Import `makerStress` from `packages/shared/src/exposure-admission.ts:8`. |
| Q9 | **Providers are leaked in the preflight.** `makerCapitalPreflight` builds a new `JsonRpcProvider` per call and never destroys it (`hedge-e2e:35`). So do `:20` and the polling loops in bootstrap/fund (§4). | as cited | Use a shared provider factory with `destroy()`. |
| Q10 | **Expired vulnerability waiver** (2026-09-30). | `security/vulnerability-exceptions.json`, `vulnerability-gate.mjs:11` | Renew or remove the exception. Consider an "expires within N days" CI warning. |
| Q11 | **Stale docs.** `VALIDATION-REPORT.md:11` says 48 Python tests (actual 50). `ECONOMIC-SPECIFICATION.md` says "the simulator currently uses floating point only" (Scope section), but `fixed_point.py` exists. | as cited | Refresh. |

---

## 3. The simulator

### 3.1 Modules

| Module | Model | Arithmetic | Purpose |
|---|---|---|---|
| `rfq_model.py` | Quadratic portfolio impact `½xᵀAx`, 6-scenario stress, conservative pending-subset enumeration, `QuotePolicy` with a capped rebate (`:83-106`), `ReservationBook` | float | Research invariants: splitting cannot reset impact, PSD matrix, no unfunded rebate, cross-wallet reservations |
| `fixed_point.py` | Same as above in contract units (USDC 1e6, RATE 1e12, floor division); K = 10 000 / 12 000 / 6 573 (`:94-112`) | int | "Contract-shaped" reference; telescoping split invariance |
| `state_machine.py` | Admission → 2-of-3 approval → settle with current-state impact floor → epoch failover | int | Lifecycle invariants |
| `fault_harness.py` | 5 drills: signer offline, key compromise, API crash after quorum, sponsor empty, lost hedge ack (`:32-68`) | int | Fault reasoning (a toy venue) |
| `accounting.py` | Margin tiers (`:14-18`), equity with uPnL restriction, funding transfer, liquidation chunk (`:56-72`), loss waterfall, pro-rata resolution, oracle mode (`:110-120`) | float | Research accounting |
| `adversarial_scenarios.py` | Oracle median/divergence mode, cumulative inventory charge, √t latency move, hedge-gap admission mode | float | Adversarial policy checks |
| `market_making_scenarios.py` | 7 regimes (calm … hedge outage) with a float mirror of adaptive-v1 (`:58-70`), toxic flow, hedge band/slices; reports PnL, drawdown, residual | float, seeded RNG | Scale "policy lab", not a forecast |
| `walk_forward_calibration.py` | Purged chronological 60/20/20 split; grid search over 4 weights; asymmetric loss (under-quote ×6 vs over-quote ×0.25, i.e. 24:1; `:52-54`); selects on the worst validation regime; untouched holdout; shadow-eligibility rule (`:83`) | float | Spread-weight calibration |
| `flow_calibration_lab.py` | Normalised tape → 250 ms buckets → causal EWMA vol, 30 s flow imbalance, 2 s venue basis, half-spread/size hedge cost; synthetic toxic mixtures 5/25/50/90%; forward markouts 1 s/5 s/30 s/5 min; data gates (≥24 h, ≥10k trades, 2 venues, both markets, 5-min label, capture integrity) (`:98-101`); HTML report | float | Calibration from public flow |
| `live_quote_replay.py` | **Integer** replay of `constructQuote` (four-corner pending impact, ceil rounding, tolerance) | int | Parity oracle for TS |
| `historical_replay.py` + `fetch_coinbase_candles.py` | Hourly Coinbase candles (2025-09-01..2026-09-01, 8,751 rows/market) against a fixed +$250k/+$250k book; one-bar and delayed-hedge loss | float | Market-risk sanity check (worst hour $24.6k, p99 $7.7k) |

### 3.2 What is actually calibrated

- **Nothing in production is calibrated from data.** The live constants (K matrix, stress set, margin tiers, spread component caps and weights `CURRENT_WEIGHTS=(.2,.0035,1,1)`, `walk_forward_calibration.py:26`) are hand-set "beta hypotheses" (`ECONOMIC-SPECIFICATION.md`, Quote construction).
- The calibrators produce **research-only candidates**. `status:"research-only"` (`walk_forward_calibration.py:81`). Promotion to shadow requires data gates and is never automatic (`MARKET-FLOW-CALIBRATION.md`, Promotion process).
- The only real-data run on record is a 30 s plumbing capture, which correctly failed the data gates. A 25 h study "in progress" since 2026-09-11 has no recorded result (`VALIDATION-REPORT.md:17-19`).
- The toxicity in the flow lab is a **synthetic label**. The toxic/benign side is assigned by seeded RNG (`flow_calibration_lab.py:70`), so the calibration measures how well spreads cover markouts under assumed toxicity mixtures, not real customer toxicity. The docs say so honestly.

### 3.3 Duplication between Python, TypeScript and Solidity

| Concept | Solidity | TS shared/services | Scripts | Python | Parity test? |
|---|---|---|---|---|---|
| Impact K (10000/12000/6573) | `contracts/libraries/RFQRiskMath.sol:170`, `contracts/RFQAuthorization.sol:46`, `contracts/test/RFQRiskMathBaseline.sol:9` | `packages/shared/src/pricing.ts:4,11` | `scripts/risk-differential.mjs:18` | `fixed_point.py:94-112`, `live_quote_replay.py:8`; float `rfq_model.py:140-162` | Sol↔JS (`risk-differential.mjs`); TS↔Py quote (`spread-parity.test.ts:12-16`). **No Sol↔Py.** |
| Stress scenarios (±20/25, ±15/∓20, ±40/50) | `RFQRiskMath.sol:197-205`, `RFQAuthorization.sol:232-235` | `exposure-admission.ts:8` | `risk-differential.mjs:37`, **`base-sepolia-hedge-e2e.ts:30`** | `fixed_point.py`, `rfq_model.py` baselines | Sol↔JS only |
| Stress cap = backing/4 | `RFQRiskMath.sol:72,149,154` | `exposure-admission.ts:48`, `gross-reservations.ts:43` | `hedge-e2e:35` (`*4n`) | `fixed_point.py` (`RATE//4`), `rfq_model.py` (0.25), `state_machine.py:56` | partial |
| Margin tiers (6 tiers up to 5M) | `RFQRiskMath.sol:207-214` | `pricing.ts` `marginRate` | – | **`accounting.py:14-18` has 3 tiers with different breakpoints (25k/50k/100k vs 25k/100k/250k/1M/2.5M/5M) and raises above 100k** | **Drifted, untested** |
| Liquidation (22% target, 0.5% penalty, 25% chunk, 10k full close, keeper 10 bps ≤ 20% penalty) | `RFQRiskMath.sol:218-235` | – | – | `accounting.py:56-72` (no keeper reward) | No; values happen to agree |
| Funding | `RFQRiskMath.sol:262-276` (skew/`maxMarketNotional`, ±100%) | inline reference in `exposure-admission.test.ts:31` | – | `accounting.py:49-53` (generic rate; not the skew formula) | No |
| Adaptive spread | – | `pricing.ts:20-32` | – | `walk_forward_calibration.py:39-50` (exact, parity-tested); **`market_making_scenarios.py:58-70`** (float; toxicity in 0..1 not bps; one ceil of the total instead of per component) | Only the walk-forward copy |
| Oracle modes | contract `MAX_ORACLE_AGE=15` s (`RFQClearing.sol:25`), `MAX_WIDTH_BPS=100` | approvers 8 s (`VALIDATION-REPORT.md:31`) | – | `accounting.py:110-120` (2 s / 8 s, 50/100 width, 25/100 divergence) vs `adversarial_scenarios.py:13-25` (1.5 s / 3 s, 25/100 divergence) | **Two incompatible Python models** |
| Hedge admission mode (gap > band → guarded, > 2×band or unhealthy → reduce-only) | – | hedger/API *(inferred)* | – | `adversarial_scenarios.py:41-46` and `market_making_scenarios.py:92` | No |
| Pending subset enumeration and `add()` | – | four-corner envelope `pricing.ts` `requiredPendingImpact` | – | `rfq_model.py:15,53` and `fixed_point.py:23,65` | intra-Python duplicate |

**Assessment.**
- Some of the multi-language copies are **deliberate N-version references**. The JS BigInt model checks Solidity with 13,500 comparisons, and Python checks TS with 2,002 vectors. That is good practice.
- The problem is the copies that **nobody checks**: `accounting.py`, the market-making spread, the Python oracle-mode models and the hand-copied stress formula in `hedge-e2e`. They give a false sense of simulation coverage.
- Constants live as literals in about seven places with no single parameter source.
- **Spec vs contract on funding scale *(inferred, verify)*:** the spec sets `skewScale` = 250k per-side cap (`ECONOMIC-SPECIFICATION.md`, Funding). The contract scales by `_marketLimit(market)` (`RFQClearing.sol:555`), which defaults to the 5M ceiling. At default limits the funding APR is therefore 20× lower than specified.

---

## 4. Duplication and DRY opportunities in scripts

| Pattern | Occurrences | Suggested shared module |
|---|---|---|
| `required(name)` env reader | `approver-process.ts:3`, `base-sepolia-hedge-e2e.ts:14`, `base-sepolia-stack.ts:17`, `hyperliquid-testnet-smoke.ts:8` (`replace_` sentinel handling differs: approver-process does not check it) | `scripts/lib/env.ts` with zod, extending `deployment-config.ts` |
| Read `.local-state/testnet-identities.json` with ad-hoc `Identity` types | 11 files: `base-sepolia-e2e.ts:24`, `hedge-e2e:16`, `base-sepolia-stack.ts:20`, `hyperliquid-testnet-smoke.ts:7`, `bootstrap-base-sepolia-user.ts:6`, `deploy-base-sepolia-iteration.ts:5`, `deploy-testnet-governance.ts:8`, `finalize-testnet-governance.ts:10`, `upgrade-base-sepolia-pyth.ts:14`, `prepare-cloudflare-runtime.ts:23`, `prepare-testnet-identities.ts:5` | `lib/identities.ts` (zod schema, 0600 mode check) |
| Deployment manifest path `process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE ?? ".local-state/base-sepolia-deployment.json"` with a per-file `Manifest` type | 11 files (e.g. `e2e:23`, `hedge-e2e:20,32` read **twice in one file**, `fund:6`, `bootstrap:6`, `pyth-smoke:9`, `verify:5`, `stack:20`). The soak defaults to the *iteration* file instead (`soak:9`) | `lib/manifest.ts` (zod; one default per profile) |
| Local `.local-state/deployment.json` untyped reads | `local-stack.ts:12`, `reorg-smoke.ts:7`, `leader-failover-smoke.ts:7`, `approver-outage-smoke.ts:6`, `settlement-concurrency-smoke.ts:6` | same |
| "Tx mined but state not visible yet" loops, each building a **new provider per attempt** with no `destroy()` | `bootstrap-base-sepolia-user.ts:8,14,23,34,37,39`, `fund-base-sepolia.ts:14-18,24-31`, `pyth-base-sepolia-smoke.ts:23-26`, `deploy-base-sepolia.ts:13+` | `lib/poll.ts` `waitForState(read, accept, {attempts, intervalMs})` plus a provider factory |
| Retry/poll helpers | `qualification-retry.ts:25-31`, `hedge-e2e:27` (`waitFor`), `:57-58` (bespoke 12× loops), `e2e:44-51`, `settlement-concurrency-smoke.ts:39-46`, `live-smoke.ts:42,47`, `limit-order-smoke.ts:14`, `reorg-smoke.ts:23-24,55-58` | one `retry`/`waitFor` with a typed classifier |
| API `post`/`get` helpers and nonce generator `BigInt(0x+uuid)` | `post`: 12 files. Nonce: 7 files (`live-smoke.ts` ×4, `e2e` ×2, …) | `lib/rfq-client.ts` |
| Quote → prepare → sign typed data → approve flow | `e2e:55,60`, `hedge-e2e:57-58`, `leader-failover-smoke.ts:13-19`, `approver-outage-smoke.ts:9`, `settlement-concurrency-smoke.ts:21-26,40-43`, `live-smoke.ts:32-36`, `limit-order-smoke.ts` | `client.trade(wallet, {market, side, amount, reduceOnly})`, `client.close(wallet, market)` |
| Stack assembly: approver spawn, `waitForHealth`, PID files, shutdown | `local-stack.ts:27-44` vs `base-sepolia-stack.ts:33-40`, and role construction again in `persistent-service.ts:32-39` | `lib/stack.ts` with a profile object (local / testnet / host) |
| Hard-coded endpoints and addresses | `https://sepolia.base.org` in 7 files; `publicnode` in 3; official USDC/Pyth addresses in `probe-base-sepolia.ts:6-7`, `prepare-testnet-identities.ts:19,22`, `persistent-config.ts:4` | `lib/networks.ts` constants |
| Latency percentile | `quote-load-smoke.ts:7`, `runtime-soak.ts:10`. Python: `walk_forward_calibration.py:56`, `historical_replay.py:34` (**different method**: `int((n-1)q)` vs `ceil(nq)-1`), `market_making_scenarios.py:~141` | one helper per language |
| "is main module" guard | `operations-alerts.ts:17`, `production-topology.ts:5`, `mainnet-manifest.ts:31`, `supply-chain-evidence.ts:20`, plus a variant in `vulnerability-gate.mjs:24` | trivial helper, or a CLI router (§6) |
| Atomic write (tmp + rename, 0600) | `base-sepolia-soak.ts:16`, `capture-market-flow.ts:11`, `journal-snapshot.ts`, and `writeFileSync(...{mode:0o600})` ×6 | `lib/fs.ts` `writeAtomicPrivate()` |
| Two-RPC on-chain wiring verification | `verify-base-sepolia.ts` (single RPC, bespoke) vs `runtime-identity.ts` `validateRuntimeIdentity` (two RPCs, pinned block) vs `observe-runtime-identity.ts` | build `verify-base-sepolia` on `validateRuntimeIdentity` |
| Base Sepolia readiness | `probe-base-sepolia.ts` and `preflight-base-sepolia.ts` both check the chain, USDC decimals and Pyth code | merge into one `preflight` with a `--deployer` flag |

---

## 5. Obsolete, one-off and consolidation candidates

**Obsolete or risky:**
- **`prepare-cloudflare-runtime.ts`**:
  - It produces `.local-state/cloudflare-runtime-secret.json`, which no file in the repo consumes.
  - The Container path was abandoned (`cloudflare-container.ts:2` throws; `CLOUDFLARE-DEPLOYMENT.md:19` says Containers are unavailable on the account).
  - It bundles **all three approver keys, the sponsor key and the HL key into one secret** (`:24`), which defeats 2-of-3 independence even on testnet.
  - Recommendation: delete it (and its npm script), or hard-fail it like the container entrypoint.
- **`cloudflare-container.ts` and `Dockerfile.cloudflare`:** an intentional tombstone. Keep it only while `Dockerfile.cloudflare` exists. Better to delete both and note the decision in `CLOUDFLARE-DEPLOYMENT.md`. Note that `Dockerfile.cloudflare` is in the candidate hash inventory (`candidate-identity.ts:6`).

**One-off (archive under `scripts/archive/` or `scripts/testnet/ceremony/`):**
- `upgrade-base-sepolia-pyth.ts` (the bounded-parse adapter migration, `VALIDATION-REPORT.md:81`).
- `deploy-testnet-governance.ts`, `finalize-testnet-governance.ts`, `prepare-testnet-identities.ts`.
- `fetch_coinbase_candles.py` and `historical_replay.py`: a legacy candle study, superseded by the flow lab for calibration.

**Thin wrappers and npm-matrix bloat:**
- `deploy-base-sepolia-iteration.ts` (mutates env, then imports).
- The `*-iteration-*` npm variants exist only to set `RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE` (and `RFQ_TESTNET_ITERATION` / maker target) inline in `package.json`. That doubles about 8 scripts.
- Replace both with `--profile governed|iteration`.

**Overlapping smokes:**
- `quote-load-smoke.ts` ⊂ `runtime-soak.ts` (both are quote load with percentiles).
- `runtime-readiness.ts` vs the health/quote parts of `live-smoke.ts`.
- `verify-base-sepolia.ts` vs `observe-runtime-identity.ts` vs `runtime-identity.ts`.
- `probe-` vs `preflight-base-sepolia.ts`.

**Confusing naming:** `soak:runtime` (local HTTP load) vs `soak:base-sepolia-iteration` (72 h qualification).

**Python:**
- `rfq_model.py` (float) is superseded by `fixed_point.py` for anything contract-related. Keep it only for the rebate-policy research, or fold that into `fixed_point.py`.
- `accounting.py` and the two oracle-mode functions should either be aligned with Solidity and tested, or deleted.
- The spread in `market_making_scenarios.py` should import `walk_forward_calibration.spread` (or a shared module) instead of keeping its own mirror.

**Proposed single CLI** (`npm run rfq -- <group> <cmd>`):

```
rfq local   stack | deploy | smoke [journey|reorg|failover|approver-outage|sender|concurrency|limit|market-data] | load [quotes|sse|adversarial]
rfq testnet identities | preflight | deploy [--profile] | upgrade | fund | bootstrap | verify | pyth-refresh | canary [btc|eth-hedge] | soak --hours 72 | hl-check
rfq host    run <role> <config> [secret] | snapshot | restore | import-approver-recovery | observe-identity
rfq release topology | mainnet-plan | supply-chain | vuln-gate | check | alerts
rfq data    capture-flow | calibrate-flow | calibrate-quotes
```

---

## 6. Technical assessment and recommendations

1. **Keep the Python simulator, but narrow it to two jobs: independent oracle and research lab.**
   - It is stdlib-only, runs in 0.35 s and has no dependencies, so it costs almost nothing to keep.
   - Its value is that it is an *independent* implementation in another language. Porting it to TS would remove that independence.
   - Do instead:
     - (a) Add a **Solidity↔Python differential**: dump `risk-differential.mjs` vectors (or Hardhat traces of `stateful-clearing-e2e`) to JSON and replay them through `fixed_point.py`. This is listed as outstanding in `VALIDATION-REPORT.md:127`.
     - (b) Delete or align `accounting.py`, the Python oracle-mode functions and the market-making spread mirror.
     - (c) Add a `simulator/pyproject.toml` with `ruff` and type-checking. Optional: `hypothesis` for property tests (it would be the only dependency).

2. **Create one source for economic parameters.**
   - A versioned `packages/shared/economics.json` (K matrix, stress scenarios, margin tiers, liquidation constants, fee split, spread caps, oracle thresholds).
   - Codegen or assert it into the Solidity constants (a test can read the compiled `RFQRiskMath` via the `risk-differential` harness), TS (`pricing.ts`, `exposure-admission.ts`) and Python (`fixed_point.py`, `walk_forward_calibration.py`).
   - A single parity test should fail if any copy diverges. This would also have caught the funding `skewScale` spec/contract question.

3. **Foundry.** For contract invariants (owned by another reviewer), forge invariant fuzzing would be faster and stronger than the Hardhat `.mjs` stateful scripts. It can also call the Python oracle through `ffi` for differential fuzzing. Keep deployment and governance ceremonies in TS: they rely on `@safe-global/protocol-kit` and the ethers `ContractFactory` linking already in place, so moving them to `forge script` would mean rewriting the Safe flows for little gain.

4. **A typed ops CLI and `scripts/lib/`.**
   - Build it with `node:util.parseArgs` (no new dependency) or commander, routing to the existing modules.
   - Shared modules, all zod-validated: env, manifests, identities, a provider factory (`batchMaxCount:1`, `destroy()`, primary/secondary), poll/retry with typed error classes, an `RfqClient`, an evidence writer, and atomic-private writes.
   - This removes about 30–40% of the script LOC *(inferred)* and the provider leaks.

5. **Qualification hardening** (see §2.3):
   - One retry classifier.
   - Machine error codes from the API.
   - File-based evidence with attempts and latencies.
   - Gate on rejection/retry rates and p95.
   - Per-approver RPCs.
   - A separate trader identity.
   - Renew the expired vulnerability waiver.

6. **Readability.**
   - Most scripts and libraries are minified-style single lines (for example `base-sepolia-soak.ts:18`, `production-topology.ts:4`, `persistent-service.ts:21`, `mainnet-manifest.ts:28`). That is a real review and audit cost for safety-critical tooling.
   - Adopt Prettier and ESLint (with `max-len`/`max-statements-per-line`) and reformat mechanically in one commit.
   - Do the same with ruff for the Python (`flow_calibration_lab.py` uses `;`-chained statements throughout).

7. **Hygiene.**
   - `prepare-testnet-identities.ts` writes the deployer private key into `base-sepolia.env` at the repo root. It is git-ignored (`.gitignore:8` `*.env`), but `.local-state/` is the better home.
   - `local-stack.ts:21` uses a fixed hedge token; that is fine for loopback only.

---

## 7. The economic model in plain language (for a product doc)

**What you trade.**
- BTC-USDC and ETH-USDC linear perpetuals on Base.
- You trade against a single professional market maker through request-for-quote: you ask for a price for a size and get an exact, all-or-nothing fill price.
- USDC is the only collateral. Each account holds one net position per market and uses cross margin.

**How your price is built.**
- Start from the oracle's current bid (if you sell) or ask (if you buy). The oracle is Pyth, using its signed price ± confidence.
- Then add three things:
  1. **A risk spread.** The minimum is 2 bps. It widens automatically and market-wide, never per wallet, with:
     - short-term volatility, up to +40 bps,
     - recent toxic order flow, up to +35 bps,
     - hedging cost and latency, up to +30 bps (more when the maker's hedging is impaired),
     - the gap between trading venues, up to +25 bps,
     - oracle uncertainty, up to +20 bps.

     The total spread is capped at 100 bps (1%).
  2. **An inventory charge.** If your trade adds to the maker's existing book in a direction, you pay a small extra amount that grows with the size of the book. At $100k of open exposure the marginal charge is about 10 bps for BTC and 12 bps for ETH; BTC and ETH positions count partly together. Splitting an order into many small ones or across wallets does not reduce this charge. In the live quoter, trades that reduce the maker's inventory are not charged and get no rebate.
  3. **A trading fee of 2 bps.** Part of every fee funds the insurance fund: 20% until insurance reaches 25% of the maker's target capital, then 10%. The rest goes to the maker.
- Your signed order also carries a protection limit 8 bps beyond the quoted price. If the price moves further before settlement, the trade does not happen.
- Quotes live for up to 30 seconds and need a price snapshot no more than 2 seconds old.

**Size limits.**
- Each trade and each market has caps. The software ceiling is $1M per trade and $5M per market; launch settings are much lower (for example a $25k per-RFQ quoter cap).
- The maker also stops taking new risk if a bad scenario would cost more than **25% of its posted capital**. The scenarios are BTC/ETH moving together by ±20/25% or ±40/50%, or in opposite directions by 15/20%.

**Margin.**
- The required margin rises with position size. Per market:

  | Position size | Initial margin | Maintenance margin |
  |---|---|---|
  | up to $25k | 20% | 12% |
  | to $100k | 25% | 15% |
  | to $250k | 33% | 20% |
  | to $1M | 50% | 30% |
  | to $2.5M | 67% | 40% |
  | to $5M | 100% | 60% |

- Requirements add up across markets.
- Unrealised profit does not count toward opening new positions or withdrawing; close the position to realise it. Unrealised losses always count.

**Funding.**
- Funding accrues continuously.
- When customers as a group are net long, longs pay and shorts receive (and the reverse), with the maker taking the other side of the net.
- The rate grows in proportion to how lopsided customer positioning is, capped at ±100% APR. The skew that reaches the cap is configurable; see the open point in §3.3.

**Liquidation.**
- If your equity falls below maintenance margin, anyone can trigger a liquidation.
- It closes the smallest of: 25% of the position, or just enough to bring you back to about 22% equity. Positions of $10k or less, or with zero equity, are closed fully.
- You pay a 50 bps penalty, capped at your remaining equity. The liquidator earns 10 bps of the closed size, at most one fifth of the penalty. The rest goes to insurance.

**If losses exceed collateral.**
- Losses are covered in this order: your collateral, then the insurance fund, then the maker's posted capital.
- Only if all of that is exhausted does the protocol enter a transparent wind-down. Positions are valued from oracle prices, and remaining assets are paid out pro rata, so no one gains by withdrawing first.

**Hedging (operational, off-chain).**
- The maker hedges its net exposure on Hyperliquid once it drifts outside a band.
- If the hedge gap grows beyond the band, new trade sizes are halved. Beyond twice the band, or if hedging is down, only risk-reducing trades are accepted.

**Oracle safety.**
- Settlement uses signed Pyth prices that must be fresh: the contract accepts prices up to 15 s old and the approvers up to 8 s.
- Stale, wide or divergent prices put the market into guarded or reduce-only mode instead of trading on a bad price.
