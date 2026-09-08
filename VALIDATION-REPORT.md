# RFQ Markets validation report

Status date: 2026-09-09. This separates executable evidence from architectural intent. The repository now contains a local clearing prototype. It has not been independently audited or deployed.

## What now runs

`npm test` performs local contract, model, service and frontend gates:

1. Compiles the contracts with Solidity 0.8.34 and executes two suites on Hardhat's OP Stack-compatible local EVM. The authorization suite verifies two distinct approvers, the user price bound, sender-independent sponsorship, nonce consumption, stale inventory-impact rejection and leader-epoch fencing, plus 400 deterministic arithmetic invariant calls. The clearing suite verifies proxy initialization, USDC custody, EIP-3009 deposit routing, oracle-bound settlement, limited session activation/use/revocation, session-withdrawal rejection, positive-uPnL withdrawal restrictions, partial liquidation, insurance allocation, exact internal/token conservation, an upgrade with an open position, and a real pro-rata insolvency haircut.
2. Runs OpenZeppelin's upgrade-safety validator against the compiler build information and `RFQClearing`; it passes with the explicit linked-library allowance. `RFQRiskMath` has no storage, external calls, delegation, self-destruction or mutable behavior; deployment links and records its exact address before the implementation is deployed.
3. Runs 28 Python tests over floating-point research economics, integer contract-shaped arithmetic, lifecycle faults, accounting and historical data parsing.
4. Runs twelve HTTP/service integration tests across the API, three independently keyed approvers and hedge worker. They verify exact EIP-712 trade, deposit, withdrawal, cancellation, close and maker signatures, pinned domain separation, cryptographic response identity, two-of-three availability, durable-before-response signing, rejection of unauthorized capacity reservations, single-account/nonce quote binding with idempotent retries, worse second same-direction pricing, restart recovery and idempotent hedge client IDs. Differential samples prove the linear four-corner pending envelope is at least as conservative as exhaustive subset evaluation, and a 10,000-reservation case demonstrates bounded work.
5. Type-checks the TypeScript workspace and builds both React production bundles. Browser passes verified BTC/ETH and Buy/Sell state, live quote refresh, restart recovery, wallet detection and persistent completion feedback. The public Markets view was also checked against the live indexer for finalized aggregate exposure, open positions and execution history. The first pass found and fixed a stale-display expiry path.

`npm run smoke:local` exercises the separately running processes over loopback with a fresh EOA. It signs a source-bound `DepositIntent`, settles simulated destination USDC into clearing, performs sponsored withdrawal and cancellation, activates a limited session, executes a popup-free session-signed trade with two independently chain-checked `MakerApproval` signatures, verifies account/public finalized projections, and triggers hedge reconciliation.

`npm run smoke:reorg` forces a local chain fork after the indexer records a deposit, replaces the branch with empty canonical blocks, and verifies that the orphaned account and activity disappear while earlier canonical records survive. The first drill exposed a sync/reorg race; the indexer now verifies its stored tip again after every pass and rebuilds immediately if the chain changed during that pass.

The 2026-09-09 live sequence ran `smoke:local`, `smoke:failover`, `smoke:local` again and `smoke:reorg` against one fresh deployment. Trades settled both before and after the epoch transition, the old prepared intent was fenced, and the canonical read model survived branch replacement. A later idle-stack rerun found that Hardhat's stopped block clock could jump past a chain-derived intent deadline and leave the nontraded market's portfolio mark stale. The local quote path now advances the simulated clock before pinning its block and catches up an exposed nontraded mark through the serialized sender. Approvers admit observations no more than eight seconds old when signing; clearing allows up to fifteen seconds so the already-approved transaction has bounded inclusion time without silently widening quote validity.

`python3 -B simulator/fault_harness.py` passes five deterministic drills:

| Fault | Observed safe behavior |
| --- | --- |
| One signer offline | The other two form quorum. |
| One approver key compromised | Reusing one signature does not count twice. |
| API dies after two signer logs | Promotion increments the epoch and invalidates the possibly escaped approval. |
| Sponsor wallet is empty | Authorization is sender-independent, so a user or backup sender can submit the same payload. |
| Hedge acknowledgement is lost | Query by unique client order ID discovers the fill before retry and prevents a duplicate hedge. |

The clearing prototype extends that boundary with per-account collateral, BTC/ETH base positions, average entry prices, realized and unrealized PnL, zero-sum funding indices, additive margin tiers, actual maker/insurance buckets, fee allocation, withdrawals, partial liquidation, deficit absorption and deterministic batched resolution. The Chainlink v3 adapter verifies through a configured VerifierProxy, restricts calls to clearing, pins feed IDs/decimals and normalizes bid/ask values to six decimals.

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

