# RFQ Markets — adversarial order flow

2026-09-08. Proposed requirements extending SIMPLIFIED-DESIGN.md; not implemented or audited. Retains one active API, three private approvers and no extra customer ledger.

## Wallet-independent pricing

Do not depend on identifying related wallets. Price aggregate exposure and liquidity consumption, not a wallet's order size in isolation. Per-account controls help margin and resource management but do not enforce maker-wide limits.

Use a cumulative impact curve. For fixed reference prices and risk parameters, an inventory cost function F gives incremental impact cost F(x + d) - F(x). Consecutive executed pieces telescope to the cost of their total. This is a pricing property under stated conditions, not a claim that execution over changing market conditions must cost the same.

Illustrative one-direction example: x is customer net-long USD exposure at a fixed reference price; F(x) = 0.0005 * x^2 / 100000 dollars. Starting at zero, $100,000 costs $50 in impact. Ten sequential $10,000 pieces cost $0.50, $1.50, ..., $9.50: also $50. Spreads and fees are additional. These are arithmetic examples, not launch parameters. Compute integrated impact across the order, not only the starting marginal price. Define exact units, rounding and partial-fill accounting in the implementation specification.

Synthetix's published [2023 price-impact design](https://blog.synthetix.io/price-impact-function-synthetix-perps/) uses trade size and starting/ending skew to determine fill price. This supports the cumulative-curve approach, without implying identical behavior across current deployments.

An impact curve is not a solvency model. Negative increments can imply inventory-improvement discounts: these require explicit funding, bounds and round-trip analysis. Never grant unrestricted rebates based on provisional inventory or treat fees collected as sufficient backing for all future PnL.

## Admission is sequential; settlement is pipelined

The active API has one short portfolio admission critical section:

1. Validate a signed executable user intent against current inputs.
2. Read settled exposure plus outstanding executable commitments.
3. Calculate price and conservative capacity usage.
4. Atomically record the reservation and proposal identity before dispatching approval requests.
5. Release the critical section; collect approvals, simulate and submit asynchronously.

The next request sees the previous reservation immediately. Never wait for chain inclusion per order and never hold this critical section across network calls. Routine quote browsing does not reserve capacity. Capacity reservations start when processing an executable intent, are bounded, and must survive crashes if a signature might have escaped.

Journal lifecycle: reserved -> approval requested -> approved -> submitted -> observed fill -> reconciled. Ambiguous outcomes stay reserved. Release only when execution is known to be impossible or has been incorporated into settled exposure: consumed nonce/cancellation, fenced epoch, or expiry observed under the selected chain/reorg policy. An HTTP timeout, UI cancellation or local process restart does not invalidate a signed quote. Reconcile provisional observations without counting both reservation and fill.

## Pending orders are optional commitments

Do not simply add signed quantities and net them. Two outstanding opposite orders can both execute, either can execute alone, or neither can execute. They may share collateral or cancellation nonces and therefore not even be jointly executable.

Example: a pending buy moves simulated skew; a sell then receives a generous inventory-reduction price. The buyer abandons the buy and executes only the sell. Private networking and honest signatures do not fix a policy that grants this discount.

Baseline: pending risk-increasing orders consume capacity; pending offsets do not release it. Check conservative scenario bounds for independently executable subsets, including market directions and correlated-factor stresses. Do not enumerate all subsets in production; derive conservative bounds and verify them against exhaustive small cases. For mixed directions, even gross bounds require carefully specified factors and risk measures.

Give no pricing improvement based on an unexecuted offset unless execution is atomically conditional on that offset. Conservative optional-commitment pricing is the initial default. Ordered dependency bundles or auctions add complexity and head-of-line blocking and are not the default. Accepted exact RFQs cannot be silently repriced.

## Security against a malicious leader

The API queue improves ordinary behavior; it is not trusted enforcement. A compromised API could hide reservations and ask approver pairs for many individually acceptable small quotes against the same snapshot. Two-of-three signatures alone do not establish one globally consistent reservation log.

For v1, specify a simple deterministic contract-enforced inventory-impact acceptance bound, alongside current-state market/side/portfolio caps and margin checks. At actual execution, compare the approved exact terms with the bound derived from current on-chain state and the defined price/report policy. Reject stale overly favorable terms rather than silently changing them. The off-chain model can add hedge costs and other conservative charges. External hedge acknowledgements cannot directly increase contract capacity without a separately specified trust mechanism.

