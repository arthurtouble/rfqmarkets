# Production implementation plan

This is the plan from today's system to a capped production release on Base mainnet. It lists what is done and what is open, in priority order. The [release checklist](release-checklist.md) holds the evidence each gate needs, and the [security review](security-review.md) holds the October 2026 findings. Where this page and the checklist disagree on whether something is finished, the checklist wins.

Status words: **done** (in the code and tested), **locally verified** (passes on a local chain, not yet proven against real infrastructure), **open**.

## Where things stand

The full stack runs and is tested on a local chain. A development deployment runs on Base mainnet: owner-controlled, no timelock, capped at 25 USDC per trade and 100 USDC net per market, with every service on Cloudflare and the hedger simulated ([architecture overview](../architecture/overview.md)). No independent audit has been done, and no production approver keys, hosts or hedge account exist. The system is not ready for customer funds.

## Decisions that still hold

- One clearing proxy with linked libraries and one ERC-7201 storage namespace. The only size gate is EIP-170's 24,576-byte runtime limit, enforced by `scripts/compile-contracts.mjs`. RFQClearing is 22,569 bytes (2,007 bytes of headroom, measured 15 October 2026). Every library is under 9,500 bytes.
- Production financial services run on Linux hosts with persistent volumes ([deploy/host/README.md](../../deploy/host/README.md)). Cloudflare Containers are acceptable only for the dev profile, because their disk cannot be the only copy of a journal.
- Production approvers are provisioned independently: separate hosts, providers and operators, with keys generated on each host. The dev setup, where one Durable Object holds all three keys, is never production key custody.
- Prices come from our own three signed oracle nodes and the `SignedPriceOracle` adapter. There is no unsigned fallback price.
- No trading fees. The platform earns a 2 bps markup inside the quoted price. Fee tiers were removed.
- Deposits are native Base USDC. A bridge route never creates collateral. Cross-chain deposits into the contract stay disabled for the capped launch.
- Mainnet tooling fails closed. Every broadcasting `npm run mainnet -- <command>` needs a confirmation string bound to the chain, the deployer and the candidate. Production deploys also need release evidence.

## Done

Contracts and protocol:

- v1 clearing contract with isolated margin, session keys, sponsored owner actions (EIP-712 and ERC-1271), partial liquidation, the default waterfall, maker incident grace period, resolution and pro-rata claims. Foundry and local-chain e2e suites cover them, including stateful custody invariants.
- Exposure controls: gross, per-side and net caps, the capital floor and stress checks in the contract. Reductions stay possible under tightened caps and on disabled markets.
- On-chain market registry and a risk operator who tunes markets within an envelope governance sets.
- Own oracle: three signing nodes, a 2-of-3 median adapter with disagreement and jump guards, and 30 days of signed batch history. This replaced Pyth and Chainlink in October 2026.
- Two-step governance handover to a timelock (`dev-handover`), rehearsed on a local chain that reports Base's chain ID ([Base mainnet deployment](../operations/base-mainnet.md#rehearsal)).

Services:

- Indexer with atomic checkpoints, rebuild on a canonical-hash mismatch and recovery from short reorgs.
- Admission: remote reads happen before the reservation lock, quorum completes on the first two approvers, and duplicate submissions reuse one operation.
- Reservations in the API and in each approver for gross, side, net, stress and maker-capital exposure. They survive restarts and are released only once finalized chain time passes the deadline.
- Durable sponsor journal: reverted, ambiguous and reorged transactions are recovered without double submission.
- Independent keeper with its own key, journal and budgets. Locally verified with the API stopped.
- Hedge loop with reconciliation by client order ID, and reduce-only fallback when the hedge state is bad.
- Edge: exact route allowlists, per-client and global rate limits, jurisdiction blocking and Cloudflare Access on private pages.

Security review fixes (October 2026):

- Deploy workflows run only on a push to this repository's `main`, and checkouts drop persisted credentials.
- Oracle nodes pin each market index to its symbol, require HTTPS RPC and drop stale or crossed quotes.
- The trading app checks every payload before signing and pins the chain, clearing contract and USDC token in deployed builds.
- The API checks margin before reserving, releases refused reservations, requires collateral for sponsored actions and caps live orders per account.

