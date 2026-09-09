# Local system readiness and simplification review

Status date: 2026-09-09. The system is locally integrated for its principal happy path. It is suitable for product iteration, economic simulation and fault testing. It is not ready for real funds or a public testnet claim of production security.

## What is real locally

- A UUPS clearing proxy holds mock USDC and enforces EOA, ERC-1271 contract-wallet or scoped-session signatures, two distinct current approvers, price limits, replay protection, margin, maker backing, exposure limits, funding, liquidation and insolvency accounting. It also supports signed sponsored withdrawals, nonce cancellation, paused-market conservative closes and capital-floor-limited maker withdrawals.
- One API process quotes from a shared portfolio state, verifies user signatures, requests all three approvers concurrently, accepts two matching approvals and sponsors the settlement transaction.
- The sponsor signs and journals raw transactions before broadcasting. Restarts reconcile inclusion and avoid allocating the same nonce concurrently.
- Each approver has a distinct key and durable log. Each independently checks the chain, exact intent, signer set, policy version, oracle observation and inventory-impact floor before signing.
- The disposable indexer follows canonical block hashes, revalidates the tip after each sync pass, and provides account state, finalized aggregate risk, pseudonymous open positions and event history. A forced-fork drill proves orphaned state is removed. The client has separate Trade and Markets views; the private dashboard shows hedge state.
- The hedge worker reads finalized exposure, applies an explicit no-trade band and records a stable client order identifier before using its local venue simulator. It reconciles partial and ambiguous fills, and an open order prevents another slice in that market. Restarting does not create a duplicate order. Its authenticated health snapshot now gates both API quoting and each approver: excessive gap halves size, while outage, stale state or severe gap permits only strict exposure reduction.

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

Code modules can be separated without creating more servers. The frontend is split into trade, public markets, shared types and formatting, and the API, approvers and indexer now consume one shared clearing ABI definition. The next maintainability pass should split the API and indexer files by route/domain. This preserves one process per role while reducing audit surface and drift.

## What is still simulated or gated

| Area | Current local substitute | Production gate |
| --- | --- | --- |
| Settlement chain | Hardhat OP-compatible node | Base Sepolia soak, then Base mainnet configuration and reorg/RPC drills. |
| Collateral | Mock USDC and local EIP-3009 | Native Base USDC behavior and wallet compatibility tests. |
| Oracle | Mock verifier locally; official SDK acquisition and v3 decoding boundary implemented | Paid Data Streams account, subscribed feed IDs, independent credential paths and Base verifier integration. |
| Wallet UX | Injected EIP-1193, limited local session mode, and pinned-block ERC-1271 verification | Provider-neutral wallet kit, mobile wallet tests and hardened session-secret storage. |
| Cross-chain deposit | Signed local route simulator | LI.FI or Socket quote/execution adapter, allowance safety, destination verification, refunds and failure recovery. |
| Hedging | Deterministic local venue adapter | Hyperliquid testnet agent wallet/subaccount, real order/fill reconciliation, rate limits and fenced failover. |
| Governance | Contract roles | Deployed multisigs, 72-hour timelock, selector review and recovery drill. |
| Availability | Expected-epoch council transition and live fencing drill | Production 2-of-3 council/Safe, warm-standby reconciliation, independent RPCs and process/network fault injection. |
| Contract shape | 23,939-byte IR build plus linked stateless risk library | Further production module split, linked-library verification and repeated storage/upgrade validation. |
| Assurance | Internal deterministic tests, including 120 stateful cross-market trades | Broader invariant fuzzing, economic stress calibration and independent contract/infrastructure audits. |

## Readiness verdict

The local product is end-to-end enough to validate the interaction model: a user can deposit, receive a shared live pricing frame, view an exact locally computed indication, request one firm quote on click, sign once, receive a sponsored two-of-three-approved fill, see the resulting public state and drive the hedge loop. Restart-safe sender, signer, index and hedge journals exercise the important persistence boundaries. Resting orders are indexed by trigger price and expiry, so a large dormant book no longer causes a full scan on every oracle update.

“Bulletproof” is not yet a supportable description. The external integrations and adversarial failure modes above materially change security and latency. Real capital must wait for evidence from the testnet, fault-injection and independent-review gates.

## Next implementation sequence

1. Continue the module split beyond the linked risk library; split API/indexer internals without adding deployable services.
2. Expand the deterministic stateful contract suite and extend local fault drills with RPC disagreement, process kills during settlement, sponsor recovery and leader promotion.
3. Obtain Chainlink Data Streams development credentials and wire real reports through the existing adapter on Base Sepolia. Measure report acquisition and approval latency.
4. Replace mock collateral and deposit routing on Base Sepolia, then validate injected, mobile and smart-contract wallets.
5. Add a Hyperliquid testnet adapter using a dedicated revocable agent wallet and separately funded subaccount or vault. Keep its state and controls on the private operations surface.
6. Run sustained load, quote-quality, hedge-basis and outage drills; freeze parameters; commission independent audits before any capped deployment.
