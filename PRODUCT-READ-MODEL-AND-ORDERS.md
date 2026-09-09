# Product read model and conditional orders

Status: account and market read model implemented locally; conditional orders specified for the next contract schema revision.

## Prices shown to users

The interface keeps three price concepts separate:

1. **Oracle bid/ask and mid** come from the authenticated Chainlink Data Streams report cache. They are the independent reference and the directional marks used for risk.
2. **Indicative execution** is a size-specific RFQ computed by the API from the directional oracle price, base spread, fee, settled portfolio inventory and every still-executable reservation. It updates without reserving capacity.
3. **Firm execution** is created after the click, bounded by the user's signed worst price, approved by two independent approvers and checked again by the contract against the exact oracle report and current settled state.

`GET /v1/markets` returns a coherent BTC/ETH snapshot. `GET /v1/markets/stream` exposes the same snapshot as Server-Sent Events. The client uses SSE where available and one-second HTTP refresh as a compatibility fallback. A one-way stream is sufficient because order entry remains an authenticated HTTP request.

The public hostname should terminate at Cloudflare. A Cloudflare Tunnel gives the API an outbound-only path to the edge, so the origin does not require a publicly routable address. Only the public API and price stream enter that tunnel. Approvers remain on a separate private network reachable only from enrolled API hosts. The hedge service and its dashboard have no route from the public hostname.

## Account model

`GET /v1/account/:address` reads one block-tagged chain snapshot and the current price snapshot. It reports:

- deposited collateral;
- conservative account equity;
- opening equity, which does not count positive unrealized PnL;
- gross notional and effective leverage;
- initial and maintenance margin;
- available initial margin and maintenance buffer;
- maintenance-margin usage and liquidatable status;
- position size, entry, directional mark, notional, unrealized PnL and accrued funding for each market.

Funding shown before settlement is an estimate from the same formula the contract applies on the next qualifying oracle update. The response also carries the contract's stored view values so integration tests can detect divergence. Ponder remains the durable chain-derived source for activity and historical state; it is not a second live risk engine.

Cross margin has no meaningful user-selected leverage per position. The launch UI therefore shows effective account leverage and margin usage. Position tier limits imply maximum opening leverage of 5x up to $25,000, 4x up to $50,000 and approximately 3.03x up to $100,000. Adding a leverage selector would only change how much collateral the UI suggests, not the clearing rule.

## Resting limit orders

Version one should use all-or-none orders. This matches an RFQ maker's atomic fill model and avoids cumulative-fill accounting in the first release. A buy becomes eligible only when a fresh, size-specific maker ask is at or below the signed limit. A sell becomes eligible only when the fresh maker bid is at or above it. The trigger uses executable quoted price, not oracle mid. A brief oracle touch that the maker would not execute must not trigger an order.

The user signs a durable `ConditionalOrder` containing:

- account, market, signed exact base quantity and limit price;
- maximum total fee;
- reduce-only flag;
- order nonce and expiry;
- optional trigger type for future TP/SL support;
- chain ID and a dedicated order-router/verifier address through EIP-712.

The signature must not bind an API leader epoch. Leader, approver-set and policy versions belong in the short-lived maker approval produced at execution. This lets a valid user order survive routine API failover while ensuring execution uses the current policy and signer set. Cancellation consumes the order nonce on-chain. An API-only cancellation is insufficient because an escaped signed execution bundle may still exist.

At trigger time the active order worker:

1. reads current chain state and a fresh authenticated oracle report;
2. obtains a size-specific firm quote using global settled and reserved exposure;
3. verifies the signed limit, fee cap, expiry and reduce-only condition;
4. reserves portfolio capacity and asks all three approvers in parallel;
5. submits after two matching approvals;
6. marks the order filled only after chain inclusion and reconciles by nonce after any ambiguous response.

The contract consumes the conditional order nonce atomically with settlement. The approvers independently reconstruct the same order digest and current quote policy. The order database is an operational journal of signed orders and attempts; on-chain nonces and settlement events remain authoritative.

Partial fills should follow only after adding `filledBase` and `chargedFee` accounting keyed by the order digest. Each child fill must reduce remaining size, enforce the original aggregate fee ceiling and remain inside the limit. Splitting children cannot earn inventory credits or evade portfolio reservations. TP/SL can then reuse this cumulative order primitive, with reduce-only and automatic resizing bounded by the live position.

## Methods adopted from established venues

- Variational separates index, mark, indicative quote and firm quote, and triggers RFQ limit orders on executable quoted price. That is the closest product match and supports the price model above.
- Hyperliquid separates robust oracle and mark prices, streams BBO/account/funding events, uses size-dependent margin and supports partial liquidation before a backstop. We retain directional external marks, tiered margin, explicit account health and bounded partial liquidation.
- dYdX evaluates liquidation at total account equity versus maintenance requirement and uses bounded protocol liquidation orders plus insurance. We retain account-level cross-margin eligibility, partial close and a separate insurance layer.
- Synthetix exposes total collateral, available/withdrawable margin, required margins, accrued funding/PnL and estimated fill/fees as first-class read functions. The API read model now exposes their equivalents without increasing clearing-contract bytecode.

We do not copy Hyperliquid's user leverage selector because it does not alter liquidation price for cross margin and adds ambiguity to this product. We do not copy an order book, isolated margin, multi-collateral valuation, or partial limit fills into launch scope. Those features add separate accounting and liquidation states before the core RFQ path has production evidence.

Primary references: [Variational RFQ prices](https://docs.variational.io/omni/trading/quoted-index-and-mark-prices), [Variational limit orders](https://docs.variational.io/variational-protocol/key-concepts/market-vs.-limit-orders), [Hyperliquid price indices](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/robust-price-indices), [Hyperliquid margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining), [Hyperliquid liquidations](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations), [dYdX liquidations](https://help.dydx.trade/en/articles/166991-liquidations-on-dydx-chain), and [Synthetix Perps V3 integration](https://docs.synthetix.io/developer-docs/for-perp-integrators/perps-v3).
