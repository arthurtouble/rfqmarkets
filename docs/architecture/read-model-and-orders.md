# Product read model and conditional orders

Status: account and market read model, all-or-none limit orders and trigger orders (stop-loss, take-profit, stop entry) implemented locally.

## Prices shown to users

The interface keeps three price concepts separate:

1. **Oracle bid/ask and mid** come from the signed oracle nodes' combined report ([Price oracle](oracle.md)). They are the independent reference and the directional marks used for risk.
2. **Indicative execution** is a size-specific RFQ computed by the API from the directional oracle price, base spread, fee, settled portfolio inventory and every still-executable reservation. It updates without reserving capacity.
3. **Firm execution** is created after the click, bounded by the user's signed worst price, approved by two independent approvers and checked again by the contract against the exact oracle report and current settled state.

`GET /v1/markets` returns a coherent BTC/ETH snapshot. `GET /v1/markets/stream` pushes complete pricing frames as Server-Sent Events. The browser does not poll and does not request a server quote while the user types. It applies the shared integer pricing function to the streamed BBO and portfolio envelope, then requests one authoritative firm quote after the click. Native SSE reconnect replaces the whole frame. Production may offer the same schema over WebSocket where required. See [scale-and-streaming.md](scale-and-streaming.md).

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

Funding shown before settlement is an estimate from the same formula the contract applies on the next qualifying oracle update. Whenever an account action crystallizes a non-zero payment, the contract emits `FundingSettled(account, market, payment)` and the indexer records it in account activity. The response also carries the contract's stored view values so integration tests can detect divergence. Ponder remains the durable chain-derived source for activity and historical state; it is not a second live risk engine.

Cross margin has no meaningful user-selected leverage per position. The UI shows effective account leverage and margin usage; leverage presets only size the order against available margin. Each market's tiers are scaled by its on-chain `marginScaleBps` ([economic specification](economic-specification.md#margin-and-withdrawals)): at 10,000 the first tier allows 5x, at 2,500 it allows 20x. `GET /v1/config` returns `markets.{BTC,ETH}` with `marginScaleBps`, `maxLeverage`, `initialMarginBps` and `maintenanceMarginBps` (first tier, scaled) plus the base `marginTiers`; `GET /v1/markets` repeats the four fields per market, and `GET /v1/account/:address` returns `marginParameters` per market and per-position `initialMargin` / `maintenanceMargin`, with liquidation estimates using the scaled maintenance rates.

## Resting limit orders

Version one should use all-or-none orders. This matches an RFQ maker's atomic fill model and avoids cumulative-fill accounting in the first release. A buy becomes eligible only when a fresh, size-specific maker ask is at or below the signed limit. A sell becomes eligible only when the fresh maker bid is at or above it. The trigger uses executable quoted price, not oracle mid. A brief oracle touch that the maker would not execute must not trigger an order.

The user signs a durable `TradeIntent` containing:

- account, market, signed exact base quantity and limit price;
- maximum total fee;
- reduce-only flag;
- order nonce and expiry;
- for trigger orders, the trigger price and direction (a separate `TriggeredTradeIntent` type, below);
- chain ID and clearing-contract address through EIP-712.

The signature does not bind an API leader epoch. Leader, approver-set and policy versions belong in the short-lived maker approval produced at execution. This lets a valid user order survive routine API failover while ensuring execution uses the current policy and signer set. Cancellation consumes the order nonce on-chain. An API-only cancellation is insufficient because an escaped signed execution bundle may still exist.

At trigger time the active order worker:

1. reads current chain state and a fresh authenticated oracle report;
2. obtains a size-specific firm quote using global settled and reserved exposure;
3. verifies the signed limit, fee cap, expiry and reduce-only condition;
4. reserves portfolio capacity and asks all three approvers in parallel;
5. submits after two matching approvals;
6. marks the order filled only after chain inclusion and reconciles by nonce after any ambiguous response.

The contract consumes the intent nonce atomically with settlement. The approvers independently reconstruct the same intent digest and current quote policy. The order database is an operational journal of signed orders and attempts; on-chain nonces and settlement events remain authoritative.

Partial fills should follow only after adding `filledBase` and `chargedFee` accounting keyed by the order digest. Each child fill must reduce remaining size, enforce the original aggregate fee ceiling and remain inside the limit. Splitting children cannot earn inventory credits or evade portfolio reservations.

## Trigger orders (stop-loss, take-profit, stop entry)

A trigger order is a signed `TriggeredTradeIntent`: the `TradeIntent` fields plus `triggerPrice` and `triggerAbove`, a separate EIP-712 primary type in the same domain, so it can never fill as a plain trade. It settles only through `executeTriggeredTrade`, which reverts `TriggerNotReached` unless the settlement report's mid, `(bid + ask) / 2`, is at or above (`triggerAbove`) or at or below the trigger price. A reduce-only trigger larger than the opposite position fills exactly the position (the contract clamps it), so a TP/SL signed for a whole position still closes what is left after a partial close and never flips it.

| Kind | Side | Fires when the mid is | Reduce-only |
| --- | --- | --- | --- |
| `stop-loss` | sell (closes a long) / buy (closes a short) | ≤ trigger / ≥ trigger | always |
| `take-profit` | sell / buy | ≥ trigger / ≤ trigger | always |
| `stop-entry` | buy / sell | ≥ trigger / ≤ trigger | optional (default off) |

