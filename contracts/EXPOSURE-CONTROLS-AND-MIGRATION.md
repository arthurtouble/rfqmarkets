# Candidate exposure controls and migration

This describes the candidate implementation and its local qualification. Limits and stress assumptions require economic review; this document does not qualify production capital or a mainnet release.

## Canonical admission

The appended ExposureControls storage book tracks customer long and short base independently for BTC and ETH. Once ready, each side equals the sum of the corresponding registered-account positions; long minus short equals the legacy aggregateBase. Position transitions, owner exits and portfolio bankruptcy update these counters atomically with the legacy positions. Final resolution clears all counters. Gross exposure cannot disappear when customers take opposing positions.

Every trade uses fresh authenticated executable market prices. A market with nonzero gross positions must have a cached price no older than 15 seconds even when its net aggregate is zero. Gross and each side are valued at lastAsk, rounded down to USDC micro-units. Net exposure and the existing six stress scenarios use the authenticated midpoint and retain their existing integer rounding.

New and crossing trades require an enabled market, the configured baseRiskCapitalTarget of on-chain maker backing, trade/net limits, gross and side limits, and stress loss no greater than backing / 4. The backing check includes selected-market funding settlement and realized PnL from the prospective transition. Prospective fee income and external venue assets do not satisfy the opening floor.

A reduction must strictly reduce absolute account size without crossing through zero. For each gross, side, net or stress bound, its new value must satisfy the bound or be no greater than its prior value. Thus a tightened limit cannot forbid improvement of an existing breach, while removal of an offset cannot increase an already over-limit maker net/stress exposure. Reductions may execute on a disabled market and above the opening trade limit; session limits, signatures, impact, fees and the existing customer margin checks still apply. The paused owner exit remains a separate incident path.

Fresh deployments initialize both gross/side limits at the existing absolute 5,000,000 USDC ceiling. Governance may change them only while paused, with 0 < sideLimit <= grossLimit <= 5,000,000 USDC. Each policy change advances policyVersion. These defaults are bounded prototype values, not calibrated production settings.

## Existing-proxy migration

The struct is appended after the existing marketLimitWord mapping. Existing accounts, positions, aggregate skew, capital, collateral, funding, nonce/session state and EIP-712 formats retain their slots. An upgraded old proxy starts with ready=false. Trading and unpause fail closed until counters are initialized; paused owner exits remain available.

1. Pause through the existing authority. This advances leaderEpoch and fences outstanding maker approvals.
2. Upgrade to the exact reviewed implementation and linked modules.
3. Configure the reviewed BTC and ETH gross/side policy with setExposurePolicy. Both markets must be configured before scanning.
4. Call permissionless migrateExposure with 1–200 accounts per transaction. It advances a persistent cursor through the registered-account list. Completed scans reject further calls.
5. Check exposureState for both markets, confirm ready=true and reconcile counters against chain-derived positions. Review capital, oracle freshness, venue health and approval versions before separately unpausing.

An account already scanned has its counters adjusted by subsequent exits. An unscanned account's exit does not subtract an uncounted position; its eventual scan reads the remaining live positions. Deposits can extend the account list during scanning, but trading is blocked and newly registered accounts cannot introduce open positions. The end condition includes the current account-list length. Resolution rejects further migration and retains the incident claim path.

The rapid-iteration testnet upgrade script requires RFQ_EXPOSURE_POLICY_FILE, an array in BTC/ETH order with grossLimit and sideLimit as raw USDC micro-unit integer strings. It persists the active implementation and pending migration state before configuring/scanning, then records ready=true and leaves the system paused. It rejects active resolution and does not authorize a production upgrade.

## Independent admission and local evidence

Approvers read positions, funding, capital, net limits and both gross books at one independently selected chain block. The shared integer model projects selected-market funding and realized PnL and checks the canonical gross/side/net/stress rules. Missing counters and failed reads reject approval. API quote generation refreshes stale gross markets even when net exposure is zero; exact close quotes verify the owner position before bypassing the opening size limit.

Local regressions cover maker funding below the floor, floor breach after realizing a winner, opposing-position gross bypass, independent side limits, stale gross prices with zero net, tightened/disabled-market reductions, migration before/after owner exits, one-pass scan completion, old-owner-intent reapproval, real independent Pyth approvers and receipt-backed API exits. The multi-account stress fixture checks gross books alongside net/custody invariants after each trade and verifies counter clearing at final resolution.

Legacy tiny testnet maker-funding defaults are below the configured opening floor and no longer qualify as a trade-ready setup. The funding script rejects such a target before allowance/funding transactions. Supply an explicit funded target with headroom under the reviewed configuration; the runtime does not silently lower the floor.

The subsequent [gross approval reservation candidate](GROSS-APPROVAL-RESERVATIONS.md) journals escaped directional capacity independently at API/signers and retains it through finalized expiry.

Outstanding work includes Byzantine peer reservation coordination, conservative pending net/stress/capital envelopes, full independent differential qualification over admission/funding edge cases, calibrated gross liquidity reserves, venue hedge and policy parity, operator migration rehearsal, independent module/economic audits and sustained testnet evidence. Canonical serialization caps accepted trades; rejected overcommitted approvals must not be described as guaranteed fills.
