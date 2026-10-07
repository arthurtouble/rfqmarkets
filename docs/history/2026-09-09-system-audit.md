# Whole-system audit — 2026-09-09

## Verdict

The local system is a credible end-to-end prototype and a strong testnet candidate. Its trust boundaries are simpler than the earlier drafts: the chain is the customer ledger; one active API prices, coordinates approvals and spends only gas; three isolated approvers each hold a different key; a rebuildable indexer serves public history; and a separately funded hedge worker holds venue-only authority. The browser receives shared market frames and requests one firm quote only after the user clicks.

It is not ready for real capital. External oracle, RPC, Base, native USDC, wallet, bridge and hedge-venue behavior remain substitutes. Governance is represented by local accounts rather than deployed Safes and a timelock. Independent contract and infrastructure audits have not occurred.

## What should remain

- Contract authority is the final boundary. It verifies user or scoped-session authority, two current distinct maker signers, exact oracle-report binding, deadlines, replay state, current exposure impact, margin, maker backing and market limits.
- The API gas key has no custody, governance, approver or hedge authority. A compromised API can censor, waste its bounded gas, request bad quotes that honest approvers reject, and degrade availability; it cannot unilaterally move customer funds or settle an arbitrary trade.
- Approvers are three trust identities, not three copies of one key. Two failures may stop new RFQs, while one compromise cannot authorize one. Owner-authorized withdrawal, cancellation and paused-market close paths remain available directly on-chain.
- The hedge worker remains separate because its venue credential can lose hedge capital. Hedge health may tighten or reduce-only admission but must never grant contract authority.
- Market watching is shared SSE fanout. Typing changes a quote locally with the same fixed-point pricing package and consumes no server quote capacity.
- Operational journals contain only facts that cannot be reconstructed safely from chain state: escaped signed commitments, transaction nonces and external hedge orders. They are not balance ledgers.

## Hardening completed in this review

- Firm-quote expiration now uses a bounded expiry heap instead of scanning as many as 50,000 quote records on each request.
- Pending same-direction and opposite-direction exposure is maintained incrementally. Quote construction receives at most four conservative totals across the two markets rather than traversing every wallet reservation.
- Unsigned prepared limit orders use a bounded expiry index. The trigger book already uses price and expiry heaps.
- A signed reservation is persisted before it is exposed to the live in-memory pricing envelope, reducing restart ambiguity.
- The client detects a broken stream or an oracle observation older than 2.5 seconds, removes the actionable indication and disables submission while reconnecting.
- Clearing initialization rejects identical governance/emergency roles and a zero maker-capital floor. Empty-position liquidation, zero-value reserve funding and overfunded insolvency recovery now revert. Resolution deletes complete position records.
- The production npm dependency audit reports no known vulnerabilities as of this review.
- Public risk totals are now incrementally materialized for included and finalized state. Open positions use partial indexes and address-cursor pagination instead of per-request account scans or RPC fanout.
- Concurrent copies of one valid signed intent share one three-approver request. The durable sender's operation ID and one-time pending removal preserve idempotent settlement accounting.

## Remaining risks and ordered work

### Before Base Sepolia

1. Split the API and indexer source files by domain while keeping the same processes. This is an auditability change, not a service-topology change.
2. Add process-kill tests at reservation write, approval quorum, signed transaction persistence, broadcast, inclusion and response boundaries. Run RPC disagreement and longer reorg drills.
3. Run sustained real-socket gateway tests at the host file-descriptor ceiling, plus firm-request load through approvals and transaction inclusion. The deterministic 100,000-client fanout test proves algorithmic behavior, not host capacity.

### Before any public testnet claim

1. Use independent authenticated RPC paths for the API and each approver. Verify chain ID, clearing address, implementation hash, ProxyAdmin owner and oracle adapter at startup.
2. Use actual Chainlink Data Streams reports or the selected Pyth path and test delayed, future, duplicated, malformed and conflicting observations. Coinbase BBO remains a local development source only.
3. Test native Base USDC authorization semantics, injected and mobile wallets, ERC-1271 wallets and direct exit transactions.
4. Connect a dedicated revocable Hyperliquid testnet agent wallet. Reconcile partial fills, unknown outcomes, open orders, rate limits, disconnects and credential fencing before failover.
5. Deploy a governance Safe, separate emergency Safe and timelock; transfer ProxyAdmin ownership; verify every delayed and emergency selector.

### Before real funds

1. Calibrate spread, impact, margin, funding, liquidation and hedge bands against high-frequency data, venue depth/basis, toxic flow and correlated liquidation cascades. The current parameters are hypotheses.
2. Commission independent Solidity, economic and infrastructure reviews. Resolve all high-severity findings and rerun storage-layout and state-migration tests on the final bytecode.
3. Perform an operational rehearsal covering signer loss, one signer compromise, API compromise, oracle outage, RPC split, Base congestion, hedge-venue outage, stablecoin controls, emergency pause, user exits and insolvency resolution.

## Simplicity boundary

Do not add a coordinator, separate relayer, second quoting service, customer SQL ledger, validator network or cross-chain accounting system. Add replicas within an existing role when measurements require them. Add a new trust-bearing service only when its authority and failure isolation cannot live safely in an existing role.

The clearing implementation is 20,850 bytes behind an OpenZeppelin transparent proxy, with a project gate at 21,000 bytes and the EVM limit at 24,576 bytes. Keep the gate. Further economic features belong in independently reviewed linked libraries or a deliberately redesigned implementation; they should not consume the remaining deployment margin opportunistically.