The signed limit price is the trigger moved `slippageBps` (1–500, default 100) against the trader: `trigger × (1 − s)` for sells (floored), `trigger × (1 + s)` for buys (ceiled). The fee cap is 2 bps of the notional at `trigger × (1 + s)`. The leader holds placed orders in `resting_orders` (`order_type`, `trigger_json`) and re-arms them on restart. When the oracle mid crosses a trigger it prices the fill (clamped for reduce-only), requires the firm quote's touch to still satisfy the trigger and its price to respect the limit, then runs the market-order approval path with the trigger in the approver envelope; otherwise the order re-arms. A trigger that is reached but whose fill would break the signed limit (the price gapped through the slippage band) is never sent to the approvers: it stays `open` with `lastError` "triggered; waiting for the price to come back within the slippage limit" and fills if the price returns inside the band. A stop is therefore a stop-limit, not a stop-market; traders choose the band (0.5–5% in the app). Approvers recompute the triggered digest, check the trigger on the report they sign against (the adapter's consensus in signed mode) and evaluate economics, exposure and impact on the clamped fill derived from their own position read.

A TP/SL pair shares one nonce: the first leg to fill spends it and the other leg is marked `cancelled`; one nonce cancel cancels both. When a position closes (or flips), the leader marks that account's reduce-only trigger orders on that market `cancelled` (`lastError` "position closed") and never fires them. They remain signed and executable on chain until their deadline or a nonce cancel. A TP/SL is signed for the position size at the time; the contract clamps it down to a smaller position but never up, so after the position grows the order covers only part of it (the app flags it as partial and offers to replace it).

## Order and close API

All amounts are decimal USDC strings in requests and integer strings (USDC 1e6, base 1e18, prices 1e6) in responses.

- `POST /v1/quote` `{market, side, amount, slippageBps?}`: `slippageBps` (integer 1–500, default 8) sets the signed limit (`worstPrice`) beyond the expected price.
- `POST /v1/close/quote` `{account, market, fraction?}`: `fraction` in bps of the position (1–10,000, default 10,000), rounded toward zero; the quote is forced reduce-only. `409` when the position is flat or the fraction rounds to zero.
- `POST /v1/close/all/quote` `{account, fraction?}` → `{account, quotes: Quote[]}`: one reduce-only close quote per open position (empty when flat). Each is prepared (`/v1/prepare`) and signed separately; a session key can sign them without a wallet prompt.
- `POST /v1/orders/trigger/prepare` `{account, market, kind, side?, sizing?: "amount" | "position", amount?, triggerPrice, triggerAbove?, slippageBps?, durationSeconds, nonce, reduceOnly?}` → `{orderId, type, domain, types: {TriggeredTradeIntent}, intent, trigger: {triggerPrice, triggerAbove}, summary}`. `intent` is the full message to sign (including `triggerPrice` and `triggerAbove`). `amount` sizing needs `side` and sizes at the trigger price; `position` sizing closes the whole current position and derives the side. `triggerAbove`, when given, must match the kind. A trigger already reached at the current mid is rejected (`409`, e.g. "stop-loss price must be below the current price"). Rejections the API raises itself (no open position, nothing to reduce, wrong side, oracle or chain unavailable) return their message; anything else returns a generic error.
- `POST /v1/orders/tpsl/prepare` `{account, market, takeProfitPrice?, stopLossPrice?, slippageBps?, durationSeconds, nonce}` → `{pairId, nonce, orders: [takeProfit?, stopLoss?]}`, each shaped like a trigger prepare response, both reduce-only for the full position and sharing `nonce`.
- `POST /v1/orders` `{orderId, userSignature}` places a prepared limit or trigger order.
- `GET /v1/orders/:address` → `{items}`; each item has `orderId, type ("limit" | "stop-loss" | "take-profit" | "stop-entry"), market, side, amount, baseDelta, limitPrice, triggerPrice, triggerAbove, slippageBps, sizing, pairId, reduceOnly, maxFee, nonce, expiresAtMs, status, transactionHash, lastError` (trigger fields are `null` on limit orders).
- `POST /v1/orders/:orderId/cancel/prepare` → `{domain, types, intent, orderIds}` and `POST /v1/orders/:orderId/cancel` → `{orderId, status, cancelledOrderIds, transaction}`: the on-chain nonce cancel closes every order sharing the nonce. Both return `409` once the order is no longer open (filled, cancelled or expired).

## Methods adopted from established venues

- Variational separates index, mark, indicative quote and firm quote, and triggers RFQ limit orders on executable quoted price. That is the closest product match and supports the price model above.
- Hyperliquid separates robust oracle and mark prices, streams BBO/account/funding events, uses size-dependent margin and supports partial liquidation before a backstop. We retain directional external marks, tiered margin, explicit account health and bounded partial liquidation.
- dYdX evaluates liquidation at total account equity versus maintenance requirement and uses bounded protocol liquidation orders plus insurance. We retain account-level cross-margin eligibility, partial close and a separate insurance layer.
- Synthetix exposes total collateral, available/withdrawable margin, required margins, accrued funding/PnL and estimated fill/fees as first-class read functions. The API read model now exposes their equivalents without increasing clearing-contract bytecode.

We do not copy Hyperliquid's user leverage selector because it does not alter liquidation price for cross margin and adds ambiguity to this product. We do not copy an order book, isolated margin, multi-collateral valuation, or partial limit fills into launch scope. Those features add separate accounting and liquidation states before the core RFQ path has production evidence.

Primary references: [Variational RFQ prices](https://docs.variational.io/omni/trading/quoted-index-and-mark-prices), [Variational limit orders](https://docs.variational.io/variational-protocol/key-concepts/market-vs.-limit-orders), [Hyperliquid price indices](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/robust-price-indices), [Hyperliquid margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining), [Hyperliquid liquidations](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations), [dYdX liquidations](https://help.dydx.trade/en/articles/166991-liquidations-on-dydx-chain), and [Synthetix Perps V3 integration](https://docs.synthetix.io/developer-docs/for-perp-integrators/perps-v3).