Release tooling:

- Candidate hashes, release evidence checks, supply-chain inventory, a pinned host image and the release-image workflow with SBOM, scanning and signing.
- Alert rules and the [incident runbook](../../deploy/operations/INCIDENT-RUNBOOK.md).

Deployment:

- The dev profile on Base mainnet and the Cloudflare dev environment, redeployed on every green CI run on `main` ([Cloudflare hosting](../operations/cloudflare.md)).

## Open, in priority order

1. **Rotate keys exposed by the old deploy workflows.** Unless the previous repository's Actions history shows no deploy run triggered from a fork, rotate the Cloudflare API token, the dev runtime's approver, sponsor and emergency keys, the oracle signer keys, and the RPC credentials. The order is in the [security review](security-review.md#rotate-keys-exposed-by-the-deploy-workflow-hole).
2. **Lock down the repository and wallet settings.** Put the dev deploy behind a protected GitHub environment, require approval for workflow runs from outside contributors, and restrict the WalletConnect project to our domains.
3. **Decide and ship the contract fixes that need an upgrade.** From the security review: the report submitter can pick which signed batches form a report (medium); resolution samples have no schedule; a third party can start resolution before signatures are checked; `CloseIntent` has no price bound; one stale market halts every trade; `withdrawMakerExcess` undercounts what the maker owes. Each needs a decision, a contract change and a dev upgrade or fresh dev deploy.
4. **Enable the mainnet hedge path.** The hedger and its bridge accept only the Hyperliquid testnet, so the hedger fails closed on Base mainnet and quotes return 503. This blocks any launch with live hedging. It needs a dedicated, capped and fenced Hyperliquid account.
5. **Finish the open protocol work.** Byzantine coordination of reservations between approvers is not built. Today the contract's own caps are the backstop when a compromised approver signs conflicting approvals, and reviewers must accept that boundary explicitly. Caps, margin tiers, spreads and liquidation parameters still need calibration from replay and live market data.
6. **Provision production infrastructure.** Three approvers on separate providers with hardware-backed keys and private transport only. One active API writer with warm standbys and separate gas wallets. The keeper on its own host with its own sponsor key. Persistent hosts for the indexer and hedger. Independent RPCs, with each oracle node on a different RPC provider. Alert delivery to an independent paging route. The direct exit page hosted independently.
7. **Qualify recovery.** Restore every journal from encrypted off-host backups on a clean host, fence an old writer across hosts, and rehearse API promotion and hedge credential fencing without double submission.
8. **Qualify wallets.** Desktop extensions, WalletConnect and mobile, Base Account and other ERC-1271 wallets, and session limits, revocation, expiry and loss of the browser key.
9. **Get independent reviews.** Solidity, the linked-library boundary (storage validation still runs with the linked-library allowance) and the economic model. Close every critical and high issue.
10. **Run the soak and fault drills on a frozen candidate.** A soak on the Base mainnet dev deployment for the agreed window with the own oracle and independent RPCs, plus oracle, RPC, sponsor, approver and venue fault drills, and an upgrade and rollback rehearsal with open positions.
11. **Hand over governance.** Create the governance and emergency Safes, deploy the 72-hour timelock, and hand over the proxy and oracle (or deploy fresh with the production profile). Replace the dev approver keys.
12. **Capped launch.** One or two markets, conservative caps, extra maker and insurance capital and a documented maximum daily loss. Raise limits one dimension at a time after the observation window, as the [release checklist](release-checklist.md#capped-launch-and-expansion) describes.

Items 1 to 4 can start now. Items 6 to 10 depend on provider accounts, custodians, auditors and capital that the repository cannot supply. Passing local tests does not close any of them.

## Validation

Write a regression with each fix to financial or security logic. Run the narrowest suite first, then `npm test` before calling a change complete. After contract changes, run `npm run test:foundry`, `npm run test:contracts` and `npm run validate:upgrades`. Never count a mock success as live wallet, oracle or venue qualification.

## History

The September 2026 plan, with its R1 to R16 work items and per-pass execution records, is superseded by this page. Its rationale is in the [2026-09-15 production review](../archive/history/2026-09-15-production-review.md), and older records are in [archive/history](../archive/history/).
