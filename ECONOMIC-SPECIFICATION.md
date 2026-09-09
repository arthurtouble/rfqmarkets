# RFQ Markets — executable economic and resolution specification

2026-09-08. Version 0.1 candidate for simulation and review. This document closes the earlier design choices with explicit initial rules. Numerical values are conservative beta hypotheses, not evidence that a real-money deployment is safe. They remain behind governance policy versions and may be loosened only after measured test results, independent review and timelock.

## Scope and accounting units

Launch markets: BTC-USDC and ETH-USDC linear perpetuals on Base. One signed net base-asset position per market per subaccount; cross margin within a subaccount; no cross-subaccount netting; no external LP deposits; all-or-nothing market-with-protection RFQ fills. USDC is the only collateral and payout asset.

Contract storage uses explicitly documented signed fixed-point integers: USDC balances/fees at 1e6; base quantities at market-specific 1e18; prices and funding accumulators at 1e18. Every conversion specifies floor/ceiling by beneficiary. User charges and margin requirements round up; user credits and withdrawals round down. The simulator currently uses floating point only and must gain a fixed-point mirror before Solidity implementation.

Let `q[i]` be customer signed base position, positive for long; `p[i]` the mark in USDC; `x[i] = q[i] * p[i]` signed customer notional. The operator/maker has the opposite aggregate economic position. No token balance is counted twice as customer collateral, maker backing, insurance or external hedge collateral.

## Initial capital and risk budget

Assume $1,000,000 is the total initial operator risk/operations budget:

| Allocation | Initial amount | Treatment |
| --- | ---: | --- |
| Base maker backing | 600,000 USDC | Normal customer PnL and liquidity backing; contract-visible |
| Segregated Base insurance | 150,000 USDC | Bankruptcy gaps after account collateral; not normal quoting capacity |
| External hedge margin | 200,000 USDC | Venue-specific maker funds; no on-chain solvency credit |
| Treasury/operations reserve | 50,000 USDC equivalent | Oracle, infrastructure and recovery; gas ETH budget accounted separately |

If the intended $1M is maker backing alone, preserve these safety ratios and fund insurance, hedging and operations additionally; do not silently carve them from user deposits.

Normal admission requires worst modeled portfolio loss no greater than 25% of Base maker backing (initially 150,000 USDC). Severe stress plus already recognized deficit must remain below 75% of Base maker backing (450,000 USDC). Insurance is excluded from both admission thresholds. It is a last-resort realized-loss layer.

Initial operating caps, all wallet-independent and inclusive of executable reservations:

- 25,000 USDC maximum single RFQ;
- 100,000 USDC maximum notional per subaccount;
- 250,000 USDC open interest per market per side;
- 750,000 USDC total gross open interest across both markets;
- normal and severe portfolio stress constraints above;
- no credit from unfilled or unreconciled external hedge orders.

The deployed v1 software ceilings are higher so scale can be exercised without an upgrade: 1,000,000 USDC per trade and 5,000,000 USDC aggregate net customer notional per market. On-chain per-market policy starts at those ceilings in the scale laboratory. A production launch must set the lower operating caps above before accepting users. The independent stress-capital constraint still binds even if the numerical market ceiling is higher.

The 25,000 USDC single-RFQ cap is also bounded by what the hedge router can execute within 20 bps using at most 1% of observed aggregate venue depth. Use the smaller limit. From 60% of any net/stress cap, increase the accumulating-side impact coefficient and reduce its maximum size linearly. From 90%, quote that side with at most 25% of normal size and doubled minimum impact. At 100%, allow only exposure-reducing flow. This avoids a predictable hard pricing cliff.

The normal stress set includes joint BTC/ETH moves `(±20%, ±25%)` and broken-correlation moves `(+15%, -20%)`, `(-15%, +20%)`. Severe scenarios include joint `(±40%, ±50%)`, a 2% hedge execution/venue-cost add-on, customer bankruptcy gaps and a 5% USDC deviation scenario. Parameter governance may add scenarios immediately through risk tightening; removing a scenario or increasing capacity is delayed.

