# Product design system

The executable specimen is [`apps/design-system/index.html`](apps/design-system/index.html). Run `npm run dev:design-system` and open `http://127.0.0.1:4177`. It renders the actual foundations, typography, spacing, controls, tabular trading data and system states used by the product. Shared values live in `packages/design-system/tokens.css`; changes to either file must update the other in the same review.

Customer surfaces use near-black neutral layers, saturated periwinkle selection, aqua buy/healthy states and coral sell/danger states. Private operations surfaces use graphite, cyan and amber so screenshots cannot be confused with the trading product. IBM Plex Sans and IBM Plex Mono are bundled locally; no third-party font request is made at runtime.

## Product rules

1. Keep the current market, order type, direction, amount, price protection and primary action in one compact ticket.
2. Show index/oracle, maker bid/ask, funding and data freshness together. Never label an indicative price as executable.
3. Keep collateral, equity, margin usage, effective leverage, positions, orders and history visible without leaving trading.
4. Put advanced controls behind disclosure. Defaults must be safe and sufficient for a first trade.
5. Use aqua only for buys, positive balances and healthy state; coral only for sells, losses and dangerous state; periwinkle for selection and navigation.
6. Display numbers with tabular figures. Keep addresses, hashes and machine identifiers monospace.
7. Public protocol data may show finalized aggregate exposure. Exact hedge state, venue orders, thresholds and failures remain private.
8. Every loading, disconnected, guarded, reduce-only, rejected, pending, included and finalized state needs explicit text in addition to color.
9. Put the wallet control in the persistent top-right application slot. Keep market selection beside the live market context and synchronize that selection with the order ticket.
10. Charts are supporting context, not decoration. The launch chart is a lightweight line and area plot built from the same server-sent market stream that drives quotes, so the browser does not contact an exchange or oracle provider directly.

## Typography and density

The customer product uses IBM Plex Sans with IBM Plex Mono for prices, quantities and machine identifiers. It avoids rounded display fonts, oversized headings and decorative gradients. The visual hierarchy comes from weight, spacing, borders and a small semantic palette. Component corners are square; only status dots remain circular. The dense trading canvas stays readable at 390px without turning every value into a separate card.

The layout borrows the persistent market context and dense feedback of Hyperliquid, Variational's indicative-versus-firm distinction, dYdX's unified account workspace, and Synthetix's explicit margin and fee preview. It omits an order book, isolated leverage selector and broad conditional-order matrix until those concepts have native RFQ semantics and matching contract enforcement.

Primary references: [Hyperliquid order types](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types), [Variational quoted, index and mark prices](https://docs.variational.io/omni/trading/quoted-index-and-mark-prices), [Variational RFQ flow](https://docs.variational.io/variational-protocol/key-concepts/trading-via-rfq), [dYdX trading concepts](https://docs.dydx.xyz/concepts/trading), and [Synthetix Perps V3 integration](https://docs.synthetix.io/developer-docs/for-perp-integrators/perps-v3).
