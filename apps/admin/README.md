# Hedge operations dashboard

A read-only page for operators: finalized customer exposure on Base next to the hedge venue's position,
per market, with the hedger's recent orders. It holds no keys and has no controls.

| What it shows | Where it comes from |
| --- | --- |
| Customer collateral, longs and shorts per market | Indexer `GET /v1/risk?finalized=true`, re-read on every `indexed` event from `/v1/updates/stream` |
| Venue position, unhedged gap, action band, hedge state, trading mode, orders | Hedger `GET /v1/status/stream` (`services/hedger/src/server.ts`) |

The status pill reads **Connecting** until the first hedger frame, **Live** while the hedger reads exposure
on time, **Stale** when its last read is more than 10 seconds old, **Degraded** when the hedger reports
itself unhealthy (with its error), and **Reconnecting** or **Offline** when the stream is down. A banner
explains every non-live state in plain words, including runtime and Access failures.

Each market card shows the trading mode the API currently enforces (open, guarded or reduce-only), which
is the same rule set as the hedger's `/internal/risk`.

## Run it locally

```sh
npm run dev:stack      # chain, contracts and every service
npm run dev:admin      # http://127.0.0.1:4174
```

In development the page calls the indexer (`:4300`) and hedger (`:4400`) directly with the local
operations token. `VITE_INDEXER_URL`, `VITE_HEDGER_URL` and (development only) `VITE_HEDGE_OPS_TOKEN`
override them. A production build never contains a token.

## On Cloudflare

`admin.rfq-markets.workers.dev` serves this app behind Cloudflare Access
(`deploy/cloudflare/static/private-edge.mjs`). The page's reads are same-origin paths; the edge checks
the Access token, then forwards `/v1/risk`, `/v1/updates/stream` and `/ops/hedger/v1/status[/stream]` to
the runtime, which adds the hedger's token itself. See
[the Cloudflare dev environment](../../deploy/cloudflare/DEV-ENVIRONMENT.md).

## Tests

`npm run test:ops-apps` covers the status rules, failure messages, number formatting and every panel state
(rendered without a browser).
