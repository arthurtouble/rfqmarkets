# RFQ Markets validation report

Status date: 2026-09-08. This separates executable evidence from architectural intent. The repository now contains a local clearing prototype. It has not been independently audited or deployed.

## What now runs

`npm test` performs three local gates:

1. Compiles the contracts with Solidity 0.8.34 and executes two suites on Hardhat's OP Stack-compatible local EVM. The authorization suite verifies two distinct approvers, the user price bound, sender-independent sponsorship, nonce consumption, stale inventory-impact rejection and leader-epoch fencing, plus 400 deterministic arithmetic invariant calls. The clearing suite verifies proxy initialization, USDC custody, EIP-3009 deposit routing, oracle-bound trade settlement, positive-uPnL withdrawal restrictions, partial liquidation, insurance allocation, exact internal/token conservation, an upgrade with an open position, and a real pro-rata insolvency haircut.
2. Runs OpenZeppelin's upgrade-safety validator against the compiler build information and `RFQClearing`; it passes.
3. Runs 28 Python tests over floating-point research economics, integer contract-shaped arithmetic, lifecycle faults, accounting and historical data parsing.

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

`RFQClearing` is 23,963 bytes with optimizer runs set to 1, below both the repository's 24,000-byte gate and the EVM's 24,576-byte runtime limit. This is too close for further production development. Resolution or view logic should move behind a narrow module boundary before adding features; the current artifact is suitable for local validation, not a final deployment shape.

## What is still unproven

The clearing contract is still a prototype. The Chainlink adapter is tested against a mock verifier rather than Base's live VerifierProxy and actual BTC/ETH reports. Feed IDs, decimals, subscription billing, Base addresses and USDC proxy behavior remain deployment inputs. The governance and emergency roles are address boundaries, but the actual 72-hour timelock and independent multisigs are not deployed. Session certificates, relayed signed withdrawals, nonce cancellation, maker withdrawals, fallback exit feeds and upgrade rollback procedures remain unimplemented. Funding catch-up uses the current mark for each bounded seven-day chunk and needs a deliberate outage policy.

The Solidity suite is example-based with a deterministic arithmetic sample, not exhaustive invariant fuzzing or formal verification. Liquidation races, multiple accounts across both markets, rounding reserves, repeated funding catch-up, oracle-fee refunds, malicious ERC-1271 wallets, storage upgrades beyond the no-storage V2 example, and resolution recoveries after partial payouts need more tests. The code has received an internal review during implementation, not an independent audit.

The service drill is a deterministic model, not multiple killed processes on independent hosts. It does not yet exercise real durable signer logs, RPC disagreement, Base reorgs, Flashblocks-to-sealed reconciliation, transaction replacement, data-stream access failures, venue credential revocation, Ponder rebuild, or backup restore time. Historical replay needs high-frequency shock windows and venue basis/depth data before parameter calibration.

No test is independent review. Before real capital, the remaining sequence is:

1. Split the nearly full-size prototype into reviewable production modules; implement the remaining withdrawal/session/fallback paths and add differential Python/Solidity stateful fuzzing.
2. Connect a locally running API, three separately keyed approvers, journals, hedge adapter and keepers; run process/network fault injection.
3. Deploy to Base Sepolia with synthetic collateral; measure p50/p95/p99 quote, approval and inclusion latency and perform reorg/RPC/oracle/gas/restore drills.
4. Freeze a review commit and commission independent economic, smart-contract and infrastructure/key-management reviews. Remediate findings and repeat the relevant gates.
5. Start a capped canary only after every launch gate in `CURRENT-ARCHITECTURE.md` has recorded evidence and an accountable owner.
