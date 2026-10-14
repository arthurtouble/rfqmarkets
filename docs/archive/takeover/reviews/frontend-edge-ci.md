# RFQ Markets: frontend, Cloudflare edge and CI/CD audit

Repo: `/home/claude/rfqmarkets` (HEAD `bae3332`, clean tree). Audit date 2026-10-06. Read-only: no repo files changed. Builds went to the scratchpad, not `dist/`.

"Inferred" marks a conclusion drawn from code shape or platform behaviour rather than from something seen running.

---

## 0. Executive summary

- **Size.** All six frontends together are about 200 KB of source. `apps/web/src/TradePage.tsx` is the only substantial UI file: 269 lines and 38.9 KB, because much of it is written as single minified-style lines. There is no router, no data-fetching library, no wallet library, no component library, no linter, no formatter and no frontend tests.
- **Wallet integration** is raw `window.ethereum` (EIP-1193) plus lazily imported `ethers` v6. There is no EIP-6963 multi-wallet discovery, no WalletConnect and no smart-wallet support. The release checklist requires WalletConnect/mobile and ERC-1271 wallets, and none of these are possible today.
- **Edge.** A Cloudflare Worker (`deploy/cloudflare/static/web-edge.mjs`) serves the SPA and fails closed on an allow-list of `/v1/*` routes. Its wrangler config declares **no service bindings**, so every API, indexer and stream call on the deployed testnet returns `503 service_unavailable`. This is intentional and documented, but it means the public terminal cannot trade.
- **Runtime container.** The Worker + Durable Object + Container (`deploy/cloudflare/runtime/`) is wired up, but it is deliberately dead. Both `scripts/cloudflare-container.ts:2` and `scripts/prepare-cloudflare-runtime.ts:28` `throw` unconditionally because container disk is ephemeral. Nothing in CI deploys it.
- **CI/CD security issue (high, if the repo is public or accepts fork PRs).** `deploy-cloudflare.yml` uses `workflow_run` and checks out `github.event.workflow_run.head_sha`. Its only filter is `branches: [main]`, which matches the *head branch name*. A fork PR from a branch called `main` therefore runs `npm ci` and the build on attacker code while `CLOUDFLARE_API_TOKEN` is set in the job environment. Details in §3.
- **Results of what I ran:**
  - `npm run test:cloudflare-edge`: 10/10 pass.
  - `npm run typecheck`: pass.
  - All six `vite build`s: pass.
  - `validate-cloudflare-static`: pass.
  - Live URL checks: **blocked by the sandbox egress proxy** (403 on CONNECT), so live status is unverified.

---

## 1. Apps

All apps use Vite 8.2.2, React 19.2.8 (except exit and design-system), and TypeScript 7.0.2 checked by the root `tsconfig.json`, which includes `apps/**/*.ts(x)`. Fonts are self-hosted IBM Plex via `@fontsource`. Every app has its own `index.html`, `vite.config.ts` (exit has none) and `styles.css`. The only shared piece is `@import "../../../packages/design-system/tokens.css"` via relative path. There is no workspace or package boundary: `packages/*` have no `package.json` and are imported by relative path (`apps/web/src/TradePage.tsx:4-7`).

### 1.1 `apps/web`: customer trading terminal

- **Audience:** customers (public). It is deployed to Cloudflare as worker `rfq-markets-testnet`.
- **Files:**
  - `main.tsx` (23 lines): app shell and "router"
  - `TradePage.tsx` (269 lines)
  - `MarketsPage.tsx` (52 lines)
  - `config.ts` (21 lines): endpoints and formatters
  - `types.ts` (17 lines): hand-written wire types
  - `styles.css` (322 lines)
  - `public/_headers`: security headers

**Routing**

- Two views, `trade | markets`, held in `useState`. They are synced to `?view=markets` with `history.replaceState` (`main.tsx:10-16`).
- No history entries, so the Back button does not work. No path routes. No per-market URL (for example `/trade/BTC`).

**Pages and features**

- **Trade** (`TradePage.tsx`):
  - BTC/ETH selector (`:249`).
  - Market/limit order ticket with USDC amount, side, reduce-only and price details disclosure (`:232-247`).
  - Client-side indicative quote rebuilt on every stream tick *and* every 500 ms clock tick. It uses the shared pricing code (`constructQuote` from `packages/shared/src/pricing.ts`, `:92-94`).
  - Live SVG line chart from the SSE stream plus `/v1/markets/history` (`:29-32`, `:95-98`).
  - Account health and risk grid. Client-side mark-to-market is in `markAccount` (`:23-27`).
  - Tabs: positions, open orders, trade history, account history (`:252-266`).
  - Deposit panel (approve + deposit, owner-paid gas) and withdraw panel (EIP-712 signed, sponsored).
  - Close position: RFQ close quote, then signed TradeIntent with reduce-only.
  - Emergency close shown when the contract is paused (`:256`).
  - Limit orders: create and cancel.
  - "Quick trading": a session key generated in the browser and granted by an EIP-712 `SessionGrant`; revocation via `revokeSession` (`:195-224`).
- **Markets** (`MarketsPage.tsx`): public dashboard of finalized collateral, accounts, per-market long/short exposure bars, oracle mid / bid / ask / funding, open positions table (100 rows) and recent trades table (30 rows).

**Backend endpoints**

- In production all are same-origin `""` (`config.ts:1-5`).
- In dev: API `:4100`, indexer `:4300`, market gateway `:4500`, overridable with `VITE_API_URL`, `VITE_INDEXER_URL` and `VITE_MARKET_STREAM_URL`.

