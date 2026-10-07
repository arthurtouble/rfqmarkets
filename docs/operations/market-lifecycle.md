# Market policy and lifecycle playbook

Status: executable v1 procedure, 2026-09-09; market listing updated 2026-10. Markets live in the clearing registry: BTC (0) and ETH (1) at launch, and governance adds more with `addMarket` (up to 128) without an upgrade. A market index is permanent and is never reassigned to a different asset. See [Adding a market](adding-a-market.md).

## Source of truth

Each market has one packed on-chain policy word. Its low 128 bits are maximum single-trade notional and its high 128 bits are maximum absolute aggregate customer notional, both in USDC 1e6 units. `marketLimitWord(market)` and `markets(market).enabled` are the canonical values. `setMarketPolicy(market, enabled, maxTradeNotional, maxMarketNotional)` changes all three atomically and increments `policyVersion`, invalidating every approval created under the old policy.

The contract allows at most 1,000,000 USDC per trade and 5,000,000 USDC aggregate net notional per market. These are software ceilings, not recommended launch limits. The stress-capital check is independent and usually binds first. With 600,000 USDC maker backing and the current `stressLoss <= makerBacking / 4` rule, a one-sided 5,000,000 USDC book cannot be admitted. Multi-million risk testing therefore uses 10,000,000 mock maker USDC locally; it does not justify the same production capital ratio.

The API reads market state, limits, `policyVersion`, signer version, and leader epoch at one pinned block. It sends the exact limit in the shared SSE frame and uses it for indication and firm construction. Each approver independently reads the same on-chain word at its own pinned block and rejects an oversized envelope. The contract checks it again during execution. Off-chain controls may always be tighter than the contract, for example volatility, hedge-liquidity, daily loss, pending-capacity, or guarded-mode limits.

Production governance is the 72-hour timelock controlled by the cold multisig. It may enable a market or loosen a limit up to the compiled ceiling. The emergency council may disable a market or tighten its limits, but cannot enable or loosen. The [risk operator](risk-operator.md) may change any market setting at once, loosening only within the envelope governance sets. The rapid-iteration Base Sepolia profile uses disposable direct governance so feature work is not gated by this delay. The implementation is currently 20,850 bytes, 3,726 bytes below the EVM runtime-size limit, and the repository enforces a tighter 21,000-byte project gate. Risk and portfolio math remain in the linked stateless library so future clearing changes must fit the same reviewability budget.

## Change a limit

1. Produce a policy proposal with current/new values, maker and insurance backing, normal and severe stress results, observed hedge depth/slippage, expected rejection rate, and rollback values.
2. Replay recorded data and run calm, trend, high-volatility, crash, toxic-flow, hedge-outage, concurrent-wallet, and split-order scenarios. A larger numerical ceiling alone is not approval to use the capacity.
3. For a loosening inside the risk operator's envelope, the operator applies it from the console. Beyond it, queue the exact `setMarketPolicy` calldata in the timelock. Keep API operating limits at the old value during the delay.
4. After execution, wait for finalized indexing and verify the event, policy word, enabled flag, and incremented `policyVersion` through two RPC providers.
5. Restart or invalidate API/approver caches. Their pinned reads make stale approvals fail, but this step restores availability quickly.
6. Raise the tighter off-chain operating limit in stages: shadow only, 10%, 25%, 50%, then target. At every step examine fill rate, markouts, stress headroom, hedge slippage, and failed settlements.
7. Roll back by submitting a lower value. The emergency council can perform this immediately.

## Disable or retire a market

An emergency disable sets `enabled=false` and preserves positions and history. It blocks ordinary new execution. Continue verified funding settlement, cancellation, liquidation, and the documented paused-market exit path as applicable.

For planned retirement: announce the reduce-only date; stop new risk off-chain; set the market to disabled through governance; keep oracle, indexer, UI, and hedge coverage until customer and hedge exposure reach zero; reconcile all funding and collateral; then remove the market from discovery. Never delete a market with open interest or reinterpret its numeric ID.

## Add a market

[Adding a market](adding-a-market.md) covers the steps: the `addMarket` call, oracle coverage, the hedger's coin mapping, and caps. Before you enable a new market:

1. Choose its impact coefficient, stress shock and margin scale from the asset's volatility and the hedge venue's depth.
2. Run shadow quoting, testnet settlement, liquidation, oracle outage, hedge outage and global resolution with the market listed.
3. Fund backing and hedge margin, enable with minimal caps, then follow the staged limit procedure above.

## Local commands

`npm test` runs contract, service, fixed-point, scenario, upgrade, and web gates. `npm run smoke:adversarial-load` sends 10,000 concurrent firm-quote requests by default and verifies bounded 409 rejection after capacity. `python3 -B simulator/market_making_scenarios.py --seed 1` prints comparable regime metrics. Environment variables `RFQ_LOAD_REQUESTS`, `RFQ_LOAD_CAPACITY`, and `RFQ_LOAD_CONCURRENCY` scale the admission test.
