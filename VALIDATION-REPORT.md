# RFQ Markets validation report

Status date: 2026-09-10. This separates executable evidence from architectural intent. The repository contains a local clearing prototype and a small-capital Base Sepolia deployment connected to Hyperliquid testnet. It has not been independently audited.

## What now runs

`npm test` performs local contract, model, service and frontend gates:

1. Compiles the contracts with Solidity 0.8.34 and executes three suites on Hardhat's OP Stack-compatible local EVM. The authorization suite verifies two distinct approvers, the user price bound, sender-independent sponsorship, nonce consumption, stale inventory-impact rejection and leader-epoch fencing, plus 400 deterministic arithmetic invariant calls. The clearing suite verifies proxy initialization, USDC custody, EIP-3009 deposit routing, oracle-bound settlement, ERC-1271 contract-account trades, limited session activation/use/revocation, session-withdrawal rejection, positive-uPnL withdrawal restrictions, partial liquidation, insurance allocation, exact internal/token conservation, an upgrade/rollback/reapply cycle with an open position, and a real pro-rata insolvency haircut. The stateful suite executes 120 deterministic trades across four accounts and both markets, attempts periodic replays, and checks aggregate exposure, customer collateral and token custody after every transition.
2. Runs OpenZeppelin's upgrade-safety validator against the compiler build information and `RFQClearing`; it passes with the explicit linked-library allowance. `RFQRiskMath` has no storage, external calls, delegation, self-destruction or mutable behavior; deployment links and records its exact address before the implementation is deployed.
3. Runs 39 Python tests over floating-point research economics, integer contract-shaped arithmetic, lifecycle faults, accounting and historical data parsing. The adversarial suite covers Sybil order splitting, parallel reservation bursts, stale and divergent oracle modes, latency under volatility, guarded capacity and hedge-outage deleveraging. The scale laboratory includes calm, trend, high-volatility, toxic-burst, gap-up, crash and hedge-outage regimes.
4. Runs 62 HTTP/configuration/unit integration tests across deployment validation, official Data Streams v3 decoding, Coinbase WebSocket/REST acquisition, bounded quote/order admission, exact-base close pricing, the API, three independently keyed approvers, hedge worker, incremental risk projections and the dedicated SSE gateway. They verify exact EIP-712 trade, deposit, withdrawal, cancellation, close and maker signatures, pinned domain separation, cryptographic response identity, two-of-three availability, durable-before-response signing, duplicate approval-request coalescing, rejection of unauthorized capacity reservations, single-account/nonce quote binding with idempotent retries, authoritative reduce-only binding, worse second same-direction pricing, restart recovery and idempotent hedge client IDs. The gateway cases cover 100,000 shared clients, complete-frame replay, parser fragmentation, reconnect failure, and slow-reader eviction on data, replay and heartbeats. Oracle cases cover metadata disagreement, price normalization, concurrent request coalescing, report-bounded quote expiry, WebSocket use, subscriber notification, REST recovery and unavailable-feed fail-closed behavior. Development wallet exposure is rejected unless chain ID 31337 and a loopback RPC are both active. Hedge fault cases cover acknowledgement loss, partial fills, venue minimum order handling, transient indexer failure and suppression of new slices while an order remains open. Differential samples prove the linear four-corner pending envelope is at least as conservative as exhaustive subset evaluation, and a 10,000-reservation case demonstrates bounded work.
5. Type-checks the TypeScript workspace and builds four React production bundles: customer trading/markets, private hedge operations, public documentation and internal operations documentation. Browser passes verified BTC/ETH and Buy/Sell state, event-driven live pricing, locally derived exact-size indications, restart recovery, wallet detection and persistent completion feedback. The browser contains no market or quote polling loop; one firm quote is requested only on click. The public Markets view was also checked against the live indexer for finalized aggregate exposure, open positions and execution history.

`npm run smoke:local` exercises the separately running processes over loopback with a fresh EOA. It signs a source-bound `DepositIntent`, settles simulated destination USDC into clearing, performs sponsored withdrawal and cancellation, activates a limited session, executes a popup-free session-signed trade with two independently chain-checked `MakerApproval` signatures, verifies account/public finalized projections, and triggers hedge reconciliation.

