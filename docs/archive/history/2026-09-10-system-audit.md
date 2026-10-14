# Whole-system release-candidate audit

Status: ready for adversarial testnet use. The current implementation is active on the rapid-iteration Base Sepolia proxy and the local plus live testnet release suites pass. This assessment does not certify the system for mainnet capital.

## Executive assessment

The architecture has a strong, compact core. Customer custody and risk live on Base; the active API has no maker, approver, governance or withdrawal key; users sign bounded intents; two distinct approvers authorize exact economics; the contract independently checks the oracle, signatures, replay, price protection, fee, inventory impact, portfolio margin and capital limits. The indexer is disposable. Hedging uses separate capital and authority. Public price fanout is separated from the single execution writer.

The best product property is that the normal user path remains amount plus Buy or Sell while the signed object carries the real protection. The best security property is layered authorization: compromise of the public UI, gateway, indexer, gas sponsor or API alone is insufficient to transfer customer funds or execute outside a user's signed limit. The main constraint is Base settlement latency and throughput, not quote calculation or market-data fanout.

No local test can make a financial system “bulletproof.” The latest rapid-iteration implementation is installed and verified at `0x35eDDFfF04296dae1564f4C33518C57C87b91D90`. Mainnet still requires independent audits, production key custody, production infrastructure, vendor agreements, economic calibration on real fill data and formal launch sign-off.

## Findings fixed in this release candidate

### Cross-market liquidation freshness — high

`liquidate` refreshed the selected market, then calculated cross-margin equity across both markets without requiring the other open mark to be fresh. A stale second-market mark could incorrectly decide liquidation eligibility or close size. Liquidation now requires every open portfolio mark to be within the contract's 15-second freshness tolerance. A keeper refreshes the other market permissionlessly before retrying. The contract suite opens a two-market account, advances beyond the bound, proves liquidation fails, refreshes the second mark and then proves liquidation succeeds.

The 15 seconds is a maximum accepted observation age, not a delay imposed on users. Normal execution fetches the newest signed report after wallet signing and submits immediately.

### Private hedge telemetry authentication — high

The hedge risk route was authenticated, but detailed venue positions, open orders and the status stream relied only on loopback binding and CORS. CORS is not access control. Status, streaming and manual reconciliation now require the same bearer boundary whenever a token is configured. The public health route remains minimal. The local dashboard uses authenticated fetch streaming. Production must put it behind a private identity-aware proxy and keep the upstream token out of browser bundles.

### Firm-quote exhaustion — medium

The active-quote cap bounded memory, but an abusive client could fill it cheaply. Firm quote, close-quote and limit-order preparation now share bounded per-client and global token buckets before expensive work, return `429` with `Retry-After`, and cap client-cardinality memory with approximate LRU eviction. Reverse-proxy client addresses are accepted only from explicitly configured proxy IPs or CIDRs. These origin controls complement edge DDoS and bot controls. They are not Sybil resistance; contract-wide pending exposure and price limits remain identity-independent.

### Browser session-key persistence — medium

The optional quick-trading private key was stored in `sessionStorage`, increasing exposure to any same-origin script compromise. It now exists only in React memory for the current tab. Storage contains the public session address and expiry solely so an owner can revoke after refresh. The on-chain session remains limited by market mask, per-trade amount, cumulative amount, fee and expiry and cannot withdraw.

### Duplicate trade actions and wallet drift — medium

Market and limit submissions are now single-flight and disabled through signing and inclusion, with an accessible live status. Injected-wallet account and chain events clear stale views and reload the selected account. A restrictive baseline content security policy blocks foreign scripts, objects and form targets; production should also send the policy as an HTTP header with deployment-specific `connect-src` hosts.

### Sensitive model telemetry — low

Public API health previously returned toxicity, volatility, shadow-model and sender details that could help counterparties infer defenses. Public health now contains only role, epoch, chain and market-data availability. Detailed operational metrics require a bearer token at `/internal/metrics`.

## Architecture verdict by component

| Component | Assessment | Remaining promotion work |
| --- | --- | --- |
| Clearing and risk math | Compact, deterministic and strongly bounded; upgradeable custody preserves user deposits | Two independent Solidity audits, invariant fuzzing by an external toolchain, storage-layout sign-off and latest testnet upgrade |
| Oracle | Pyth Core payload is verified on-chain; stale, future, wrong-market, wide and underfunded reports fail closed | Commercial entitlement review, independent provider alarms, stale-feed drills and a documented fallback decision |
| API leader | Simple single writer gives deterministic pending inventory; signed sender journal survives ambiguous RPC outcomes | Replicated encrypted journal and measured promotion RTO before multi-host launch |
| Approvers | Distinct keys, durable decisions, pinned domain/state, secondary-RPC hash check, exact intent/economic checks and 2-of-3 availability | Independent hosts/providers/key custody; decide how independently to enforce adaptive volatility, toxicity and venue-cost minimums |
| Gas sponsor | Has gas only and cannot authorize trades or withdrawals; durable nonce serialization is tested | Automated low/high balance alerts, capped refill policy, separate operational signer and RPC chaos drill |
| Indexer | Rebuildable chain projection with canonical hashes, finalized view, pagination and reorg recovery | Production Ponder or equivalent benchmark and independent RPC failover |
| Hedge worker | Separate venue capital/key, finalized exposure, pre-write client IDs, reconciliation, open-order suppression and fail-closed quote modes | Streaming Hyperliquid market/account feeds with periodic reconciliation, collateral/liquidation alarms and longer live testnet soak |
| Public gateway | One upstream stream, complete snapshots, bounded slow-reader buffers and reconnect replay | Regional edge deployment, origin authentication, connection quotas and real socket/load testing at target concurrency |
| Customer UI | Lean terminal, live indicative pricing, exact firm quote on click, cross-margin account, orders/history, sponsored actions | Real wallet matrix, mobile/accessibility review, production bridge integration and user research |
| Operations UI | Read-only and keyless with authenticated hedge stream | Identity-aware private deployment, alert timeline and on-call integration |

