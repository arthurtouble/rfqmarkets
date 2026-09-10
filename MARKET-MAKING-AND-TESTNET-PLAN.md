# Market making and testnet hardening plan

Status: adaptive-v1 foundation implemented; calibration and live venue inputs remain pre-production work.

## Quote policy

The quote must remain explainable as:

`reference bid/ask + adaptive risk spread + portfolio impact + explicit fee`.

The reference is the authenticated oracle bid or ask. The contract-enforced quadratic potential is the portfolio-impact floor across settled and pending BTC/ETH exposure. It is global, so wallet splitting cannot reset it. The adaptive spread is market-wide and contains independently bounded base, short-horizon volatility, paid-flow toxicity, hedge friction, venue basis, and oracle-confidence components. Identity and wallet history never change price.

This structure combines the inventory reservation-price idea in Avellaneda–Stoikov with the practical separation of inventory, adverse-selection, and hedging costs in later dealer literature. Synthetix's skew-relative fill price supports retaining a visible portfolio impact term. Hyperliquid's order controls support the existing market, limit, reduce-only, price-protection, and cross-margin presentation.

Primary references:

- Avellaneda and Stoikov, *High-frequency trading in a limit order book*: https://math.nyu.edu/inmemoriam/avellaneda/HighFrequencyTrading.pdf
- Guéant, Lehalle, and Fernandez-Tapia, inventory constraints and general price processes: https://arxiv.org/abs/1206.4810
- Barzykin, Bergault, and Guéant, joint client pricing and hedging: https://arxiv.org/abs/2112.02269
- Cartea, Donnelly, and Jaimungal, order-flow imbalance signals: https://ora.ox.ac.uk/objects/uuid:006addde-3a03-4d75-89c1-04b59026e1c0
- Herdegen, Muhle-Karbe, and Stebegg, adverse selection and inventory costs: https://doi.org/10.1287/moor.2022.1294
- Synthetix skew-relative fill price: https://docs.synthetix.io/user-docs/v2-user-docs/integrations/perps-integration-guide/technical-integration
- Hyperliquid order types: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types

## Signal pipeline

Build the next model version behind a shadow-mode flag. Every signal has a validity window, hard range, fallback, owner, and telemetry field.

1. Reference price: Pyth signed bid/ask for settlement; independent Coinbase and venue feeds for detection and quoting context.
2. Volatility: time-weighted EWMA at 1 s, 10 s, 1 min, and 5 min horizons. Sampling must account for irregular tick arrival and gaps.
3. Paid-flow toxicity: post-fill maker markout at 1 s, 5 s, 30 s, and 5 min. Only executed flow updates the score. Cap each fill's size weight so one trade cannot permanently poison the market.
4. Hedge friction: executable venue spread, visible depth for the proposed hedge size, expected fees, recent slippage, rejection rate, and acknowledgement latency.
5. Venue basis: robust median across healthy venues, with a separate dispersion measure. Never shift settlement truth to an exchange mid.
6. Inventory: settled contract exposure plus the conservative pending envelope. Correlated assets share the same portfolio potential.
7. Funding: expected carry to the next hedge/rebalance horizon. Apply a bounded adjustment, never an unrestricted directional prediction.

The API proposes the quote. Every approver independently reconstructs the same bounded inputs from its own feeds and rejects a proposal outside its allowed interval. Exact equality is unnecessary for noisy feeds; the contract still verifies the signed result, current policy version, oracle proof, limit price, fee, nonce, deadline, approver quorum, and portfolio-impact floor.

## Calibration and acceptance gates

Use walk-forward calibration. Fit on an earlier interval, freeze parameters, and report on a later interval. Do not optimize on the final test set.

For every market and regime, record:

- firm-quote latency p50/p95/p99 and settlement inclusion;
- quote-to-fill ratio, signed-price rejection rate, and avoidable rejection rate;
- markouts at 1 s, 5 s, 30 s, and 5 min;
- spread revenue, fee revenue, inventory PnL, funding, hedge fees, slippage, and adverse-selection loss;
- maximum inventory, maximum residual hedge gap, drawdown, 95/99% expected shortfall, and loss-waterfall usage;
- availability by oracle, RPC, approver, API, indexer, and venue state.

Release a model only if all hard invariants pass and its out-of-sample results improve the current model without materially harming normal-flow fill rate. A profitable aggregate backtest is insufficient.

## Testnet work sequence

1. **Shadow adaptive-v1.** Stream current and candidate quote components without changing customer prices. Compare markouts, hedge costs, and hypothetical fills.
2. **Oracle and RPC faults.** Inject stale proofs, future timestamps, feed disagreement, frozen streams, reorgs, provider divergence, timeouts, and rate limits. Verify automatic guarded/reduce-only modes and recovery hysteresis.
3. **Concurrency and abuse.** Burst many funded wallets, split/parallel orders, exact replay, conflicting nonces, abandoned intents, quote scraping, slow clients, SSE reconnect storms, malformed bodies, and sponsor nonce contention.
4. **Economic stress.** Replay calm, trend, jump, crash, basis dislocation, thin-liquidity, toxic-burst, hedge-outage, and funding-shock regimes with randomized order sizes and correlations.
5. **Hedge venue lifecycle.** Exercise partial fills, cancel/replace, lost acknowledgements, duplicate client IDs, stale positions, insufficient margin, withdrawals, and venue maintenance. Reconcile contract, indexer, and venue independently.
6. **User journeys.** Deposit, market trade, fast session trade, resting limit, cancel, partial liquidation, emergency close, withdraw, reconnect, and mobile layouts. Measure each signing step and make errors actionable.
7. **Governance rehearsal.** Add/disable a market, change limits, rotate approvers, rotate leader, change oracle, pause, unpause, upgrade logic, and roll back a failed release using testnet-speed delays.
8. **Soak and release.** Run at least 72 hours with real feeds, periodic trades, forced faults, memory/connection metrics, and reconciliation alarms. Archive the exact build, parameters, deployment addresses, and evidence.

## Product and operations work

The customer terminal uses an exchange-standard arrangement: persistent market selector and ticker, large chart and account workspace, right-side order ticket, top-right wallet, and table-oriented positions/orders/history. Visual hierarchy comes from dividers and typography rather than card stacks. Advanced pricing details stay collapsed.

The private operations surface remains a separate loopback/VPN application with no keys in the browser. Add quote-model component percentiles, markout curves, venue latency/slippage, residual exposure age, collateral headroom, alert acknowledgement, and a read-only event timeline. High-risk control actions stay in the governance/signing workflow rather than this dashboard.

## External production gates

Before mainnet capital, complete independent contract and infrastructure audits, an oracle-commercial review, production key ceremonies, monitored multi-provider RPC and feed agreements, formal incident drills, economic parameter sign-off, legal review, and a capped launch. Testnet evidence reduces uncertainty but cannot replace those gates.