`npm run smoke:quote-load` issues 50 concurrent BTC/ETH quote requests and requires zero failures plus local p95 below two seconds. The latest run completed with zero failures; short-lived pinned-snapshot reuse and per-market oracle request coalescing keep warm sequential quotes below one millisecond in the local process. These localhost numbers are regression signals, not Base or Data Streams latency evidence.

`npm run smoke:live-market` requires both Coinbase markets to have positive ordered BBO values less than three seconds old, then checks $100 and $10,000 size-specific quotes for correct directional anchoring, fees and monotonic inventory charge. The latest 50-request concurrent firm-quote run completed with zero failures at p50 668 ms, p95 1,002 ms and p99 1,031 ms while the public WebSocket was active. This includes local OP-node mining and three approvers' independent pinned-state reads; it identifies approval/RPC fanout as the next latency target.

`npm run smoke:sse-gateway` opened 5,000 real HTTP SSE connections at approximately 11,300 connections per second, removed half, and delivered cached complete frames through a 2,500-client reconnect storm in approximately 200 ms. The larger 100,000-client deterministic fanout test completed a frame in approximately 100 ms. These are local runtime regression measurements, not edge-network capacity claims.

`npm run smoke:reorg` forces a local chain fork after the indexer records a deposit, replaces the branch with empty canonical blocks, and verifies that the orphaned account, activity and finalized materialized risk all roll back while the complete paginated canonical history survives. The drill uses a writer distinct from the API sender and waits for zero indexer lag. Three consecutive recovery runs passed. Earlier runs exposed both a sync/reorg race and a faulty one-page test assumption; the indexer now verifies its stored tip again after every pass and rebuilds immediately if the chain changed during that pass.

The 2026-09-09 live sequence ran `smoke:local`, `smoke:failover`, `smoke:local` again and `smoke:reorg` against one fresh deployment. Trades settled both before and after the epoch transition, the old prepared intent was fenced, and the canonical read model survived branch replacement. A later idle-stack rerun found that Hardhat's stopped block clock could jump past a chain-derived intent deadline and leave the nontraded market's portfolio mark stale. The local quote path now advances the simulated clock before pinning its block and catches up an exposed nontraded mark through the serialized sender. Approvers admit observations no more than eight seconds old when signing; clearing allows up to fifteen seconds so the already-approved transaction has bounded inclusion time without silently widening quote validity.

`python3 -B simulator/fault_harness.py` passes five deterministic drills:

| Fault | Observed safe behavior |
| --- | --- |
| One signer offline | The other two form quorum. |
| One approver key compromised | Reusing one signature does not count twice. |
| API dies after two signer logs | Promotion increments the epoch and invalidates the possibly escaped approval. |
| Sponsor wallet is empty | Authorization is sender-independent, so a user or backup sender can submit the same payload. |
| Hedge acknowledgement is lost | Query by unique client order ID discovers the fill before retry and prevents a duplicate hedge. |

The clearing prototype extends that boundary with per-account collateral, BTC/ETH base positions, average entry prices, realized and unrealized PnL, zero-sum funding indices, additive margin tiers, actual maker/insurance buckets, fee allocation, withdrawals, partial liquidation, deficit absorption and deterministic batched resolution. The Chainlink v3 adapter verifies through a configured VerifierProxy, restricts calls to clearing, pins feed IDs/decimals and normalizes bid/ask values to six decimals. The Pyth Core adapter requires exact fees, configured feed IDs, a block-relative fifteen-second window and conservatively uses confidence as bid/ask. Its server-side source authenticates to upgraded Hermes, uses SSE for indicative data, obtains a coalesced complete REST batch for firm settlement, and carries the exact signed bundle through approval without exposing credentials to clients or approvers.

## Historical evidence

The checked dataset was downloaded from Coinbase Exchange's public candle endpoint for BTC-USD and ETH-USD from 2025-09-01 through 2026-09-01 at one-hour granularity. Each file contains 8,751 candles and two recorded gaps.

| File | SHA-256 |
| --- | --- |
| BTC | `dfeae01442d4cce956b856bb6ef38a2da44c6ced616a3f010cde120a824849cd` |
| ETH | `60190a1e001b7921b5a87436238325a1dda524c370cdfc0042a4ef13febcb031` |