This deliberately moves a small amount of economic enforcement on-chain. It does not move the full quoter or hedge strategy on-chain. A signature authenticates a price; a current-state economic bound checks whether that price is still acceptable. Broad oracle deviation limits alone do not stop repeated small inventory mispricing.

The precise bound, signed report selection, favorable-discount treatment and behavior during closes/liquidations are launch-blocking specifications. It must not accidentally prevent essential deleveraging. Rejecting stale quotes under adversarial ordering is an accepted tradeoff; avoidable normal rejections are reduced by the API reservations and pipeline. Guaranteeing every freely selectable fixed quote while offering full provisional-inventory discounts is not a compatible set of requirements.

## Correlated markets

Admission is portfolio-wide, not one independent queue per market. Track directional per-market exposure, gross long/short obligations, factor exposure and stressed losses, including outstanding commitments and conservatively recognized actual hedges. BTC/ETH offsets retain basis, correlation-break and separate-account default risk. Pending hedge orders are not filled hedges; filled hedges still carry venue and collateral-access risk.

A positive-semidefinite quadratic portfolio cost F(x) = 1/2 x^T A x is one candidate for cross-market cumulative pricing: its cross terms charge shared factor exposure and its increments telescope for fixed parameters. This is a research candidate, not a sufficient capital model. Use independent gross caps and stressed scenarios; do not use historical correlation alone to release collateral.

GMX documents [virtual inventory among its protocol protections](https://docs.gmx.io/docs/providing-liquidity/#protocol-protections) for cross-market impact accounting. Its configurations vary by market, including some zero-impact markets; use the shared-accounting principle rather than copying parameters.

## Additional attacks and controls

| Behavior | Required defense |
| --- | --- |
| Many wallets take the same small-order price simultaneously | Atomic shared admission, cumulative impact, pending commitments, current-state contract acceptance bound. |
| Collect both sides, execute only favorable quotes after prices move | Short measured validity; deterministic oracle/report selection; conservative optionality pricing; no provisional-offset discounts. |
| Quote stuffing to lock liquidity | No reservations for indicative browsing; funded executable intents; bounded reservation lifetime and total outstanding commitments; resource quotas. Wallet/IP limits alone are insufficient and availability cannot be guaranteed against unlimited capital. |
| Execute an old quote after cancellation, retry or failover | Contract nonce/cancellation and epoch rules; retain escaped commitments until invalidated; reconcile before retry. |
| Alternate markets or trade around impact/funding transitions | Shared factor accounting; accrued funding before changing exposure; test complete loops including fees, funding and hedge cost. |
| Split to defeat minimum fees, rounding or partial-fill caps | Explicit rounding; economically justified minimum executable size; cumulative per-intent fill/fee accounting; aggregate caps across accounts. |
| Farm sponsorship/referrals with wash flow | Global bounded gas budgets; restricted sponsored calls; rewards no greater than sustainable net economics; no assumption that wallets represent distinct users. |
| Open opposing leveraged wallets and abandon the losing account | Account margin plus gross obligations, jump/default stress, liquidations and bad-debt waterfall; net delta alone is insufficient. |
| Manipulate reference or hedge markets and trade against a stale RFQ | Robust independent observations; divergence/staleness controls; liquidity-aware market limits; bounded hedge slippage and venue exposure. |
| Trade to induce predictable external hedging, then trade ahead of it | Portfolio netting within risk limits; execution-aware prices; hedge slippage/participation limits; analyze total customer-plus-hedge outcomes. |

Legitimate trading that reduces real exposure should receive better economics. Splitting over time after real liquidity replenishment may also reasonably improve prices. The objective is to remove artificial savings from identity changes, stale snapshots and optional pending orders, not prohibit sophisticated or profitable customers.

## Required adversarial simulation before launch

Test one order versus arbitrary partitions at fixed state/parameters; randomized wallets and ordering; every executable subset for small pending sets; opposing orders with cancellation; correlated market loops and broken correlations; partial fills/rounding; malicious API reservation omission; one compromised approver; expiry boundaries; gas grief; leader transitions/reorgs; and stale or failed hedge acknowledgements. Verify user authorization, bounded aggregate exposure and pricing rules for every path. Measure end-to-end tail latency, avoidable versus economic rejections, post-fill markouts and realized hedge costs. A successful signature test is not an economic audit.
