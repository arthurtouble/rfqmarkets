# Trading app

The customer trading terminal: order ticket, live chart, account and positions,
funds, quick trading and the public Markets page. React 19 + Vite, TanStack
Router and Query, wagmi/viem.

```
npm run dev:stack -- --web   # local chain, services and this app on :4173
npm run test:web             # unit tests for the pure modules in src/lib and src/wallet
npm run build:web            # production bundle in dist/web
```

## Layout

| Path | What it holds |
| --- | --- |
| `src/main.tsx` | Loads the settlement chain from `GET /v1/config`, then mounts the providers. |
| `src/router.tsx` | Shell and routes: `/trade/$market`, `/markets`. `/?view=markets` redirects. |
| `src/lib/` | Pure code: wire types, formatting, account marking, indicative quotes, SSE hook. |
| `src/wallet/` | wagmi config, the trader interface (browser wallet or local dev key), connect dialog, wallet menu, quick-trading key. |
| `src/data/` | The shared market stream, TanStack Query hooks and every user action. |
| `src/trade/`, `src/markets/`, `src/portfolio/`, `src/account/` | Pages and their components. |
| `src/positions/` | Open positions (table on desktop, cards on phones), the close sheet and close all. |
| `src/ui/` | Small shared primitives and toasts. |

## How data flows

- **Prices** come from one `EventSource` on the market gateway, shared through
  `MarketFeedProvider`. The ticket rebuilds an indicative quote locally on each
  tick with `packages/shared` pricing; the firm quote comes from `POST /v1/quote`.
- **Account, orders and indexer data** are TanStack queries. The indexer's
  update stream invalidates them, so nothing polls.
- **Actions** live in `data/actions.tsx`. Each one prepares an EIP-712 payload
  with the API, signs it through the trader, submits, shows a toast and
  refreshes the account. Only one action runs at a time.
- Streams reconnect with capped backoff after HTTP errors, which a bare
  `EventSource` does not do.

Production builds call services on the same origin through the Cloudflare edge
(`deploy/cloudflare/static/web-edge.mjs`). Dev builds use the local ports, or
`VITE_API_URL`, `VITE_INDEXER_URL` and `VITE_MARKET_STREAM_URL` when set.

## Data layer for the UI

Hooks and helpers the screens wire to. Amounts are bigint or decimal strings in
USDC 1e6 units, sizes in 1e18 base units, as everywhere else in the app.

**Markets and leverage** (`data/markets.ts`, `lib/leverage.ts`, `lib/markets.ts`).
Markets are registered on chain and can be added at any time; `Market` is a
string and `MARKETS` is only the launch fallback.

- `useMarketList()` → `{ markets, symbols, get(symbol), marketFromIndex(i), allMarketsMask }`; each market has `index, enabled, priced, maxLeverage, initialMarginBps, maintenanceMarginBps, marginScaleBps`.
- `useMarketLeverage(market)` → `{ maxLeverage, presets, … }`, e.g. presets `[2, 5, 10, 20]` on a 20x market.
- `useApiConfig()` → `GET /v1/config`, refreshed every minute.
- `sizeFromLeverage(marginMicro, leverage)` → notional; `marginFromLeverage(notional, leverage)` → margin.
- `leveragePresets(max, steps?)`, `maxLeverageAt(notional, scaleBps)` (falls as size reaches higher tiers), `clampLeverage(value, max)`.
- `estimateLiquidationPrice(account, snapshot, market, notionalDelta?)` (`lib/account.ts`) → pre-trade liquidation mid with the per-market scaled tiers. `markAccount` now fills `estimatedLiquidationPrice` and per-leg margins live.

**Quotes** (`lib/slippage.ts`). `marketOrder({ …, slippageBps })` and
`indicativeQuote(…, slippageBps)` accept 1..500 bps (default 8).
`parseSlippagePercent("0.5")` → `50`, `clampSlippageBps(n)`, `SLIPPAGE_PRESETS_BPS`.

**Trigger orders and TP/SL** (`useTrading()` in `data/actions.tsx`, checks in `lib/orders.ts`).