For a synthetic customer exposure of +$250,000 BTC plus +$250,000 ETH, the close-to-close replay produced:

| Metric | Result |
| --- | ---: |
| Paired return observations | 8,750 |
| Worst one-hour maker loss | $24,611.07 |
| p99 one-hour maker loss | $7,667.57 |
| Hours above $150,000 normal stress budget | 0 |
| Largest absolute BTC one-hour return | 481.35 bps |
| Largest absolute ETH one-hour return | 594.56 bps |

This is a risk replay, not evidence of expected profit. Hourly closes understate intrabar and quote-latency loss, the fixed book is deliberately synthetic, and spot prices omit Data Streams selection, Base inclusion, USDC conversion and hedge-venue basis/liquidity.

## Toolchain integrity

Direct development versions are exact-pinned in `package.json` and resolved in `package-lock.json`. The transitive `tmp` dependency is overridden to 0.2.7. `npm audit --omit=dev` reports zero runtime vulnerabilities. A full audit reports five low-severity advisories in the development-only OpenZeppelin upgrade validator's legacy crypto dependency chain and two moderate findings from Hardhat's `adm-zip` dependency. npm offers only an older Hardhat release as a nominal fix, so it is not applied. These tools are not linked into deployed bytecode and do not process untrusted archives in the project workflow. Generated artifacts are reproducible with `npm run compile:contracts`.

Ponder 0.17.10 was evaluated for the read model and then removed from the executable dependency set. Its 2026-09-08 production audit produced seven findings (five high, two moderate) through pinned Hono, Drizzle, Kysely and Vite dependencies. The executable local indexer therefore uses the platform SQLite API with no added runtime dependency. Adopting Ponder remains gated until upstream releases a clean compatible tree or tested overrides pass behavior and audit checks.

`RFQClearing` is 20,850 bytes with the Solidity IR optimizer and optimizer runs set to 1, 15.2% below the EVM's 24,576-byte runtime limit. The repository rejects builds above 21,000 bytes. Upgrade dispatch is isolated in OpenZeppelin's transparent proxy and governance-owned ProxyAdmin. Portfolio impact, trade assessment, stress, liquidation, position transition, PnL and funding calculations are in a separately deployed stateless `RFQRiskMath` library linked into the implementation. The current artifact is suitable for local validation, not a final deployment shape.

## Base Sepolia evidence

The complete protocol topology is deployed on Base Sepolia at clearing proxy `0x1114cA912b2c3440C7D6B5dcdaB499f897C86782`. The repeatable verifier proves chain ID, component bytecode, clearing/oracle/governance/emergency wiring, all three approvers, pinned Pyth BTC/USD and ETH/USD feeds, both 2-of-3 Safe owner sets, the 72-hour delay, self-administered timelock, ProxyAdmin ownership and initial epoch/version values. Native testnet USDC custody is live with 25.00016 USDC maker backing, 5.00004 USDC insurance and 9.9998 USDC trader collateral. Exact addresses are recorded in `BASE-SEPOLIA-DEPLOYMENT.md`.

Live authenticated Pyth checks cover both BTC/ETH oracle refreshes and complete RFQs. A full cross-system drill opened an 11.5 USDC customer ETH position in Base transaction `0xe3df31b1e95d754805ca11070a24f32d38d81d514974732458a1eb2ba5961094`, waited for two-confirmation indexing, filled the 0.0045 ETH offset on Hyperliquid testnet as venue order `59794691146`, then exactly closed the Base position in transaction `0x1a69d669cc3a2972481323fc9884b9ee74ee9b0eae152fe9e897d31d35e22144` and unwound it through venue order `59794704363`. Final customer and venue ETH base were both zero. This proves functional testnet wiring with disposable identities and negligible capital; it does not establish production tail latency, long-duration availability or production key custody.