| Service | Method | Path | Used at |
|---|---|---|---|
| API | POST | `/v1/quote` | `TradePage.tsx:65` |
| API | POST | `/v1/prepare`, `/v1/approve` | `:136,141,182-184` |
| API | POST | `/v1/orders/prepare`, `/v1/orders` | `:149` |
| API | POST | `/v1/orders/{id}/cancel/prepare`, `/v1/orders/{id}/cancel` | `:152` |
| API | POST | `/v1/withdraw/prepare`, `/v1/withdraw/execute` | `:172-174` |
| API | POST | `/v1/close/quote`, `/v1/close/prepare`, `/v1/close/execute` | `:181,190-192` |
| API | POST | `/v1/session/prepare`, `/v1/session/execute` | `:198-200` |
| API | GET | `/v1/config` (chainId, rpcUrl, token, clearing) | `:111,157,208` |
| API | GET | `/v1/account/{addr}`, `/v1/orders/{addr}` | `:81-82` |
| API | GET | `/v1/markets` | `MarketsPage.tsx:33` |
| API | GET | `/v1/dev/wallet` (dev only, returns a **private key**) | `TradePage.tsx:101` |
| Indexer | GET | `/v1/protocol`, `/v1/account/{addr}/activity` | `TradePage.tsx:79-80` |
| Indexer | GET | `/v1/risk`, `/v1/positions`, `/v1/activity`, `/health` | `MarketsPage.tsx:28-31` |
| Indexer | SSE | `/v1/updates/stream` (event `indexed`) | `TradePage.tsx:102`, `MarketsPage.tsx:37` |
| Gateway | SSE | `/v1/markets/stream` (event `markets`) | `TradePage.tsx:96`, `MarketsPage.tsx:37` |
| Gateway | GET | `/v1/markets/history` | `TradePage.tsx:98` |

`/v1/dev/wallet` is served only when `localDevMode` (`services/api/src/server.ts:301`), and the edge denies it (test at `web-edge.test.mjs:78`). The web app still requests it on every load in production (`TradePage.tsx:101`). That produces a wasted 404 and uses one read rate-limit token per page view. It should be gated by `import.meta.env.DEV`.

**Wallet integration**

- Raw `window.ethereum` cast to a hand-written `WalletProvider` type (`types.ts:5`, `TradePage.tsx:107`).
- Connect calls `eth_requestAccounts`, then `wallet_switchEthereumChain`, falling back to `wallet_addEthereumChain` on error 4902 (`:105-122`).
- Signing uses `eth_signTypedData_v4` with a hand-built `EIP712Domain` (`:123-128`).
- `ethers` is dynamically imported for:
  - `BrowserProvider` and `Contract` for deposit (`:158`)
  - `SigningKey` and `TypedDataEncoder` for quick-session signing (`:138`)
  - `computeAddress` (`:198`)
- The revoke calldata is hand-encoded with the selector `0x1fa5d6a4`, which I verified equals `revokeSession(address)` (`:209`). Its receipt is polled through `provider.request` (`:214-221`).
- **No EIP-6963 provider discovery.** With several extensions installed, whichever wins `window.ethereum` is used.
- **No WalletConnect / mobile, no Coinbase Smart Wallet, no ERC-1271.** The header "Connect wallet" button finds the in-ticket button with `document.querySelector(".trade-wallet").click()` (`main.tsx:18`). Wallet state lives in `TradePage` and is lifted up through `onWalletChange`.
- **Dev mode:** if `/v1/dev/wallet` returns a key, the app signs with an in-memory `ethers.Wallet` (`:101,106,124`).
- **Quick session:**
  - The private key is in React state only.
  - `sessionStorage` stores only `{account, sessionAddress, validUntil}` (`:200`). After a reload the session is "restored" without a key (`:119`), so trades silently fall back to wallet popups while the button still says "Revoke quick trading". Inferred UX gap.
  - `UX-AND-INTENT.md` says the key lives in `sessionStorage`. That doc is stale relative to the code.
  - The 2,500 USDC client-side cap (`:138`) duplicates the hard-coded grant terms `maxTradeAmount:"2500"`, `maxCumulativeAmount:"10000"` and `maxFee:"5"` (`:198`).

**State management**

- About 25 `useState` hooks in one component (`TradePage.tsx:36-62`), with `useRef` generation counters to drop stale account reads (`:75-90`).
- No cache, no request dedupe, no retry or backoff. Every `indexed` SSE event that touches the account triggers four parallel fetches (`:79-82`).
- `MarketsPage` re-fetches four indexer endpoints on *every* `indexed` event that has `changed` set (`MarketsPage.tsx:38`).

**Bugs and risks found (web)**