- `triggerOrder({ market, kind: "stop-loss" | "take-profit" | "stop-entry", side, amountMicro, triggerPriceMicro, slippageBps? })`, or `{ sizing: "position", … }` to close the whole position → orderId.
- `placeTpsl({ market, takeProfitMicro?, stopLossMicro?, slippageBps? })` → both legs' orderIds; one wallet prompt per leg, then both are placed.
- `cancelOrder(order)`: cancelling either TP/SL leg cancels both (shared nonce).
- `useOpenOrders(address, market?)` → open limit and trigger orders (`type`, `triggerPrice`, `triggerAbove`, `pairId`); `protectiveOrders(orders, market)`, `pairedOrder(order, orders)`.
- `tpslProblem(size, mid, tp?, sl?)` and `triggerProblem(kind, side, trigger, mid)` give the reason a price would be rejected, for inline validation.
- Orders are always signed with the wallet: `POST /v1/orders` accepts only the owner's signature, so the quick-trading key cannot place resting orders. (`sessionCoversDeadline` exists for when it can.)

**Closing.** `closePosition(market, fractionBps?)` closes a share (1..10,000 bps;
`closeFractionBps(percent)` converts) and `closeAll(fractionBps?)` closes every
position, one quote each, returning `{ closed, failed }`. Both sign with the
quick-trading key when the close is within its limits and markets, so they run
without prompts. `positions/Positions.tsx` wires them to the Close and Close all
sheets; `lib/positions.ts` has the display math (`positionView`, `closePreview`,
`closeAllPreview`, `fillAction`).

**Portfolio** (`data/queries.ts`, indexer). All keys sit under the account key,
so the indexer stream refreshes them when the account has activity.

- `usePortfolio(address)` → realized PnL, fees, funding, deposits, volume.
- `usePortfolioHistory(address, "event" | "1h" | "1d")` → `points` for the equity and PnL chart.
- `usePortfolioTrades(address, { market?, limit? })` and `useFundingHistory(address, …)` are infinite queries: `data.pages.flatMap(page => page.items)`, `fetchNextPage()`.
- The Portfolio page (`portfolio/`) draws the PnL chart from `pnlSeries` in `lib/portfolio.ts` and shows the Trades, Funding and Transfers tabs from `portfolio/History.tsx`.

**Candles** (`data/candles.ts`). `useLiveCandles(market, "1m" | "5m" | "15m" | "1h" | "4h" | "1d", limit?)`
→ `{ candles, … }` with the last bucket following the live stream (needs
`MarketFeedProvider`); `useCandles` is the plain query; `candleToNumbers` maps
to chart-library numbers.

**Quick trading** (`wallet/quick-session.ts`). The session grant covers every
registered market (`allMarketsMask(count)`); `sessionCovers(session, amount, marketIndex)`
is false for a market added after the grant.

## Wallets

The connect dialog lists three kinds of wallet:

- **Installed extensions** that announce themselves (EIP-6963), such as Rabby,
  MetaMask or Coinbase Wallet.
- **Base Account**, Coinbase's passkey smart wallet, on Base and Base Sepolia.
  Nothing to install. Contracts verify its signatures through ERC-1271 once the
  account is deployed, which its first transaction does.
- **WalletConnect** for phone and QR wallets. The public Reown project id is
  built in (`src/lib/env.ts`); `VITE_WALLETCONNECT_PROJECT_ID` overrides it,
  for example from the `WALLETCONNECT_PROJECT_ID` repository variable in the
  Cloudflare dev deploy.

The Base Account and WalletConnect SDKs load only when someone picks them, or on
reload when one was the last wallet used (`lazyConnector` in `src/wallet/chain.ts`).

The connect sheet is the shared `Sheet`, so it is a bottom sheet on phones.
Wallet errors (cancelled, unknown network, a request already open) go through
`walletErrorMessage` in `src/wallet/wallets.ts`. When the wallet is on another
network, `SwitchNetworkButton` sits next to the account button and the Account
page shows `WrongNetworkBanner`; both use `useSwitchNetwork`, which toasts a refusal.

`test/e2e/wallet-connect.spec.ts` drives all of this at phone and desktop sizes
with `test/e2e/mock-wallet.js`, an EIP-6963 wallet that signs through the local
Hardhat node (`npm run test:e2e -- wallet-connect`).