On 2026-09-10, repeated combined lifecycle runs exposed intermittent `StalePrice()` reverts in Pyth's stateful update/readback path even when the submitted payload parsed to the configured ETH feed only two seconds behind the inclusion block. The system failed atomically and left both customer and venue exposure flat. A direct bounded-parse adapter was deployed at `0x414a98e864984697e3e81b8844e5810c6D5DB9b2` and scheduled through the existing Safe/timelock. The combined lifecycle gate must pass again after activation; the historical successful lifecycle above is not being used to conceal this newly observed release blocker.

## What is still unproven

The clearing contract is still a prototype. Pyth is now exercised with live authenticated BTC/ETH reports; Chainlink remains mock-tested. A probe and deployment confirmed Base Sepolia chain 84532, standard and pending-state RPC access, official six-decimal USDC bytecode and upgraded Pyth Core bytecode. The 72-hour timelock and independent testnet multisigs are deployed and verified, but the signed production operational runbook and hardware-backed key ceremony remain future work. Funding catch-up uses the current mark for each bounded seven-day chunk and needs a deliberate outage policy.

The Solidity suite is example-based with deterministic arithmetic and stateful samples, not exhaustive invariant fuzzing or formal verification. Liquidation races, adversarial ERC-1271 callbacks, rounding reserves, repeated funding catch-up, oracle-fee refunds, storage upgrades beyond the no-storage V2 example, and resolution recoveries after partial payouts need more tests. The code has received an internal review during implementation, not an independent audit.

The service integration now exercises SQLite signer logs, exact contract-shaped typed approvals, one unavailable approver, local-chain settlement and process restart. The three local approvers run in distinct OS processes. A live drill suspends one while the other two settle, then proves two suspended processes remove quorum safely. Each approver reads a pinned RPC snapshot, compares its hash with a configured secondary RPC, and independently checks live epochs, membership, pause state, market exposure, report chain-time validity and the contract impact floor. The sender serializes nonces, signs and journals raw transactions before broadcast, polls receipts directly instead of depending on provider block events, records canonical inclusion and classifies nonce replacements during startup reconciliation. Its automining fault drill proves a journaled 15% same-nonce fee replacement can replace the first attempt without duplicate execution. The indexer detects head-hash changes and rebuilds disposable included and finalized account/risk projections. Risk reads are constant-time, and position pages use indexed address cursors without RPC fanout. The hedge worker uses finalized exposure and stable client IDs, reconciles partial or ambiguous fills before retry, and prevents order stacking while any venue order is open.

`npm run smoke:failover` proves that an expected-epoch emergency-council transition immediately rejects a prepared old-epoch intent and that the same running stack reads the new epoch, obtains fresh approvals and settles without a cooldown. It also led to replacing cached critical head reads and deriving intent deadlines from the pinned chain timestamp rather than API wall time.

Genuinely independent provisioned RPC providers, Base-specific reorg injection and production Hyperliquid credential fencing remain open. Approvers independently verify signed Pyth payloads without possessing the retrieval key, but the current test used shared public infrastructure. Sustained Flashblocks-to-sealed reconciliation, extended oracle and venue outages, externally enforced sponsor-refill budgets and high-frequency venue basis/depth replay also remain open.

No test is independent review. Before real capital, the remaining sequence is:

1. Continue splitting resolution/risk into reviewable production modules and expand the new deterministic stateful Solidity run into invariant fuzzing and differential Python/Solidity traces.
2. Continue systematic process and network fault injection across the connected API, isolated approvers, sender journal, indexer and venue adapter, including long outages and restore drills.
3. Repeat the authenticated Pyth/Base/Hyperliquid lifecycle under sustained load; measure p50/p95/p99 quote, approval, inclusion, indexing and hedge latency and perform Base reorg/RPC/oracle/venue/gas/restore drills.
4. Freeze a review commit and commission independent economic, smart-contract and infrastructure/key-management reviews. Remediate findings and repeat the relevant gates.
5. Start a capped canary only after every launch gate in `CURRENT-ARCHITECTURE.md` has recorded evidence and an accountable owner.

The deployable npm dependency subset reports zero known vulnerabilities. The development toolchain reports five low and two moderate advisories inherited through OpenZeppelin upgrade validation and Hardhat; one has no upstream fix and the suggested automatic fix changes the pinned Hardhat version. These tools are excluded from the shipped browser and service dependency set, and their remaining advisories stay visible rather than being hidden by a forced downgrade.
