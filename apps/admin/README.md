# Operations console

Two views for operators:

- **Hedging** (default): finalized customer exposure on Base next to the hedge venue's position, per market,
  with the hedger's recent orders. Read-only.
- **Markets and risk** (`#markets`): list markets and change their caps, risk parameters, spreads and
  reduce-only flag. Each change is a contract call signed by the operator's own wallet in the browser; the page
  holds no keys. Roles and the risk operator's envelope are described in
  [Risk operator and the market console](../../docs/operations/risk-operator.md).

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

The markets view reads `GET /v1/config` through the Vite dev server's proxy to the API and offers **Use local
operator**, which signs with the risk operator key the local deployment appoints (`/v1/dev/risk-operator`,
development builds and local chains only). With a browser wallet it uses that instead.

## On Cloudflare

`admin.rfq-markets.workers.dev` serves this app behind Cloudflare Access
(`deploy/cloudflare/static/private-edge.mjs`). The page's reads are same-origin paths; the edge checks
the Access token, then forwards `/v1/risk`, `/v1/updates/stream`, `/v1/config` and
`/ops/hedger/v1/status[/stream]` to the runtime, which adds the hedger's token itself. See
[the Cloudflare dev environment](../../deploy/cloudflare/DEV-ENVIRONMENT.md).

## Tests

`npm run test:ops-apps` covers the status rules, failure messages, number formatting and every panel state
(rendered without a browser), and the market controls' parsing, change plans and role and envelope checks
(`controls-model.test.ts`). `test/e2e/admin.spec.ts` signs real changes against the local chain.