Direct development versions are exact-pinned in `package.json` and resolved in `package-lock.json`. The transitive `tmp` dependency is overridden to 0.2.7. `npm audit --omit=dev` reports zero runtime vulnerabilities. A full audit reports five low-severity advisories in the development-only OpenZeppelin upgrade validator's legacy crypto dependency chain; npm reports no upstream fix. That CLI is not linked into deployed bytecode. Generated artifacts are reproducible with `npm run compile:contracts`.

Ponder 0.17.10 was evaluated for the read model and then removed from the executable dependency set. Its 2026-09-08 production audit produced seven findings (five high, two moderate) through pinned Hono, Drizzle, Kysely and Vite dependencies. The executable local indexer therefore uses the platform SQLite API with no added runtime dependency. Adopting Ponder remains gated until upstream releases a clean compatible tree or tested overrides pass behavior and audit checks.

`RFQClearing` is 23,939 bytes with the Solidity IR optimizer and optimizer runs set to 1, below both the repository's 24,000-byte gate and the EVM's 24,576-byte runtime limit. Portfolio impact, stress and liquidation calculations are in a separately deployed stateless `RFQRiskMath` library linked into the implementation. The build includes scoped sessions, owner actions and expected-epoch failover, but remains larger than the desired production review unit and has only 61 bytes of project-gate headroom. The current artifact is suitable for local validation, not a final deployment shape.

## What is still unproven

The clearing contract is still a prototype. The Chainlink adapter is tested against a mock verifier rather than Base's live VerifierProxy and actual BTC/ETH reports. Feed IDs, decimals, subscription billing, Base addresses and USDC proxy behavior remain deployment inputs. The governance and emergency roles are address boundaries, but the actual 72-hour timelock and independent multisigs are not deployed. An independent prolonged-outage exit feed and upgrade rollback procedures remain unimplemented. Funding catch-up uses the current mark for each bounded seven-day chunk and needs a deliberate outage policy.

The Solidity suite is example-based with a deterministic arithmetic sample, not exhaustive invariant fuzzing or formal verification. Liquidation races, multiple accounts across both markets, rounding reserves, repeated funding catch-up, oracle-fee refunds, malicious ERC-1271 wallets, storage upgrades beyond the no-storage V2 example, and resolution recoveries after partial payouts need more tests. The code has received an internal review during implementation, not an independent audit.

The service integration now exercises SQLite signer logs, exact contract-shaped typed approvals, one unavailable approver, local-chain settlement and process restart. Each local approver reads a pinned RPC snapshot and independently checks live epochs, membership, pause state, market exposure, report chain-time validity and the contract impact floor. The sender serializes nonces, signs and journals raw transactions before broadcast, rebroadcasts identical hashes, polls receipts directly instead of depending on provider block events, records canonical inclusion and classifies nonce replacements during startup reconciliation. The indexer detects head-hash changes and rebuilds disposable projections; the hedge worker uses finalized exposure and stable client IDs across restart.

`npm run smoke:failover` proves that an expected-epoch emergency-council transition immediately rejects a prepared old-epoch intent and that the same running stack reads the new epoch, obtains fresh approvals and settles without a cooldown. It also led to replacing cached critical head reads and deriving intent deadlines from the pinned chain timestamp rather than API wall time.

Automatic fee-bumped sender replacement, independent oracle acquisition per signer, RPC-divergence quorum, Base-specific reorg injection, separately killed signer processes and real Hyperliquid credential fencing remain open. Flashblocks-to-sealed reconciliation, Data Streams access failures, venue API behavior and high-frequency venue basis/depth replay also remain open.

No test is independent review. Before real capital, the remaining sequence is:

1. Continue splitting resolution/risk into reviewable production modules and add differential Python/Solidity stateful fuzzing.
2. Extend the now-connected local API, three approvers, sender journal, indexer and mock hedge adapter with keepers and systematic process/network fault injection.
3. Deploy to Base Sepolia with synthetic collateral; measure p50/p95/p99 quote, approval and inclusion latency and perform reorg/RPC/oracle/gas/restore drills.
4. Freeze a review commit and commission independent economic, smart-contract and infrastructure/key-management reviews. Remediate findings and repeat the relevant gates.
5. Start a capped canary only after every launch gate in `CURRENT-ARCHITECTURE.md` has recorded evidence and an accountable owner.
