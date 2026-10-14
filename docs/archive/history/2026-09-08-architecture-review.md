# RFQ Markets — security and execution-quality review

2026-09-08. Architecture-level review of SIMPLIFIED-DESIGN.md and its supporting financial design. No implementation exists, so findings are design gaps/attack scenarios, not confirmed code vulnerabilities. Severity indicates potential impact if the gap is implemented unsafely. No audit certification, performance measurement or mainnet verification is implied.

Subsequent user clarification: exactly one API leader executes and all approvers are private. The current simplified design incorporates this. F2 therefore applies to in-flight requests and failover overlap, not normal active-active operation. Network restrictions are retained alongside the economic checks in F1.

## Assessment

Keep the combined API, distinct two-of-three maker approvals, on-chain risk enforcement, Ponder as the only customer read model, and an independent hedge journal. Avoid unnecessary microservices or custom consensus. The design is not yet ready for capital: approval pricing rules, capacity commitments, emergency valuation and insolvency remain underspecified.

Maximum security, zero expiry risk, unconditional immediate fills and no coordination cannot all be promised simultaneously. Define success as fast execution within the user's explicit price/fee limits, with very few avoidable operational rejections. Real market movement outside those limits must still be rejected.

## Gas sponsorship without routine manual work

Relayed intent settlement is already gasless from the user's perspective: the API pays the network fee. The chain still charges someone. The existing typed-intent verifier means ERC-2771 forwarding is not inherently necessary.

Preferred starting point: retain ordinary API gas wallets and automate refilling from an isolated gas reserve. Refill before low balance becomes an execution bottleneck. Use per-recipient and global spending ceilings, a maximum working balance, a bounded burst/refill rate, recipient allowlisting, emergency disable and an absolute funded reserve. Enforce permissions outside the potentially compromised API; an audited allowance mechanism is preferable to unlimited access to a funding wallet. Recipient additions and ceiling increases require separate authority. Rotation must not reset aggregate limits.

A monitoring/refill task can run in existing operations infrastructure; it is not on the trade path and needs no new always-on microservice. Refill can be permissionlessly triggered if contract rules fix recipients and amounts. An independent trigger must have its own gas to recover a drained sender; alert before sender balances approach zero. A compromised sender may repeatedly drain replenishments, but cannot exceed the enforced allowance/reserve. Rate limits bound loss over time, not lifetime loss if funding continues forever.

Fund the reserve periodically through ordinary treasury operations, not per API transaction. Size each wallet from measured transaction cost, peak throughput and refill/recovery delay; an arbitrarily tiny wallet creates avoidable outages. Gas ceilings require a congestion policy so an aggressively low fee cap does not strand transactions and expire quotes. Do not allow an unbounded automatic ceiling increase.

Alternatives:

| Option | UX | Operational/security tradeoff |
| --- | --- | --- |
| Existing intent relayer + bounded auto-refill | User signs intent; operator pays gas | Small local gas key and refill mechanism; closest to current design |
| Managed relayer | Same intent model if integration supports it | Provider manages submission; account/API policy, privacy, budget and availability dependencies |
| ERC-4337 smart-account/paymaster route | Sponsored operations; can improve onboarding | Bundler/paymaster/account integration and additional validation/operations; benchmark rather than assuming faster or cheaper |
| User-paid submission | Useful independent fallback | Requires user gas and wallet UX; not the default trading experience |

[ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) defines bundler/paymaster mechanics. [CDP's paymaster documentation](https://docs.cdp.coinbase.com/paymaster/guides/paymaster-masterclass) demonstrates Base sponsorship with contract/function and spending policies. That is evidence of an available option, not a reason to adopt a specific wallet flow or a promise of unlimited free transactions. A paymaster moves funding management; it does not remove it.

## Prioritized findings

### High — F1: approval policy could become a price-selection service for an attacker

An API-authenticated or user-authenticated request is not evidence of a fair maker price. An attacker can sign their own user intent and ask for the most favorable execution inside every broad oracle tolerance. Two honest services checking only that tolerance would both approve. Repeated valid fills could transfer maker value without stealing any approver key.

Specify mandatory economic approval rules. Every approver independently derives the permitted execution envelope from fresh observations, signed/versioned policy, size, conservative inventory assumptions and fees. The API supplies a proposal, not the inputs' authority. Required checks cannot exist on only one of the three approvers. Track directional concessions and cumulative risk in contract limits. An oracle sanity band is only an outer guard, not the maker's full price policy.

The healthy policy must be selective enough to protect the maker without reproducing three complicated pricing engines. Use a small deterministic acceptance envelope and conservative defaults. If an off-chain inventory input becomes unavailable, services must explicitly tighten capacity or halt affected new risk rather than assume zero exposure.

### High — F2: post-approval capacity races conflict with the product goals

Multiple stateless replicas can obtain approvals against the same remaining capital. On-chain checks prevent unsafe fills but one or more valid-looking requests revert. The previous proposal correctly bounded safety but tolerated a poor execution experience under contention.

Keep quote/read endpoints horizontally replicable. For execution admission, start with a short single-writer lane for the shared maker budget inside the existing API, with per-account ordering. Reserve pending capacity until a fill lands or is conclusively invalid. Persist only accepted/in-flight operational records in the existing internal journal so takeover does not invent unused capacity. This adds state/availability coupling and must be acknowledged; it does not create a second customer ledger.

On failover, fence the old admission writer or conservatively account for its unexpired approvals, reconcile chain and journal, and resume. Contracts remain the final protection if old and new writers overlap. Merely consistent-hashing user accounts does not solve contention for a shared maker pool. Partitioned capacity quotas are a later scalability option, not another launch requirement.

This is a proposal to benchmark against stateless admission, not a mandate to build a distributed queue or consensus service. Choose based on measured rejection rates and failover tolerance.

### High — F3: stale-but-valid observations can create adverse execution

A correctly signed report may still be unsafe for a particular fill. Validate observation time rather than only cryptographic/report expiry; restrict permitted observation selection and cross-market skew. Define when a fresh replacement report may be attached to an unchanged fill and prohibit retrospective selection of advantageous reports.

Approvers continuously ingest price and chain data. They do not cold-fetch all inputs after the user clicks. Contract verification remains mandatory. Independent reference prices can halt approval on divergence but cannot silently replace the settlement oracle. Oracle outage remains an explicit unavailable-valuation state.

### High — F4: exit and insolvency paths are unfinished financial mechanisms

Permissionless closing at an arbitrary recent price can defeat refusal rights and transfer value. Define eligible observation, slippage bounds, fees, cancellation, liquidation precedence and stale-data behavior. Bankruptcy resolution must specify who bears deficits and how claims are treated without first-come withdrawals draining a shared shortfall.

Maker reserves, hedge collateral and insurance cannot be double-counted. Profitability expectations do not cover currently due withdrawals. No signer topology compensates for incomplete accounting.

### High — F5: signer and upgrade authority can bypass assumed fault isolation

One provisioning credential must not install a quorum of signers or deploy arbitrary code to all three. Cold governance, independent releases and latched pause semantics remain necessary. A two-key compromise permits maker authorization; on-chain limits and actual posted capital are the remaining constraints.

Proxy upgrades can ultimately change financial checks. Test storage and economic compatibility, version signed messages where semantics change, and retain delayed authorization without unrestricted emergency bypass. Timelocks do not guarantee exit during a chain/oracle failure.

### Medium — F6: expiry handling can turn normal latency into repeated user failures

Separate the user's intent deadline from the short maker approval lifetime. A user authorizes size, direction, limit price, maximum fee, reduce-only status and a bounded time window. The API may refresh approvals/reprice within those exact constraints, without another signature, while preserving intent identity and cancellation state.

Before retrying an ambiguous submission, reconcile the original intent/nonce. Do not create a new intent to bypass duplicate protection, extend the user's deadline, widen slippage or raise their fee. Changed approvals do not prove an old transaction cannot still execute. All possible authorized executions must respect the same user bounds.

Measure approval and inclusion tail latency; choose freshness/expiry rules using that evidence. Do not simply extend quote validity indefinitely: a signed maker quote grants a short exercise option. Avoid sub-second Solidity timestamp assumptions; on-chain time has different granularity from application timers.

### Medium — F7: sender nonces and sponsorship exhaustion can stall healthy trading

One stuck sender nonce can block later transactions. Use a bounded pending queue, tested replacement policy and a small pre-funded sender pool with separate nonce tracking. Re-broadcast the same signed transaction to healthy RPCs before generating independent competing transactions. Keep retries idempotent at the protocol level.

Cap gas griefing, including requests that simulate successfully but revert after intervening state changes. Refill budgets and sponsorship checks must live outside a compromised API's discretionary configuration. Maintain a recovery path when one sender or sponsorship route is exhausted.

### Medium — F8: frontend compromise and inaccurate pending state can defeat good contracts

Session keys can trade away collateral even without withdrawal rights. Bound scope/turnover/fees and provide direct revocation. Test smart-contract-wallet authorization and malicious frontend requests; do not assume a static mirror protects visitors to a compromised primary site.

Apply provisional fill events to the UI promptly, then reconcile Ponder at a known checkpoint without counting a fill twice. Distinguish estimated PnL, preconfirmed execution and finalized state. Sponsored trading does not automatically make the initial approval/deposit/session setup gasless for every wallet.

## Execution path optimized for the stated goals

1. Continuously stream indicative size-aware prices and maintain warm oracle/chain caches.
2. User/session signs a bounded intent; no approval network on mere display updates.
3. Admission checks and pending capacity reservation occur once an execution is requested.
4. Ask all approvers concurrently; take two matching valid approvals. Do not wait for the third.
5. Simulate against the appropriate recent/pending state, construct the transaction and submit immediately. Simulation reduces failures but cannot reserve chain state.
6. Observe preconfirmation/inclusion directly and update the UI before the history indexer catches up.
7. Refresh/retry internally only when it remains valid under the original user authorization; reconcile uncertain prior submissions.
8. Reconcile history through Ponder and hedge the chosen execution stage with explicit reorg risk.

Base documents [Flashblocks preconfirmation RPCs](https://docs.base.org/base-chain/api-reference/flashblocks-api/flashblocks-api-overview) and [approximately 200 ms sub-block streaming](https://blog.base.dev/flashblocks-deep-dive). This is infrastructure behavior, not a click-to-fill SLA; RPC, approval and network latency add to it. A preconfirmation is not irreversible finality. Avoid a product design that waits for full Ethereum finality to update normal trading UI.

Avoid fixed batch waits for retail execution. Benchmark small opportunistic batches/report reuse only where the added coupling and gas actually improve user outcomes. Gas costs include execution, calldata/L1-related charges, failed attempts and relevant oracle/service costs. Never quote a cost target from chain execution gas alone.

## What remains intentionally unchanged

- Combined API deployment; internal modules instead of separate coordinator/quoter/relayer servers.
- Two-of-three distinct maker approvals, subject to measured policy/latency performance.
- Ponder as the sole customer read model; operational reservations and hedge records have a different purpose.
- Independent hedge execution with durable acknowledgement/reconciliation and old-writer fencing.
- Direct contract access and distinct emergency liquidation/exit rules.

## Validation plan and product scorecard

Track click-to-approval, click-to-preconfirmation and click-to-inclusion distributions; operational rejection rate separately from price-limit failures; retries per intent; worse-than-limit fills (must be zero); quoted versus executed price; cost per successful fill including failed attempts; approval disagreements; gas runway; and time to reconcile a failover.

Set target percentiles and success-rate gates before launch tests; no latency or rejection target has been demonstrated. Test calm flow, peak simultaneous orders, sharp moves, oracle delays, one signer down, a malicious API choosing edge prices, repeated gas draining, sender nonce stalls, and API restart immediately after broadcast. Economic attack simulations and contract fuzz/invariant tests are required in addition to UI happy-path tests.

Recommendation: automate bounded sponsorship first; formalize the approver price envelope and admission/reservation semantics next; then benchmark the complete path before adding more infrastructure. Preserve user bounds through internal retries rather than hiding execution risk by widening them.