1. **SSE never recovers from HTTP errors (inferred from EventSource semantics).** `EventSource` reconnects automatically only after network errors. A non-200 response (the edge's 429 `rate_limit_exceeded`, a 503, a 404) sets `readyState=CLOSED` permanently. The terminal then shows "Reconnecting" forever and quotes stay disabled. Affected code: `TradePage.tsx:96`, `:102` and `MarketsPage.tsx:37` never recreate the stream. With the testnet's missing bindings, that is every load today.
2. **Re-render every 500 ms of the whole 269-line component** via `setClock` (`:100`). The indicative quote, including BigInt pricing math, is recomputed twice a second even when idle.
3. In `markAccount` (`:25`) notional uses `live.ask` for both long and short. The mark uses bid for longs and ask for shorts. This is a minor inconsistency in client-side margin estimates (inferred; the server is authoritative).
4. Limit price defaults to the hard-coded `"95000"` (`:50`) until the user clicks "Limit". For ETH this produces a wildly wrong default.
5. Status strings are compared by literal text to decide whether to overwrite them (`:93`). This is fragile and blocks i18n.
6. Deposit is approve + `deposit()` with owner-paid gas (`:154-167`). The documented sponsored EIP-3009 path (`WALLET-AND-DEPOSITS.md`, `UX-AND-INTENT.md` §Deposits) is not implemented in the UI.
7. Documented UX that is not implemented:
   - order states `Preparing → Submitted → Executed → Settled` (`UX-AND-INTENT.md` §Order states)
   - advanced slippage/lifetime settings "saved per browser/account"
   - worst-price line in the confirmation
   - a "subaccount" selector
8. CSP in `index.html:3` (meta) includes `http://127.0.0.1:*` and `ws://localhost:*` in `connect-src`. That ships to production. The `_headers` CSP is stricter and both policies apply, so the effective policy is their intersection. The result is harmless, but the meta tag should be dev-only.

**Bundle (production build):**

- `index-*.js`: 236.0 KB raw / 72.7 KB gzip
- lazy `lib.esm-*.js` (ethers): 332.2 KB / 127.6 KB gzip
- CSS: 28.4 KB / 6.5 KB gzip
- Fonts include Cyrillic, Greek and Vietnamese subsets (about 120 KB of woff2 that are not needed). `dist/web` is 1.0 MB on disk.

### 1.2 `apps/admin`: hedge operations dashboard

- **Audience:** internal operators. Not deployed. CI excludes it until Cloudflare Access exists (`CLOUDFLARE-DEPLOYMENT.md` §GitHub CI/CD).
- **Code:** one 15-line, roughly 6 KB file, `apps/admin/src/main.tsx`. It is read-only by design (footer: "No trading keys or control actions…").
- **Features:** customer collateral, hedge mode, finalized block, and per-market customer long/short vs venue hedge with gap, gap notional, band and state. Recent hedge orders table.
- **Endpoints:**
  - indexer `GET /v1/risk?finalized=true`
  - SSE `/v1/updates/stream`
  - hedger `GET /v1/status/stream`, read with a hand-rolled `fetch` + `ReadableStream` SSE parser so it can send an `Authorization` header (`main.tsx:14`)
- **Security issue: `VITE_HEDGE_OPS_TOKEN` is baked into the static bundle** (`main.tsx:10-11`). Any build that sets it publishes the bearer token to anyone who can fetch the JS.
  - In dev it defaults to `local-development-hedge-token`. I checked that the string is not present in a production build.
  - The intended production mode uses cookies (`credentials:"include"` when no token is set). That is correct, but nothing prevents a token build. The fix is to remove the env var and rely on Cloudflare Access (`CF_Authorization` cookie / JWT validated by the hedger).
- **Routing:** none. **State:** `useState`. **Wallet:** none.
- No `public/_headers`, so it would ship with no CSP.

### 1.3 `apps/docs`: public docs

- **Audience:** public. Deployed as worker `rfq-markets-docs-testnet`.
- **Content:** five pages (Overview, Trading, Margin, Security, Transparency) hard-coded as JSX in `apps/docs/src/main.tsx:2-7`.
- **Routing:** none. Page choice is `useState` (`:9`). There are no URLs per page, so pages cannot be deep-linked, Back does not work, and search engines see an empty client-rendered shell (no SSR or prerender).
- **Bug: `<a href="/">Open app ↗</a>` (`main.tsx:9`) links to the docs site's own root.** Docs run on a separate worker and hostname, so this never reaches the trading app.
- **Bundle:** 196.7 KB JS (62 KB gzip) to render about 3 KB of prose. React is overkill for this.
- Has `public/_headers` with a strict CSP (`connect-src 'self'`).

### 1.4 `apps/internal-docs`: operations manual

- **Audience:** internal. Not deployed; withheld until Access is configured. `wrangler.internal-docs.jsonc` exists, but no workflow uses it.
- **Content:** imports 31 root `*.md` files with `?raw` (`documents.ts:1-31`). It has a category nav, full-text substring search (`main.tsx:11`) and a **custom 20-line Markdown renderer** (`Markdown.tsx`).
- The renderer has no nested lists, no emphasis with `_`/`*`, no images, no mermaid (several docs use mermaid, for example `EDGE-AND-ORIGIN-PRIVACY.md`), no heading anchors in the nav, and no syntax highlighting.
- Cross-doc links work only through the hard-coded `fileIds` map (`main.tsx:10`). New docs need edits in two places.
- **Bundle: 561.7 KB JS** (193 KB gzip), with a Vite >500 KB warning. All markdown is inlined in JS. There are no per-page URLs.
- `index.html` has `noindex`. There is no `_headers`.
- Note the security posture: the bundle is the full architecture, plus testnet addresses and runbooks. The doc correctly says "publish only behind Cloudflare Access".

### 1.5 `apps/exit`: direct contract exit (censorship-resistance escape hatch)

- **Audience:** customers when the API or edge is down. It is required by `EDGE-AND-ORIGIN-PRIVACY.md` ("Publish a second static frontend…") and by the release checklist ("Keep the direct contract exit interface independently hosted and reproducibly built").
- **Code:** vanilla TS plus `ethers` (`apps/exit/src/main.ts`, 24 lines), with no React and no `vite.config.ts`.
- **Configuration:** baked in at build time through `VITE_EXIT_CHAIN_ID` and `VITE_EXIT_CLEARING_ADDRESS` (`main.ts:3`). Without them, actions are disabled (`:9,18`).
- **Features:** connect and read state (raw `JSON.stringify` dump into a `<pre>`, `:15`), `withdraw`, `cancelNonce`, `revokeSession`, `closePosition(market, proof)` with oracle `updateFee` (`:24`), and `claimResolution`.
- **Critical UX gap:** "Close paused position" requires the user to **paste a raw hex Pyth update proof** (`index.html` textarea `#proof`). An ordinary user cannot get one when the operator's stack is down. The app should fetch it client-side from the public Pyth Hermes endpoint, given a feed id that is pinned at build time (inferred requirement).
- **Not deployed anywhere.** It has no wrangler config, no `_headers` and no CI build artifact. `npm test` builds it to `dist/exit` and then discards it. Bundle: 261 KB / 96.7 KB gzip (full ethers, no tree-shaking benefit).
- Good points: CSP meta with `base-uri 'none'`; it checks the chain id and that code exists at the address (`:11-12`).

### 1.6 `apps/design-system`: specimen

- **Audience:** internal designers and engineers. Static HTML specimen (`index.html`, 53 lines) plus CSS. Not deployed.
- It documents colours, type, controls, data and states. However, the specimen's CSS is *its own copy* of the component styles (`apps/design-system/src/styles.css`), not the CSS the product uses, so it can drift. `DESIGN-SYSTEM.md` acknowledges this ("changes to either file must update the other").
- `packages/design-system/tokens.css` (18 lines) holds the colour, font and radius tokens plus the global `:focus-visible` style.
- **Token adoption is low.** Counts of hard-coded hex values vs `var(--…)` uses:

| App | Hard-coded hex | `var(--…)` |
|---|---|---|
| web | 195 | 41 |
| internal-docs | 47 | 4 |
| design-system | 14 | 71 |
| admin | 7 | 24 |
| docs | 4 | 17 |
| exit | 4 | 0 (does not import tokens) |

- There are no spacing or typography tokens, even though the specimen claims a 4 px spacing scale.

---

## 2. Cloudflare deployments

### 2.1 Inventory

| Worker name | Config | Serves | Deployed by | URL |
|---|---|---|---|---|
| `rfq-markets-testnet` | `deploy/cloudflare/static/wrangler.web.jsonc` | `dist/web` assets + `web-edge.mjs` | **CI** (`deploy-cloudflare.yml:29-31`) | `https://rfq-markets-testnet.rfq-markets.workers.dev` (per `CLOUDFLARE-DEPLOYMENT.md`) |
| `rfq-markets-docs-testnet` | `wrangler.docs.jsonc` | `dist/docs`, assets only, SPA fallback | **CI** (`:32-33`) | `https://rfq-markets-docs-testnet.rfq-markets.workers.dev` |
| `rfq-markets-internal-docs-testnet` | `wrangler.internal-docs.jsonc` | `dist/internal-docs` | Manual / not yet (Access prerequisite) | none |
| `rfq-markets-runtime-testnet` | `deploy/cloudflare/runtime/wrangler.jsonc` | Worker + DO-backed Container (`Dockerfile.cloudflare`) | Manual only; currently **cannot run** (entrypoint throws) and requires Workers Paid | would default to `rfq-markets-runtime-testnet.rfq-markets.workers.dev` (inferred; `workers_dev` not disabled) |

- No custom domains or `routes` are configured anywhere.
- All configs use `compatibility_date: 2026-09-11`, and observability is on with 100 % head sampling.
- **Live check:** `curl` to both URLs, `/edge/health`, `/v1/markets` and the runtime URL failed with `CONNECT tunnel failed, response 403` from the sandbox egress proxy. Liveness could not be verified from here.

### 2.2 Public edge worker logic (`deploy/cloudflare/static/web-edge.mjs`)

**Routing**

- Allow-listed routes only (`:2-23`).
  - Read routes (GET/OPTIONS):
    - `/v1/account/{addr}/activity`, `/health`, `/v1/(activity|positions|protocol|risk|updates/stream)` go to `INDEXER`.
    - `/v1/markets/(stream|history)` goes to `MARKET_GATEWAY`.
    - `/v1/(config|markets)` and `/v1/(account|orders)/{addr}` go to `API`.
  - Write routes (POST/OPTIONS) go to `API`: quote, prepare, approve, orders, withdraw/session prepare|execute, nonce cancel, close prepare|execute|quote, and order cancel.
- Anything else under `/v1/`, `/internal/` or `/approve` returns 404 `route_not_allowed` (`:81`). Non-GET/HEAD returns 405. Everything else goes to `env.ASSETS` with SPA fallback (`:83`).
- `/edge/health` reports which bindings exist (`:43-53`).

**Admission and forwarding**

- Admission runs `admitAtEdge` before forwarding (`:57`, see `deploy/cloudflare/runtime/edge-admission.mjs`):
  - It requires `cf-connecting-ip`, otherwise 403.
  - It picks the per-client limiter (`PUBLIC_READ_LIMIT` 600/min, `PUBLIC_WRITE_LIMIT` 120/min) and the "global" limiter (`GLOBAL_*` 12,000 / 2,400 per min) keyed `'public-origin'`.
  - It fails closed with 503 if bindings are missing or throw, and returns 429 with `retry-after: 10` when the limit is exceeded.
- Forwarding (`:58-78`) sets `x-request-id` from `cf-ray`, forwards the original request (method, body and all headers) to the service binding, and turns a missing binding into 503 with `retry-after: 5` and an upstream throw into 503 with `retry-after: 1`.

**Findings**

- **E1. No service bindings are declared** in `wrangler.web.jsonc`: no `services: [...]` for `API`, `INDEXER` or `MARKET_GATEWAY`. The deployed terminal therefore returns 503 for all data. This matches the documented status: "trading remains disabled until … bindings are live".
  - The edge expects three bindings, but the runtime worker is a single worker that routes by port (`runtime/routing.mjs`). When it is wired, all three bindings would point at `rfq-markets-runtime-testnet` (inferred).
- **E2. Requests are double-counted against the same rate-limit namespaces (inferred).** The runtime worker calls `admitAtEdge` again (`runtime/worker.mjs:20`) with **identical `namespace_id`s** `84532001..4` (`runtime/wrangler.jsonc:15-20` vs `static/wrangler.web.jsonc:11-16`). Once wired via service binding, each request is counted twice and the effective budgets halve.
- **E3. The "global" limiter is not global (inferred from Cloudflare Rate Limiting binding semantics).** Workers rate-limit counters are local to each Cloudflare location, so `GLOBAL_*` is a per-colo budget, not an origin-wide cap. The doc wording "distributed budgets" (`edge-admission.test.mjs:6`) overstates it.
- **E4. SSE connections are admitted once and then unbounded in duration and count.** There is no per-IP concurrent-stream cap at the edge. `packages/shared/src/connection-budget.ts` exists server-side, but it is not enforced at the edge.
- **E5. Missing controls that `EDGE-AND-ORIGIN-PRIVACY.md` calls for:**
  - no request body-size limit
  - no explicit `cache-control: no-store` on proxied API responses (pass-through only)
  - no `no-transform` on signed JSON
  - OPTIONS is counted as a write (`edge-admission.mjs:6`)
- **E6. The runtime worker is publicly reachable on `workers.dev`.** There is no `"workers_dev": false` or `"preview_urls": false` in `runtime/wrangler.jsonc`, so the "private service binding" architecture can be bypassed. The runtime repeats the same allow-list and admission checks, which limits the damage. It should still be private.
- **E7. The edge-routing doc is stale.** `EDGE-AND-ORIGIN-PRIVACY.md` describes `/api/*`, `/stream/*`, `/index/*` prefixes, a Cloudflare Tunnel, and **Chainlink Data Streams**. The code uses flat `/v1/*` routes, service bindings/Containers and Pyth (`apps/exit/src/main.ts:24` `updateFee`, `prepare-cloudflare-runtime.ts:9` `PYTH_API_KEY`).
- **Good:** the allow-list is tested to deny `/v1/dev/wallet`, `/internal/*`, wrong methods and unknown routes before reaching origin or assets (`web-edge.test.mjs:76-79`). Missing bindings never fall through to an HTML 200.

**Static headers** (`apps/web/public/_headers`, `apps/docs/public/_headers`)

- CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, Permissions-Policy, and immutable caching for `/assets/*`.
- `scripts/validate-cloudflare-static.mjs` checks the six headers exist for web and docs only, and that `dist/web` has no `127.0.0.1|localhost:4100|4300|4500` strings.
- HSTS has no `preload`.
- `style-src 'unsafe-inline'` is needed only for React `style={}` (web exposure bars). It could be removed with CSS custom properties.
- Admin, internal-docs and exit have no `_headers`.

### 2.3 Runtime worker + Durable Object + Container (`deploy/cloudflare/runtime/`)

- `worker.mjs`:
  - `RFQRuntimeContainer extends Container`, with `defaultPort 4100` and `requiredPorts [4100, 4201, 4202, 4203, 4300, 4400, 4500]`. The ports are API, the three approvers, indexer, hedger and gateway (`:6-12`).
  - `sleepAfter "24h"` and `enableInternet true`.
  - Env comes from the single secret `RFQ_RUNTIME_ENV_JSON`.
  - `fetch` maps path to port through the same allow-list (`routing.mjs`), runs admission, then `getContainer(env.RFQ_RUNTIME, "base-sepolia-primary")` (a singleton DO) and `switchPort` (`:17-23`).
- `wrangler.jsonc`:
  - container image built from `../../../Dockerfile.cloudflare`, `max_instances: 1`, `instance_type: basic`
  - DO binding `RFQ_RUNTIME`, SQLite migration `v1`
  - the same four rate-limit bindings
- `Dockerfile.cloudflare`:
  - `node:24-bookworm-slim` **not digest-pinned** (contrast `Dockerfile.host`, which supply-chain evidence requires to be pinned)
  - `npm ci --include=dev`
  - Python venv for the Hyperliquid SDK
  - `CMD node --import tsx scripts/cloudflare-container.ts`
- **Status:** `scripts/cloudflare-container.ts:2` throws `"Financial runtime requires persistent journals; Cloudflare Container disk is ephemeral…"`. The container would crash-loop by design.
- `scripts/prepare-cloudflare-runtime.ts` builds `.local-state/cloudflare-runtime-secret.json` from an allow-list of env keys. It also includes `RFQ_TESTNET_IDENTITIES_JSON`, which contains the sponsor, **all three approver** identities and the Hyperliquid agent (`:24`; the identity type has `privateKey`, see `prepare-testnet-identities.ts:6`). It then throws at `:28`.
- The design therefore puts all three approver keys, the sponsor and the hedge agent into **one container's environment**. That collapses the 2-of-3 quorum into one trust domain. Acceptable only as an explicitly labelled testnet convenience. It is disabled today, which is correct.
- **Required secrets and vars:**
  - Runtime worker: `RFQ_RUNTIME_ENV_JSON` (Worker secret, uploaded manually; inferred `wrangler secret put`).
  - Static workers: none.
  - GitHub environment `testnet`:
    - secret `CLOUDFLARE_API_TOKEN`
    - vars `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DEPLOY_ENABLED=true`
  - Account must be on **Workers Paid** for Containers (the doc says the account is on Free today).

---

## 3. CI/CD

| Workflow | Trigger | Does | Gates |
|---|---|---|---|
| `.github/workflows/ci.yml` | `pull_request` (all), `push` to `main` | single job, Node 24: `npm ci` → `npm audit --omit=dev --audit-level=low` → `npm test` (contracts e2e, upgrade validation, Python sim, service tests, edge tests, typecheck, all 6 builds, static validation) | merge (if branch protection requires it; not visible in repo) and the deploy workflow |
| `.github/workflows/deploy-cloudflare.yml` | `workflow_run` of CI completed on `main`; `workflow_dispatch` | job `public-static` in env `testnet`: `npm ci`, typecheck, build web+docs, `wrangler deploy --dry-run` then deploy for web and docs | `vars.CLOUDFLARE_DEPLOY_ENABLED=='true'` and (dispatch or CI success) |
| `.github/workflows/release-image.yml` | `workflow_dispatch` (input `publish`) | `validate`: build `Dockerfile.host`, Grype scan → SARIF → `scripts/vulnerability-gate.mjs` (high severity, expiring exceptions from `security/vulnerability-exceptions.json`). `publish`: push to GHCR with provenance + SBOM, rescan, gate, SPDX SBOM, cosign keyless sign + attest, `evidence:supply-chain`, checksums | `validate` only on `refs/heads/main`; `publish` needs `validate` |
| `.github/dependabot.yml` | weekly | npm (limit 5), github-actions (limit 3) | |

Release scripts:

- `scripts/check-release.ts` is a 4-line wrapper around `release-evidence.js`.
- `scripts/production-topology.ts` is a zod schema that enforces three approvers on distinct host, provider and failure domain, private ingress, a keeper independent from the API, two independent RPCs, `edge.authenticatedOrigins`, `directExitSeparateOrigin`, encrypted backup and independent paging.
- None of these release gates run in CI. They are manual release-checklist steps.

**Findings**

- **C1 (high if public/forkable): `workflow_run` pwn-request pattern.**
  - `deploy-cloudflare.yml:4-7,22` checks out `github.event.workflow_run.head_sha`. `branches: [main]` filters on the head branch *name*, which a fork PR can also be called.
  - `CLOUDFLARE_API_TOKEN` is set at **job level** (`:34-36`), so it is present during `npm ci`, which runs dependency lifecycle scripts, and during `vite build`, which runs attacker-controlled `vite.config.ts`.
  - Fix:
    - add `github.event.workflow_run.event == 'push' && github.event.workflow_run.head_repository.full_name == github.repository`
    - move the token `env` to the two `wrangler deploy` steps only
    - use `npm ci --ignore-scripts`
    - add required reviewers on the `testnet` environment
- **C2.** `workflow_dispatch` deploys `github.sha` of any selected branch with no CI gate. The deploy job does not run `validate:cloudflare-static` or `test:cloudflare-edge` itself.
- **C3.** `release-image.yml:55` `actions/setup-node@820762…` is pinned to a SHA but has no version comment. All other actions are SHA-pinned with comments, which is good. The publish job **rebuilds** the image rather than promoting the scanned `validate` image. It rescans, so it is safe but not "build once".
- **C4.** Dependabot does not cover `pip` (`services/hedger/requirements*.txt`) or `docker` (`Dockerfile.host`, `Dockerfile.cloudflare`).
- **C5.** There is no lint or format job, no CodeQL or secret scanning workflow, no frontend unit or e2e (Playwright) tests, no bundle-size budget, no Lighthouse or axe a11y check, and no preview deployments per PR. Wrangler `versions upload` plus preview URLs would give these cheaply.
- **C6.** CI is one serial 20-minute job (contracts e2e through builds). Splitting it into parallel jobs (contracts, python, services, frontend) would cut wall time and make failures easier to read. `wrangler` is `^4.131.0` (caret) while everything else is exact-pinned.
- **C7.** The runtime worker and internal-docs have no CI deploy path. That is intentional, but it also means `wrangler deploy --dry-run` is never exercised for them, so config rot such as a missing DO migration would go unnoticed. Add dry-runs to CI.

---

## 4. Code quality, duplication, accessibility, UX

**Code style**

- Much of the frontend is written as minified one-liners. Examples:
  - `apps/admin/src/main.tsx:14` is a single line of about 5 KB containing the whole app.
  - `TradePage.tsx:93,96,101-103,138,198,200,249-266`
  - `MarketsPage.tsx:49-50`
  - `apps/docs/src/main.tsx:9`
  - all CSS in docs, internal-docs and design-system
- Readability and review-ability are poor, and diffs are line-noisy. There is no Prettier or ESLint to normalize it.

**Duplication (DRY opportunities)**

- Formatters are duplicated:
  - `dollars`/`usd`/`inputDollars`/`decimal`/`base` in `web/config.ts:7-13`, `web/TradePage.tsx:11-14` and `admin/main.tsx:12-13`
  - `shortAddress` in `web/config.ts:15` and inline in `web/main.tsx:18` and `TradePage.tsx:245`
- The `Risk` type is duplicated in `web/types.ts:11-12` and `admin/main.tsx:7`. All wire types are hand-written instead of derived from the API's zod schemas (`zod` is already a dependency).
- `MARKET_STREAM` and `INDEXER` SSE handling is duplicated between TradePage, MarketsPage and admin, each with different error handling.
- Five nearly identical `vite.config.ts` files. Docs and internal-docs have no dev port pinned in config; the port is set in `package.json`.
- Font imports are repeated in five entry files. Each app ships the full Plex subset set.
- Brand mark, sidebar shell and doc layout are duplicated between docs and internal-docs with different palettes.
- Button, segmented control, tabs, input-with-suffix and table styles are re-implemented in web CSS, design-system CSS and admin CSS.
- `packages/shared` is consumed via `../../../packages/shared/src/*.js` relative imports. It is not a workspace package, so there is no `exports` map and no boundary between browser-safe and Node-only modules.

**Accessibility**

- Tabs (`TradePage.tsx:252`, design-system tabs) are plain buttons: no `role="tablist"`/`tab`, no `aria-selected`, no arrow-key navigation.
- The Buy/Sell and Market/Limit toggles have no `aria-pressed`.
- Docs and internal-docs navs are `<button>`s, not links, so pages cannot be opened in a new tab and have no URL.
- Only the main ticket status has `aria-live` (`:242`). Deposit and withdraw status (`:244,255`) and the admin error alert are not announced.
- The labels "Amount" and "Limit price" are `<label>` elements not tied to inputs; `aria-label` is used instead (`:236-237`). The deposit label (`:244`) is unassociated.
- Ten 10 px and seven 11 px font-size rules in web CSS are small for dense financial data.
- Contrast is fine. I computed `--text-dim #748099` on `#05070d` at 5.07:1, `#ff3f69` at 5.91:1 and `#7185ff` at 6.24:1.
- There is no `prefers-reduced-motion` handling. Motion is minimal, so this is low impact.
- Global `:focus-visible` exists in tokens. The `.amount` input uses `outline:0` but `.amount:focus-within` provides the visible focus, which is OK.
- The price chart has `role="img"` plus a descriptive `aria-label`, which is good.

**UX gaps**

- No onboarding: a user without USDC sees no faucet link and no network guidance on testnet.
- No toasts or transaction history with explorer links. Only a 10-character hash appears in the status text.
- No confirmation step showing worst price and fee before the wallet prompt.
- Errors surface raw server `error` strings.
- No empty, connecting or disconnected states for the wallet beyond the button text.
- The Markets page shows "Waiting for live prices…" indefinitely when the stream is dead (see SSE bug).
- No per-market URL, no deep link to an order, no mobile wallet path.
- The docs "Open app" link is broken (§1.3).
- The exit app needs a pasted oracle proof (§1.5).

---

## 5. Tech stack assessment and recommended upgrades

Current stack: React 19, Vite 8, TS 7, raw EIP-1193, ethers 6 lazily, `useState` for everything, hand-written CSS with partial tokens, a hand-rolled markdown renderer, Workers Static Assets with an edge Worker. The base (Vite + React 19 + TS + Workers assets) is modern and fine. What is missing is the application layer.

Recommendations, in priority order:

1. **Wallet: wagmi v2 + viem + a connector UI** (RainbowKit, ConnectKit or Reown AppKit). The release-checklist and wallet-doc requirements make this a must:
   - EIP-6963 discovery, WalletConnect v2/mobile, Coinbase Smart Wallet, ERC-1271/6492 signature handling
   - chain switching, account and chain change events
   - typed `signTypedData` and `writeContract`/`waitForTransactionReceipt`
   - This replaces `TradePage.tsx:103-128,154-167,203-224` and the hand-encoded selector.
   - Replace ethers with viem in web and exit. That cuts the 128 KB gzip ethers chunk to roughly 30-50 KB of tree-shaken viem (inferred). Exit becomes `viem` + `@wagmi/core` without React.
   - Keep the `WalletProvider` abstraction from `WALLET-AND-DEPOSITS.md` as a thin adapter, so Privy or Dynamic embedded wallets can be added later behind the same wagmi connector interface. Both ship wagmi connectors (inferred).
   - Quick-session keys: use viem `privateKeyToAccount` and keep the key in a non-extractable WebCrypto key where possible (`UX-AND-INTENT.md` asks for this). Evaluate ERC-7715 / wallet `wallet_grantPermissions` when available.
2. **Data: TanStack Query v5.**
   - Use it for `/v1/config` (fetch once, `staleTime: Infinity`), account, orders, activity, risk and positions, with dedupe, retry, backoff and `invalidateQueries` driven by the indexer `indexed` SSE events.
   - Wrap SSE in one `useEventStream` hook that handles reconnection, exponential backoff, recovery from HTTP errors and `Last-Event-ID`, shared by web and admin.
   - Mutations (`prepare` → sign → `approve`) become `useMutation` with explicit state machines for Preparing/Signing/Submitted/Executed/Settled. XState or a small reducer would do.
3. **Routing: TanStack Router** (type-safe search params, which fits `market`, `side` and `orderType` in the URL), or React Router v7 in SPA mode. Routes:
   - `/trade/:market`
   - `/markets`
   - `/portfolio`
   - `/portfolio/orders`
   - `/portfolio/history`
4. **Typed API client.** Export the zod schemas from `services/api` and `services/indexer` into `packages/api-contract`, then generate TS types (or use `zod` inference directly) and a typed fetch client. This removes `apps/web/src/types.ts` drift.
5. **Styling and components.** Keep the strong, distinctive design language (square corners, Plex, semantic colours). Make the tokens the single source of truth:
   - Option A (lowest churn): CSS Modules + a `@rfq/ui` package of primitives built on **Radix UI / React Aria** for tabs, toggle groups, dialogs, tooltips, select and toast. This fixes the a11y gaps for free.
   - Option B: Tailwind v4 with the tokens declared in `@theme`, plus shadcn/ui-style Radix primitives restyled square.
   - Either way, the design-system specimen should render the *real* components, via Storybook or Ladle, instead of a parallel HTML copy.
   - Subset fonts to Latin + Latin-ext (`@fontsource-variable/ibm-plex-sans/wght.css` → `latin` subset files).
6. **Docs: merge `apps/docs` and `apps/internal-docs` into Astro Starlight** (my preference: static HTML, built-in search via Pagefind, sidebar from the filesystem, MDX, mermaid via a plugin, i18n-ready, zero JS by default). VitePress is the alternative.
   - Two builds from one content tree: `public` (customer docs) and `internal` (all 31 `*.md` plus runbooks), with internal deployed only behind Cloudflare Access.
   - Fixes deep links, SEO, the 562 KB bundle, the custom markdown renderer, the missing mermaid support and the cross-link map.
7. **Cloudflare hosting.** Stay on **Workers Static Assets** (Cloudflare's recommended successor to Pages). The edge Worker is needed for same-origin API routing anyway.
   - Add `services` bindings, `workers_dev: false` on the runtime, `preview_urls`, and custom domains such as `app.`, `docs.`, `ops.` and `exit.`.
   - Use separate rate-limit namespaces per worker.
   - Use `wrangler versions upload` + `versions deploy` for gradual rollout and instant rollback.
   - Put internal docs and admin behind **Cloudflare Access**, with the hedger validating the `Cf-Access-Jwt-Assertion` instead of a bearer token in the bundle.
   - Host the exit app on a **different provider** (IPFS / GitHub Pages / ENS contenthash) with a reproducible build and a published hash. This is required by `production-topology.ts` (`directExitSeparateOrigin`) and the release checklist.
8. **Quality tooling.**
   - Biome (lint + format in one, fast) or ESLint + Prettier.
   - Vitest + Testing Library for hooks and formatters.
   - Playwright e2e against the local Hardhat stack (`dev:services`) with a mock EIP-1193 provider, plus axe-core checks.
   - `size-limit` budgets in CI.

---

## 6. Proposed restructure (frontends I would own)

```
apps/
  trade/            # was apps/web — React 19 + Vite + TanStack Router/Query + wagmi/viem
    src/routes/     # /trade/$market, /markets, /portfolio/*
    src/features/   # ticket/, account/, orders/, deposit/, session/, markets/
    src/lib/        # api client (from packages/api-contract), sse hook, wallet config
  ops/              # was apps/admin — same stack, no wallet; Access-protected; cookie/JWT auth only
  exit/             # vanilla TS + viem (+ Pyth Hermes fetch for proofs); reproducible build; separate host
  docs/             # Astro Starlight; content/ public + internal collections; two build targets
packages/
  ui/               # React primitives on Radix/React Aria + CSS Modules (or Tailwind v4) consuming tokens
  tokens/           # tokens.css + tokens.ts (colour, spacing, type, radius); light “ops” theme variant
  format/           # usd, base units, bps, address, time — one tested implementation
  api-contract/     # zod schemas + inferred types shared by services and apps (browser-safe only)
  pricing/          # browser-safe subset of packages/shared (constructQuote, marginRate, account-risk)
  config-vite/      # shared defineConfig factory (react plugin, ports, CSP dev meta, fonts subset)
deploy/cloudflare/
  edge/             # public edge worker (+ per-worker rate-limit namespaces, body-size limits, SSE caps)
  runtime/          # unchanged until durable journals exist; workers_dev:false
  wrangler/*.jsonc  # app, docs, docs-internal (Access), ops (Access)
```

Supporting changes:

- Convert the repo to **npm workspaces** (`"workspaces": ["apps/*","packages/*"]`) so packages have real `exports` and the browser/Node split is enforced. Today `packages/shared` mixes Node-only modules (`process-environment.ts`, journals) with browser-safe pricing.
- Retire `apps/design-system` in favour of Storybook or Ladle on `packages/ui`, published as a static artifact behind Access.

**Suggested sequencing**

1. **Safety fixes first:**
   - C1 (workflow_run hardening)
   - E6 (`workers_dev: false`)
   - admin token removal
   - gate `/v1/dev/wallet` behind `import.meta.env.DEV`
   - docs "Open app" link
   - SSE reconnect on HTTP error
2. Formatting + lint baseline (Biome) as a single mechanical commit.
3. `packages/format`, `api-contract`, and the SSE hook. Then TanStack Query in web and admin.
4. wagmi/viem migration of web and exit. Add Pyth Hermes proof fetching to exit, plus a separate-origin deploy.
5. Router + route split of `TradePage.tsx` into features.
6. `packages/ui` on Radix/React Aria and tokens expansion. Storybook replaces the specimen.
7. Starlight docs merge, with internal docs behind Access.
8. Playwright e2e, axe and size budgets in CI. Parallelize CI jobs and add PR preview versions.

---

## Appendix: commands run

| Command | Result |
|---|---|
| `npm run test:cloudflare-edge` (Node v22.22.0; CI uses 24) | 10 tests, 10 pass, 0 fail |
| `npm run typecheck` (`tsc` 7.0.2) | pass (1.8 s) |
| `node scripts/validate-cloudflare-static.mjs`, run from the scratchpad against the scratchpad `dist/` | "invariants passed" |
| `curl` to the testnet URLs | `CONNECT tunnel failed, response 403` from the sandbox proxy; not verifiable |

Builds used `npx vite build apps/<app> --outDir <scratchpad>/dist/<app>`, all successful:

| App | Main JS (raw / gzip) | Other | dist size |
|---|---|---|---|
| web | 236.0 / 72.7 KB | lazy ethers 332.2 / 127.6 KB; CSS 28.4 / 6.5 KB | 1.0 MB |
| exit | 261.1 / 96.7 KB | CSS 0.4 KB | 272 KB |
| admin | 196.2 / 61.8 KB | CSS 7.3 KB | 496 KB |
| docs | 196.7 / 62.1 KB | CSS 6.7 KB | 504 KB |
| internal-docs | **561.7 / 193.4 KB** (Vite >500 KB warning) | CSS 8.3 KB | 860 KB |
| design-system | 0.7 KB | CSS 12.8 KB | 432 KB (mostly fonts) |

Checks on the built bundles:
- `local-development-hedge-token` is not present in the production admin bundle.
- A `127.0.0.1` string appears only in the internal-docs bundle, from the embedded markdown, which is expected.
