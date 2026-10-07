# 4. Tech stack assessment

Short version: the **foundations are modern and correct** (Node 24, TypeScript 7 native compiler, React 19, Vite 8, Fastify 5, Solidity 0.8.34 with OpenZeppelin 5, Cloudflare Workers Static Assets, Base). What is missing is the **application layer and tooling around them**: wallet stack, typed chain client, workspace structure, formatter, logging, Solidity fuzzing.

## Current vs recommended

| Layer | Today | Verdict | Recommendation |
| --- | --- | --- | --- |
| Runtime | Node 24 (CI), tsx at runtime in production | Keep Node | Run type-stripped `.ts` directly (enable `erasableSyntaxOnly`) or bundle per service; drop tsx from production images. |
| Language | TypeScript 7.0.2 native, strict | Keep | Add `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`. |
| Repo layout | One root `package.json`; `packages/*` imported by `../../../` paths; shared tests live in `scripts/` | **Upgrade** | **pnpm workspaces + Turborepo**: real packages with `exports`, per-service dependencies and images, cached builds/tests. |
| Format / lint | None | **Add** | **Biome** (one fast tool for format + lint). Ruff for Python. Run once as a mechanical commit. |
| Ethereum client (services) | ethers 6, untyped `Contract`, `batchMaxCount: 1` | **Upgrade** | **viem** with `as const` ABIs: typed reads/writes, multicall batching (approvers do ~20 sequential reads per approval today), built-in ERC-1271/6492 verification, fallback transports. |
| Validation | zod 3.25 on request bodies only | **Upgrade** | **zod 4** (Dependabot PR #10 is red because it is a major bump; do it as part of the refactor), `z.codec` for bigint↔string wire types, `fastify-type-provider-zod` for route schemas, validate every inter-service payload and the environment. |
| HTTP | Fastify 5 used as a bare router, `logger:false` | Keep, use properly | pino logging with redaction and correlation ids, schema routes, plugins per domain, a shared SSE helper. |
| Storage | `node:sqlite` per role, ad-hoc `ALTER TABLE` migrations | Keep SQLite for journals | Versioned migrations, **Litestream** continuous encrypted off-host backup. Postgres only for the read model. |
| Indexer | Custom SQLite poller | Revisit | Re-evaluate **Ponder** on Postgres (or Envio HyperIndex). If rejected again, fix reorg walk-back and use the `finalized` tag. |
| Hedge venue | Python `hyperliquid-python-sdk` child process, testnet-only | Upgrade later | TypeScript adapter (`@nktkas/hyperliquid` or a small EIP-712 + msgpack signer) behind the existing `HedgeVenue` interface. |
| Observability | `/health` + bearer JSON metrics | **Add** | pino → log sink, OpenTelemetry traces quote→approve→sender→receipt, Prometheus metrics matching `deploy/operations/alerts.json`. |
| Contracts toolchain | Hardhat 3 for networks only + custom solc-js (WASM) compile script + hand-written linking + fake build-info; tests are `hardhat run` scripts with ad-hoc asserts | **Upgrade** | **Foundry** for build, unit, fuzz and stateful invariant tests, Base mainnet fork tests (real Pyth, real USDC), coverage, gas snapshots, `forge script` deployments and `forge verify-contract`. Keep the Safe ceremony scripts in TypeScript. Pin `evm_version`. Add **Slither** in CI. |
| Upgrade safety | OZ upgrades-core validates against a frozen copy of an old version | Fix | Validate against the layout of the implementation actually deployed (`openzeppelin-foundry-upgrades` or `@openzeppelin/hardhat-upgrades`). |
| Frontend framework | React 19 + Vite 8 | Keep | — |
| Wallet | Raw `window.ethereum` + lazy ethers | **Upgrade** | **wagmi + viem + RainbowKit** (or Reown AppKit): EIP-6963, WalletConnect/mobile, Coinbase Smart Wallet, ERC-1271. Keep a thin adapter so Privy/Dynamic embedded wallets can be added later. |
| Data fetching | `useState` + manual fetch; SSE never recovers from HTTP errors | **Upgrade** | **TanStack Query** + one shared SSE hook with backoff and reconnect. |
| Routing | `?view=` toggled by `replaceState` | **Upgrade** | **TanStack Router**: `/trade/$market`, `/markets`, `/portfolio/*`. |
| UI components | Hand-written CSS, 195 hard-coded colours vs 41 token uses in web | Upgrade | `packages/ui` on Radix/React Aria primitives (fixes a11y gaps) with tokens as the single source; Storybook replaces the specimen page. |
| Docs sites | React SPA with 5 hard-coded pages + a second SPA with a 20-line Markdown renderer (562 KB bundle) | **Replace** | **Astro Starlight**: one content tree, public build + internal build behind Cloudflare Access, search, Mermaid, deep links, near-zero JS. |
| Edge | Workers Static Assets + edge Worker | Keep | Add service bindings when hosts exist, custom domains (`app.`, `docs.`), versioned deploys, per-worker rate-limit namespaces, Cloudflare Access for ops/internal. |
| Exit app | Vanilla TS + ethers, user pastes a raw Pyth proof | Keep the idea | viem, fetch the Pyth proof client-side from Hermes, host on a **different provider** (IPFS/GitHub Pages) with a reproducible build hash. |
| CI | One serial 20-minute job; deploy workflow uses `workflow_run` with the token at job level | Upgrade | Parallel jobs (contracts, services, python, web), Biome, Slither, Playwright + axe, bundle budgets, preview deploys. Scope the Cloudflare token to deploy steps and require a push event from this repo (the repo is private, so the fork risk is low today). Add pip and docker to Dependabot. |
| Simulator | Python stdlib, 50 tests | Keep | Keep as an independent check; add a Solidity↔Python differential and delete the drifted float models. One shared `economics.json` parameter file checked by every copy. |

## Things to remove

- Cloudflare Container runtime: `deploy/cloudflare/runtime/` container class, `Dockerfile.cloudflare`, `scripts/cloudflare-container.ts`, `scripts/prepare-cloudflare-runtime.ts` (it bundles all approver, sponsor and hedge keys into one secret).
- `contracts/RFQAuthorization.sol` and `contracts/test/RFQInvariants.sol`: dead reference code with a different intent format, yet it is the target of the first contract test.
- `RFQRiskMath.enforceAggregateRisk` and unused constants in `RFQClearing.sol`.
- Drifted Python models (`accounting.py` margin tiers, two oracle-mode models, the float spread mirror).
- `*-iteration-*` npm script duplicates (replace with a `--profile` flag).

## Dependency PRs: what to do

| PR | Action |
| --- | --- |
| #6 vite 8.3.0, #7 react 19.3.0, #8 mocha 12.0.1 | Merge (green, low risk). |
| #9 solc 0.8.37 | Close for now; it fails the 21,000-byte gate. Re-apply after the contract restructure or after raising the gate. |
| #10 zod 4 | Close for now; do zod 4 deliberately inside the services refactor. |
| #5 (draft, conflicts) | Rebase or cherry-pick its product features (partial closes, realized PnL, exit UI) into the restructured layout rather than merging as-is. |
