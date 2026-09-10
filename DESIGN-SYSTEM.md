# Product design system

The shared tokens in `packages/design-system/tokens.css` define typography, surfaces, borders and semantic states. Customer surfaces use midnight blue, periwinkle, aqua and coral. Private operations surfaces use graphite, cyan and amber so screenshots cannot be confused with the trading product.

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

The customer product uses a neutral system sans stack with tabular numerals and a separate monospace stack for machine identifiers. It avoids rounded display fonts, oversized headings and decorative gradients. The visual hierarchy comes from weight, spacing, borders and a small semantic palette. Controls use 8–14px radii; the dense trading canvas stays readable at 390px without turning every value into a separate card.

The layout borrows the persistent market context and dense feedback of Hyperliquid, Variational's indicative-versus-firm distinction, dYdX's unified account workspace, and Synthetix's explicit margin and fee preview. It omits an order book, isolated leverage selector and broad conditional-order matrix until those concepts have native RFQ semantics and matching contract enforcement.

Primary references: [Hyperliquid order types](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types), [Variational quoted, index and mark prices](https://docs.variational.io/omni/trading/quoted-index-and-mark-prices), [Variational RFQ flow](https://docs.variational.io/variational-protocol/key-concepts/trading-via-rfq), [dYdX trading concepts](https://docs.dydx.xyz/concepts/trading), and [Synthetix Perps V3 integration](https://docs.synthetix.io/developer-docs/for-perp-integrators/perps-v3).
