# Trading app

The customer trading terminal: order ticket, live chart, account and positions,
funds, quick trading and the public Markets page. React 19 + Vite, TanStack
Router and Query, wagmi/viem.

```
npm run dev:stack -- --web   # local chain, services and this app on :4173
npm run test:web             # unit tests for the pure modules in src/lib
npm run build:web            # production bundle in dist/web
```

## Layout

| Path | What it holds |
| --- | --- |
| `src/main.tsx` | Loads the settlement chain from `GET /v1/config`, then mounts the providers. |
| `src/router.tsx` | Shell and routes: `/trade/$market`, `/markets`. `/?view=markets` redirects. |
| `src/lib/` | Pure code: wire types, formatting, account marking, indicative quotes, SSE hook. |
| `src/wallet/` | wagmi config, the trader interface (browser wallet or local dev key), wallet menu, quick-trading key. |
| `src/data/` | The shared market stream, TanStack Query hooks and every user action. |
| `src/trade/`, `src/markets/` | Pages and their components. |
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