## Explicit trust boundaries

The contract verifies safety floors; it does not encode the proprietary adaptive spread. Approvers currently verify the declared component sum and exact price construction, a two-basis-point base floor, measured venue cost and basis floors, plus independent oracle, inventory-impact and hedge-admission checks. They do not independently reproduce the API leader's rolling volatility and paid-flow toxicity history. A compromised leader could therefore reduce those two maker-compensation components within the user's and contract's hard safety envelope. This is an economic loss risk rather than direct withdrawal authority. Resolve it before meaningful mainnet limits by distributing an authenticated model-input log or by configuring conservative approver-side minimum envelopes.

The single API writer deliberately serializes shared pending exposure. Warm replicas are recovery targets, not concurrent leaders. Running two writers against separate journals can issue mutually inconsistent quotes. A production failover needs one replicated durable journal and epoch fencing before promotion.

The local cross-chain deposit endpoint is a simulator. Only Base clearing settlement creates collateral, but a real bridge/route provider has not been integrated. The public UI must label source-chain completion separately from Base collateral finality.

## Performance and competitor comparison

Hyperliquid's chain and native order book can provide faster continuous matching and richer order semantics. This product's advantage is bounded RFQ execution: the user sees a live size-specific indication, signs a worst price, pays no gas, and receives one atomic Base position update without managing an order book. Hyperliquid's WebSocket market, order and user-fill subscriptions support the planned event-driven hedge adapter and should replace normal-path REST polling there, while bounded reconciliation remains necessary after disconnects.

Variational demonstrates the approachable amount-first RFQ flow and portfolio-margin presentation. This UI follows that simplicity while making on-chain price protection, account health, funding and public positions visible. dYdX and Synthetix reinforce typed, deterministic market configuration, conservative oracle guards, explicit reduce-only behavior and governance-separated market changes. Features that require a second matching engine, social login custody layer or duplicate customer ledger were excluded because they weaken the current design's clarity.

## Testnet use

1. Source the ignored `base-sepolia.env`. It contains the RPC and Pyth credential. Never commit it.
2. Set a random `RFQ_HEDGE_OPS_TOKEN` for any non-loopback operations deployment.
3. Verify contracts with `npm run verify:base-sepolia-iteration` for the rapid iteration deployment or `npm run verify:base-sepolia` for the timelocked deployment.
4. Start services with `RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE=.local-state/base-sepolia-iteration.json npm run dev:testnet-services`.
5. Start the customer UI with `npm run dev:web`. Configure its API, gateway and indexer URLs through the documented Vite variables when ports or hosts differ.
6. Start `npm run dev:admin` only on a private workstation/network. For testnet with a nondefault token, provide the matching development environment value; production must use a private proxy rather than bundling the token.
7. Run `npm run smoke:base-sepolia-iteration-pyth`, `npm run smoke:base-sepolia-iteration-e2e`, `npm run smoke:hyperliquid-testnet` and, when the venue account is funded, `npm run smoke:base-sepolia-iteration-hedge-e2e`.
8. Run the checkpointed soak with `RFQ_TESTNET_SOAK_HOURS=72 npm run soak:base-sepolia-iteration`. A short smoke is evidence of wiring; it is not soak evidence.

The public docs run on port 4175 with `npm run dev:docs`; internal operations docs run on port 4176 with `npm run dev:internal-docs`; the executable design-system specimen runs on port 4177 with `npm run dev:design-system`. The canonical operational references are [Base Sepolia deployment](base-sepolia-deployment.md), [local development](../operations/local-development.md), [hedging operations](../architecture/hedging.md), [market lifecycle](../operations/market-lifecycle.md), [authorization and upgrades](2026-09-08-authorization-and-upgrades.md), and [production release checklist](../release/release-checklist.md).

## Production sequence

Freeze a release candidate and parameters after a long testnet soak. Commission independent contract and infrastructure audits and resolve every high or critical issue. Run production key ceremonies for governance, emergency, approvers, sponsor and hedge agent with separate people and hosts. Deploy the edge/gateway/private-origin topology, replicated leader journal, monitored RPC/oracle providers and private operations access. Calibrate the adaptive model on real testnet and paper-trading markouts, approve limits market by market, and rehearse oracle failure, signer loss, leader failover, sponsor depletion, venue partial fill, indexer reorg, pause, emergency close and upgrade rollback. Launch with small market/withdrawal/hedge caps and raise them only from measured evidence.
