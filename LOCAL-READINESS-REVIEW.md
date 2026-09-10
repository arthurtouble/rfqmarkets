# Local system readiness and simplification review

Status date: 2026-09-10. The system is locally integrated and its principal external testnet lifecycle has executed successfully. It is suitable for product iteration, economic simulation and fault testing. It is not ready for real funds or a claim of production security.

## What is real locally

- An OpenZeppelin transparent clearing proxy holds mock USDC and enforces EOA, ERC-1271 contract-wallet or scoped-session signatures, two distinct current approvers, price limits, replay protection, margin, maker backing, exposure limits, funding, liquidation and insolvency accounting. A dedicated `ProxyAdmin` owned by governance handles upgrades outside the implementation. Clearing also supports signed sponsored withdrawals, nonce cancellation, paused-market conservative closes and capital-floor-limited maker withdrawals.
- One API process quotes from a shared portfolio state, verifies user signatures, requests all three approvers concurrently, accepts two matching approvals and sponsors the settlement transaction.
- A separate secret-free SSE gateway maintains one upstream connection, fans complete frames out to browsers, replays the latest snapshot on reconnect and evicts slow readers. The core fanout test covers 100,000 clients without multiplying API quote work.
- The sponsor signs and journals raw transactions before broadcasting. Restarts reconcile inclusion and avoid allocating the same nonce concurrently.
- Each approver has a distinct key and durable log. Each independently checks the chain, exact intent, signer set, policy version, oracle observation and inventory-impact floor before signing.
- The disposable indexer follows canonical block hashes, revalidates the tip after each sync pass, and provides account state, finalized aggregate risk, pseudonymous open positions and event history. A forced-fork drill proves orphaned state is removed. The client has separate Trade and Markets views; the private dashboard shows hedge state.
- The hedge worker reads finalized exposure, applies an explicit no-trade band and records a stable client order identifier before using its local simulator or Hyperliquid testnet. It reconciles partial and ambiguous fills, and an open order prevents another slice in that market. Restarting does not create a duplicate order. Its authenticated health snapshot gates both API quoting and each approver: excessive gap halves size, while outage, stale state or severe gap permits only strict exposure reduction. Venue minimum size is included in the effective threshold, and a bounded recent finalized snapshot absorbs transient indexer jitter without masking venue failures.

The public positions page does not create a new ledger. It reads the same rebuildable chain projection as account history. Addresses and positions are public and pseudonymous; the application should avoid adding identity, IP or session linkage to that data.

## Boundaries to keep

The current five logical deployable roles are the minimum defensible set:

| Role | Why it remains separate |
| --- | --- |
| Frontend | Static, untrusted presentation and wallet interaction. |
| API/quoter/sponsor | One active operational writer and latency-sensitive request path. It holds only bounded gas authority. |
| Three approvers | Independent compromise and availability domains with one key each. Combining them removes the purpose of the threshold. |
| Chain indexer | Disposable public read model. Its failure must not affect settlement truth. |
| Hedge worker | Holds separate venue trading authority and operational order state; compromise must not reach customer collateral or approver keys. |

There is no need for a coordinator, separate quoter, public relayer, second customer database or separate analytics backend. The API already performs coordination, quoting and sponsored submission. SQLite journals record only pending operational commitments and hedge orders. The chain remains the sole customer ledger.

Code modules can be separated without creating more servers. The frontend is split into trade, public markets, shared types and formatting, and the API, approvers and indexer consume one shared clearing ABI definition. The current API is a bounded 390-line composition root and the indexer is 65 lines around a separate projection module; further splitting should follow actual change pressure so indirection does not grow faster than the audit surface it removes.

## What is still simulated or gated

| Area | Current local substitute | Production gate |
| --- | --- | --- |
| Settlement chain | Hardhat OP-compatible node plus deployed Base Sepolia topology | Sustained Base Sepolia soak, then Base mainnet configuration and reorg/RPC drills. |
| Collateral | Mock local USDC plus native Base Sepolia USDC | Broader injected/mobile/smart-wallet compatibility and withdrawal drills. |
| Oracle | Coinbase WebSocket locally; authenticated Pyth Hermes SSE/REST with signed on-chain updates on Base Sepolia; Chainlink adapter tests | Measure sustained Pyth availability and tail latency, provision independent reference inputs, and preserve fail-closed behavior. |
| Wallet UX | Injected EIP-1193, limited local session mode, and pinned-block ERC-1271 verification | Provider-neutral wallet kit, mobile wallet tests and hardened session-secret storage. |
| Cross-chain deposit | Signed local route simulator | LI.FI or Socket quote/execution adapter, allowance safety, destination verification, refunds and failure recovery. |
| Hedging | Deterministic simulator plus real Hyperliquid testnet order/fill reconciliation | Credential fencing and rotation, WebSocket fill monitoring, rate-limit/venue-outage soak and warm-standby drill. |
| Governance | Deployed 2-of-3 Safes and 72-hour self-administered timelock on Base Sepolia | Selector review, delayed upgrade and emergency recovery drills. |
| Availability | Expected-epoch council transition and live fencing drill | Production 2-of-3 council/Safe, warm-standby reconciliation, independent RPCs and process/network fault injection. |
| Contract shape | 20,850-byte IR build behind a transparent proxy, with a 21,000-byte project gate and linked stateless risk/trade math | Verify the implementation, library and ProxyAdmin; repeat storage/upgrade validation for every release. |
| Assurance | Internal deterministic tests, including 120 stateful cross-market trades | Broader invariant fuzzing, economic stress calibration and independent contract/infrastructure audits. |

## Readiness verdict

The local product is end-to-end enough to validate the interaction model: a user can deposit, receive a shared live pricing frame, view an exact locally computed indication, request one firm quote on click, sign once, receive a sponsored two-of-three-approved fill, see the resulting public state and drive the hedge loop. Restart-safe sender, signer, index and hedge journals exercise the important persistence boundaries. Resting orders are indexed by trigger price and expiry, so a large dormant book no longer causes a full scan on every oracle update.

“Bulletproof” is not yet a supportable description. The external integrations and adversarial failure modes above materially change security and latency. Real capital must wait for evidence from the testnet, fault-injection and independent-review gates.

## Next implementation sequence

1. Run repeated and sustained Base Sepolia/Pyth/Hyperliquid lifecycle soaks, recording quote, approval, inclusion, indexing and hedge tail latency.
2. Provision independently operated paid RPC paths and test disagreement, throttling, process death, replacement and recovery against them.
3. Fence and rotate the Hyperliquid agent, add event-driven fill monitoring with reconciliation fallback, and prove warm-standby single-writer promotion.
4. Validate injected, mobile and smart-contract wallets, then exercise bridge/deposit failure and refund paths with the selected routing provider.
5. Expand contract invariants, differential economic tests and high-frequency basis/depth replay; freeze launch parameters from measured results.
6. Commission independent contract, economic and infrastructure/key-management audits, remediate findings, and rerun every affected gate before a capped canary.