## Reference and oracle policy

Convert asset/USD reports to asset/USDC using an approved USDC/USD observation rather than assuming a permanent peg. Chainlink Data Streams v3 is the primary candidate: its reports contain feed identity, observation time, expiry, price, bid and ask fields. [Chainlink v3 report schema](https://docs.chain.link/data-streams/reference/report-schema-v3).

At approval time for BTC/ETH normal mode:

- observation age at most 2 seconds;
- expected age at contract inclusion at most 8 seconds;
- valid feed/schema and non-expired report;
- `bid <= price <= ask` and report width at most 50 bps;
- median independent venue reference within 25 bps of report mid;
- cross-market observations no more than 2 seconds apart.

These are initial test settings. Measurements may show that the two-second approval threshold causes avoidable failures; safety is governed by the eight-second contract maximum and user price bound, while approvers can adopt a measured threshold within it.

Modes:

| Mode | Trigger | Allowed behavior |
| --- | --- | --- |
| Normal | All freshness/width/divergence checks pass | Ordinary opening, closing, liquidation and withdrawal checks |
| Guarded | Fresh primary report but width 50–100 bps, reference divergence 25–100 bps or configured volatility trigger | Halve admission caps, widen only inside user protection, allow reduce-only; no maker withdrawal |
| Oracle paused | No qualifying report, width/divergence above guarded bound or USDC conversion unavailable | No new risk, liquidation or marked withdrawal; cancellation, deposit, session revocation and provably unencumbered withdrawal remain available |
| Insolvency resolution | Contract solvency trigger or governance proposal after objective condition | No ordinary trading; deterministic valuation and claims process |

Approvers consume continuous independent data. The contract verifies the submitted primary report and the policy version. Independent venue data is a divergence circuit breaker, not a caller-selectable settlement oracle.

For a primary outage, a reduce-only exit request records its account, position bound, user limit, nonce and request block. The first qualifying primary report observed after that block can execute it. After 30 minutes, a preconfigured Chainlink Data Feed fallback may execute reduce-only requests only if its heartbeat and deviation rules pass; addresses and conversion rules are fixed before launch. No administrator chooses a historical price. Users may cancel before execution unless liquidation has started. If neither source is trustworthy, fair marked settlement is unavailable; the protocol preserves cancellations and unencumbered collateral operations rather than inventing a price.

## Quote construction

The UI flow is defined in UX-AND-INTENT.md. The quoter computes an exact proposed fill inside the user's automatically generated bound.

For signed customer-notional change `d`, reference cash is based on the fresh report converted to USDC. Directional liquidity anchor uses ask for a customer buy and bid for a customer sell. The off-chain required customer charge is:

`charge = baseSpread * abs(d) + boundedImpact + explicitTradingFee`

`baseSpread` is at least the sum of observable hedge crossing cost/fee, latency loss quantile and configured minimum maker spread. Toxic-flow/volatility adjustments are deterministic bounded policy inputs; approvers recompute their minimum, and the API may quote more conservatively but never outside the user's limit. Launch minimum half-spread is 2 bps and explicit trading fee is 2 bps; both are calibration values.

Measure maker markout after every settled fill at 1, 10, 60 and 300 seconds using the same reference policy. Aggregate by market, side, size, volatility and time regime, without needing wallet identity. A materially negative rolling 10/60-second markout increases the affected market's minimum spread and reduces its size cap under a bounded signed policy; recovery decays slowly. Flow imbalance, oracle-update timing and hedge slippage are supporting aggregate signals. Automated policy may only tighten within preauthorized bounds; loosening requires reviewed configuration. Never delay a specific user after seeing their identity.

Inventory impact comes from a convex portfolio potential:

`C(x) = 0.5 * x' A x`

`rawImpact = C(x + d) - C(x)`

`A` is positive semidefinite and versioned. Initial diagonal coefficients give marginal impact at 100,000 USDC exposure of 10 bps for BTC and 12 bps for ETH; the BTC/ETH cross coefficient uses 0.60 times the geometric mean of the diagonals. These are simulator values, not claims about market depth.

Positive raw impact is charged. Negative impact is an inventory-improvement credit, capped per fill at the smallest of: the absolute raw impact, 50% of that fill's base-spread charge, 5 bps of notional, and the market's funded rebate budget. Pending orders cannot create this credit. This preserves an incentive for real risk reduction without offering unlimited rebates or a round-trip subsidy. Fees always remain payable.

Allocate 20% of explicit trading fees and all liquidation-penalty remainder to insurance until insurance reaches 25% of target Base maker backing; allocate 10% of explicit fees thereafter. The rest belongs to maker revenue. Insurance accounting is on-chain and cannot be represented by the same USDC simultaneously counted as maker backing.

For pending commitments, the API evaluates the new fill against materially executable pending subsets and chooses the greatest required charge and worst stress result. The research simulator exhaustively enumerates small sets; production uses conservative directional/factor bounds proven to dominate enumeration. Pending risk never nets away solely because two orders have different sides or wallets.

The contract recomputes a simpler minimum charge from actual settled state, the approved oracle report, the same potential parameters and rebate caps. The signed exact charge must be at least that current-state minimum. This makes repeated cheap signatures fail after earlier fills change state. Contract caps and margin are then checked atomically. The full hedge/latency spread remains enforced by two approvers, keeping complex market data off-chain.

Published Synthetix material illustrates fill pricing from initial/final skew, while current GMX documentation uses change in imbalance, caps favorable impact and tracks virtual inventory across correlated markets. These support the chosen cumulative and cross-market structure, though their counterparty models differ from ours. [Synthetix price impact](https://blog.synthetix.io/price-impact-function-synthetix-perps/), [GMX price impact](https://docs.gmx.io/docs/trading/fees/).

## Margin and withdrawals

User equity is deposited collateral plus realized and unrealized PnL minus accrued funding and fees. Negative unrealized PnL counts fully. For opening new risk and withdrawing while positions remain, positive unrealized PnL receives zero collateral credit in v1; closing realizes it. For maintenance/liquidation, all PnL counts so a profitable account is not liquidated merely because profits are unrealized.

Initial per-market tiers:

| Subaccount market notional | Initial margin | Maintenance margin |
| ---: | ---: | ---: |
| 0–25,000 | 20% | 12% |
| 25,000–100,000 | 25% | 15% |
| 100,000–250,000 | 33% | 20% |
| 250,000–1,000,000 | 50% | 30% |
| 1,000,000–2,500,000 | 67% | 40% |
| 2,500,000–5,000,000 | 100% | 60% |

Requirements add across positions; there is no user correlation offset in v1. Orders increasing absolute exposure require post-fill equity at or above initial margin. Reduce-only orders must reduce absolute base size and cannot flip direction. A withdrawal requires the zero-positive-uPnL equity calculation to remain above initial margin plus pending user-authorized obligations. Maker withdrawals separately preserve customer withdrawal liquidity, all recognized liabilities, Base maker backing target and both stress limits.

Size-dependent margin is established practice on major venues: Hyperliquid documents continuous margin tiers, and Drift documents an IMF factor and restricted positive unrealized-PnL credit for initial margin. We adopt the conservative principles, not their leverage levels. [Hyperliquid margin tiers](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margin-tiers), [Drift margin requirements](https://docs.drift.trade/protocol/trading/margin).

## Funding

Funding is zero-sum among customer accounts and the maker's explicit opposite aggregate position. For each market:

`fundingAPR = clamp(-100%, +100%, 100% * customerSkew / skewScale)`

where initial `skewScale` equals the market's 250,000 USDC per-side cap. Positive customer-long skew means longs pay and shorts receive; the maker receives the net. Accrue continuously through a cumulative index, crystallizing the old interval before every skew-changing trade. Cap a single catch-up call to seven days and require sequential chunks beyond that to prevent overflow or one-call surprises after a long outage. Funding does not substitute for hard exposure limits.

The instantaneous formula is chosen for v1 simplicity. Dynamic funding-velocity models such as Synthetix's are a later candidate only after loop and manipulation testing. Funding coefficients can tighten immediately; changes that pay larger credits or reduce charges are delayed.

## Liquidation and bankruptcy

Liquidation uses the current qualifying report's adverse directional price: bid to value/close a long and ask to value/close a short, converted to USDC. If equity falls below maintenance, the contract increments an account risk nonce, invalidating outstanding trade intents, then closes the smallest of: 25% of the selected position, the amount estimated to restore 22% equity-to-notional, or the entire remaining position. Positions at or below 10,000 USDC may close fully. Re-evaluate after every chunk; processing is bounded per transaction and permissionless.

Close price applies a 50 bps penalty beyond the eligible directional oracle price, capped by remaining nonnegative equity. The keeper receives 10 bps of liquidated notional or 20% of collected penalty, whichever is smaller; the remainder goes to insurance. Liquidation always reduces absolute user exposure and cannot flip it. The maker is the closing counterparty, so no approver is required; oracle, limit, accounting and reentrancy checks remain mandatory.

If account equity is nonpositive, close remaining positions at the deterministic bankruptcy accounting price, set customer residual equity to zero and charge the realized deficit first to segregated insurance, then to Base maker backing. Never allow a negative account to continue opening risk.

Partial liquidation followed by a backstop is common in major perp systems. Hyperliquid documents partial liquidation and a backstop vault; dYdX documents deleveraging of negative accounts and insurance support for liquidation execution. Our operator-counterparty model uses direct contract closing, so those mechanisms are references rather than drop-in implementations. [Hyperliquid liquidations](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations), [dYdX loss mechanisms](https://help.dydx.trade/en/articles/166973-contract-loss-mechanisms-on-dydx-chain).

## Maker solvency and loss resolution

After every financial transition calculate:

- token assets actually held on Base;
- customer deposited collateral and realized withdrawal claims;
- marked positive customer claims and negative account deficits;
- maker backing and segregated insurance;
- accrued funding and fees;
- normal/severe stress headroom.

No new risk is allowed when normal headroom fails. Guarded mode begins when Base maker equity falls below 80% of its target. Maker and insurance withdrawals stop whenever guarded, oracle-paused, under stress limits or carrying unresolved accounting.

Loss waterfall: affected account collateral; collected liquidation penalty; segregated insurance; Base maker backing. External hedge equity can replenish Base only after an actual finalized transfer. If the clearing system cannot honor all positive USDC claims after those layers, enter irreversible resolution for that incident: pause trading and ordinary withdrawals, invalidate all intents, value every position from the first three qualifying reports over at least 30 seconds after the trigger, close positions into fixed claims, then distribute available assets pro rata among equal-priority positive customer claims. Governance cannot choose claim order or valuation reports. Later recoveries are distributed by the same claim ratio. This avoids a first-withdrawer advantage.

Auto-deleveraging profitable positions can preserve operation, as Hyperliquid documents, but it unexpectedly changes successful customer positions. V1 chooses transparent market-wide resolution only after all stated loss-bearing capital is exhausted. ADL remains a potential later mechanism, not a hidden discretionary power. [Hyperliquid auto-deleveraging](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/auto-deleveraging).

## Hedging policy

Hedging targets the maker's aggregate factor exposure, not individual customer wallets. On each sealed Base block, calculate settled net delta plus conservative liquidation/funding effects. Do not hedge mere approvals. Base preconfirmation may trigger a small provisional hedge only after measured reorg-loss limits exist; baseline waits for a sealed block, while the UI can still show preconfirmed execution. Base documents preconfirmed pending state at roughly 200 ms intervals. [Base Flashblocks](https://docs.base.org/base-chain/api-reference/flashblocks-api/flashblocks-api-overview).

Initial target band per market is 25,000 USDC or 5% of Base maker backing, whichever is smaller. Outside the band, trade toward 50% of the band using IOC/marketable-limit orders with: unique client ID; 20 bps normal slippage cap; 1% of observed venue depth participation per slice; 5-second acknowledgement timeout followed by reconciliation, never blind retry; venue gross and daily-loss limits; and a 100,000 USDC maximum hedge position per market until the 200,000 USDC venue allocation and liquidation behavior are tested.

Hedge failure halves RFQ caps immediately; exposure beyond twice the target band allows only risk-reducing customer flow. Venue equity and funding affect off-chain quote costs and treasury decisions but not on-chain solvency credit.

## Governance and emergency authority

Long-lived authority is a 3-of-5 cold Safe-style multisig controlling a self-administered 72-hour on-chain timelock. It controls upgrades, new signers/oracles, risk loosening, treasury/insurance withdrawals and role changes. Timelock delay changes go through the same timelock. OpenZeppelin describes this self-administered delayed-control pattern. [OpenZeppelin access control](https://docs.openzeppelin.com/contracts/5.x/access-control).

A separate 2-of-3 emergency council may pause new risk, tighten any numeric limit, disable a market, remove one compromised approver while preserving the two-signature threshold, or disable sponsorship. It cannot upgrade, transfer assets, add authority, loosen limits, unpause or select prices. Unpause and loosening require the cold governance delay. Pause does not block deposits, cancellation, session revocation, liquidation with a valid oracle, or provably unencumbered withdrawals.

Approver policy, signer set, intent schema, leader epoch and economic parameters each have explicit monotonic versions. Rotation never resets nonce, spend, exposure or rebate budgets.

## Recovery protocol

Every approver durably records digest, epoch, expiry and its signature before replying. The API journals reservation and transaction state locally before the corresponding external action. A reservation that never obtained two signatures can be discarded after recovery; any digest signed by two approvers is treated as escaped and executable until invalidated.

On API failure, the 2-of-3 emergency council submits the expected-current-epoch transition and waits for sealed inclusion. The candidate standby gathers unexpired signature logs from all reachable approvers, reconciles old-epoch fills, and then admits new-epoch work with its separate gas sender. The epoch transition invalidates all remaining old maker approvals. User intents retain their original nonce, limit and deadline and may be freshly approved only if still valid.

This removes the need for a distributed application database: two durable signer logs prove every potentially executable 2-of-3 bundle. Exact log storage, retention and disaster restore still require implementation testing.

Hedge takeover is stricter. Revoke/fence the former trade credential at the venue, reconcile orders/fills/client IDs, then enable the dormant credential. If venue fencing cannot be verified, stop hedge writes and restrict RFQs to exposure-reducing flow. A database lease is insufficient.

## Validation gates

The simulator must add fixed-point equivalence; randomized partition/order tests; all pending subsets for small sets and proven conservative bounds for large sets; margin/funding paths; liquidation progress; bankruptcy and pro-rata claims; oracle modes; USDC deviation; hedge latency/slippage/failure; API and signer faults; reorgs; and parameter sweeps over recorded BTC/ETH shock paths.

Before testnet, publish executable invariants: no fill outside user bound; no duplicate fill; two distinct current approvers; contract acceptance never less conservative after risk-increasing prior fills; withdrawals preserve required backing; liquidation reduces absolute exposure; funding is zero-sum within rounding reserve; resolution is order-independent; rotations cannot restore consumed budgets.

Before capital, require independent economic review, Solidity audits, invariant fuzzing/formal checks of critical accounting, upgrade tests with open positions, testnet fault injection, restore drills and measured latency/cost/error percentiles. Initial success targets: zero worse-than-limit fills; under 0.5% avoidable operational rejection in normal mode; p95 click-to-preconfirmation under 1 second if measured infrastructure supports it; and no unbounded loss from any single hot credential. These are gates to prove, not current claims.
