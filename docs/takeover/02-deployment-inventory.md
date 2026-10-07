# 2. What is deployed and running

Checked on 2026-10-06. "Verified live" means fetched today (Cloudflare URLs over HTTPS, contract state through the Blockscout API for Base Sepolia). Everything else comes from the repo docs and is marked as such.

## Summary

| Surface | State today |
| --- | --- |
| Base mainnet | **Nothing deployed.** Only an unsigned plan generator exists (`scripts/mainnet-manifest.ts`). |
| Base Sepolia, governed stack | Deployed 2026-09-09. Proxy verified live, still on the **original** implementation. Last activity 2026-09-10. |
| Base Sepolia, rapid-iteration stack | Deployed 2026-09-10. Verified live on an **undocumented newer implementation**. Last activity 2026-09-16 (an `unpause` call). Docs say it cannot trade: ~$25 maker backing is below its $600k capital floor. |
| Cloudflare trading terminal | **Verified live**, but every data route returns 503 because the edge has no backend bindings. |
| Cloudflare public docs | **Verified live.** |
| Backend services | **Not hosted anywhere.** Everything ran on a developer machine. |
| Hyperliquid | Testnet account and agent wallet configured (per docs). No mainnet. |
| Custom domains | None. Only `*.workers.dev`. |

## Cloudflare (account "rfq-markets", Workers Free plan per docs)

| Worker | URL | Serves | How it is deployed | State |
| --- | --- | --- | --- | --- |
| `rfq-markets-testnet` | https://rfq-markets-testnet.rfq-markets.workers.dev | `apps/web` + `deploy/cloudflare/static/web-edge.mjs` | `.github/workflows/deploy-cloudflare.yml` after CI on `main`, gated by repo variable `CLOUDFLARE_DEPLOY_ENABLED` | **Deleted 2026-10-07.** Was live with no service bindings, so every API call returned 503. Replaced by `rfq-markets-dev` (see `deploy/cloudflare/DEV-ENVIRONMENT.md`); its config and workflow steps were removed. |
| `rfq-markets-docs-testnet` | https://rfq-markets-docs-testnet.rfq-markets.workers.dev | `apps/docs` | Same workflow | Live. |
| `rfq-markets-internal-docs-testnet` | none | `apps/internal-docs` | Config only (`wrangler.internal-docs.jsonc`) | Not deployed (needs Cloudflare Access). |
| `rfq-markets-runtime-testnet` | none | Worker + Durable Object + Container running every service | Manual only | **Dead.** Containers need Workers Paid, and `scripts/cloudflare-container.ts` now throws on start because Container disk is ephemeral. |

Every recent run of the deploy workflow on GitHub is **"skipped"** (most recent: 2026-09-20), so `CLOUDFLARE_DEPLOY_ENABLED` is not `true`. The live sites were deployed by hand, most likely on 2026-09-11 (inferred from commits `3b54fd3` and `6c04310`). They may not match `main`.

Rate-limit namespaces `84532001`–`84532004` are shared between the static and runtime workers.

## Base Sepolia (chain 84532)

### Governed rehearsal stack (Safe + 72h timelock)

| Component | Address | Verified today |
| --- | --- | --- |
| Clearing proxy | `0x1114cA912b2c3440C7D6B5dcdaB499f897C86782` | Contract, EIP-1967 proxy. Last txs 2026-09-10. |
| Clearing implementation | `0xB7Df1f1718e8E487D6673B912b99248C5f731B9F` | Yes: still the active implementation. It predates the 2026-09-16 code (no `RFQSignatureVerifier`, no exposure controls). |
| RFQRiskMath | `0x0967d24F4c8BF63064Fd39EBf413b1073a5B8eB2` | from docs |
| Pyth adapter | `0x8Ba3F42B417824b9550253573D75Dc4fe22dC5ec` | from docs |
| Scheduled replacement Pyth adapter | `0x414a98e864984697e3e81b8844e5810c6D5DB9b2` | Timelock op `0xd0303c4c…b7f`, executable since 2026-09-13. **Whether it was executed is unknown.** |
| ProxyAdmin | `0x28fda3da2507189e8c0d0b62d2bd2d2a339926ba` | from docs |
| Timelock (72h, self-administered) | `0x53324175fEC3F1C6d3eF48C946ce3a7A94FAC765` | from docs |
| Governance Safe (2-of-3) | `0xA2C1b91a86FE748c75B17D4Df9C445c2eE315494` | from docs |
| Emergency Safe (2-of-3) | `0x09382dBc66dAd74232f72ba1E2894b442bEF9Ef7` | from docs |
| Native USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Circle's Base Sepolia USDC |
| Pyth Core | `0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83` | from docs |
| Disposable trader | `0x1026b5f8CF4640613B625ECa70b295FfE36E663A` | from docs |

Balances recorded in docs: 25.00016 USDC maker backing, 5.00004 insurance, 9.9998 trader collateral. All Safe owner keys were generated into one local file, so this is a rehearsal of the shape, not of real custody.

Because the implementation is old, `npm run verify:base-sepolia` would likely fail against this stack (it expects `signatureVerifier` and `exposureState()`), and the repo has **no script to upgrade a governed proxy through the timelock**.

### Rapid-iteration stack (deployer EOA is governance)

| Component | Address | Verified today |
| --- | --- | --- |
| Clearing proxy | `0x35eDDFfF04296dae1564f4C33518C57C87b91D90` | Contract, EIP-1967 proxy. Last tx `unpause` on 2026-09-16 13:00 UTC from `0xB4AF2016108c5a948421a897E518170049393A35` (deployer, inferred). |
| Active implementation | `0x2128C4C8148F5210cA3C6a6C0a3651751aE4b676` | **Found on-chain today; not recorded anywhere in the repo.** Presumably the 2026-09-16 code with exposure controls. |
| Previous release candidate | `0xb44Ca37EE72C39a81CCC872C3b9A9c2f000572e4` (RiskMath `0x78eA651dA386EC910C8e434097B95e53b7A4D0Fb`) | from docs, superseded |
| Pyth adapter (bounded parse) | `0x0d8B76cc87B8289A74021E33E13C9F97Aa2e1873` | from docs |

The manifest for this stack lives in the git-ignored `.local-state/base-sepolia-iteration.json`, which exists only on the original developer machine. **Ask: if that folder still exists, keep a copy; it holds the testnet identities and deployment manifests.**

### Recorded testnet evidence

| Run | Date | Result |
| --- | --- | --- |
| Base → Hyperliquid ETH lifecycle (4 runs) | 2026-09-10 | Opened, hedged, closed, flattened; approval-to-inclusion 2.5–3.8 s. Tx hashes and order ids are in `reviews/existing-docs.md` §5. |
| BTC Pyth canary | 2026-09-10 | Open and exact close to zero. |
| One soak cycle | 2026-09-10 | Passed (~1 minute). |
| 72-hour qualification | 2026-09-16 → 09-20 | Tooling was being hardened through six "qualification retry" commits. No result recorded. |
| 25-hour market-flow capture | 2026-09-12 | Failed its integrity gate (transport errors and sequence gaps). |

## Base mainnet (chain 8453)

Nothing deployed. The only mainnet address in the repo is native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. A separate project thread ("Base mainnet deploy prep") is building the deploy tooling. What a deploy needs is in [07-roadmap.md](07-roadmap.md#milestone-m3-base-mainnet-capped-canary).

## GitHub

| Item | State |
| --- | --- |
| Repository | Private. Default branch `main`. |
| CI (`ci.yml`) | Green on `main` at `bae3332`. Single 20-minute job: `npm ci`, `npm audit`, `npm test`. |
| Deploy (`deploy-cloudflare.yml`) | Always skipped (switch off). |
| Release image (`release-image.yml`) | Manual. Its vulnerability waiver in `security/vulnerability-exceptions.json` **expired 2026-09-30**, so it will now fail closed. |
| Draft PR #5 "Harden recovery operations and trading workflows" (`codex/repo-streamline`) | Conflicts with `main`. +1,139/−579 across 64 files. Adds partial closes, realized PnL in history, restyled exit app, context-bound journal snapshots. Held back so it would not disturb the 72h qualification. |
| Dependabot PRs | #6 vite 8.3.0 (green), #7 react 19.3.0 (green), #8 mocha 12.0.1 (green), #9 solc 0.8.37 (**red**: likely trips the 21,000-byte gate), #10 zod 4.6.5 (**red**: major version). |

## External accounts the project depends on

| Service | Purpose | Status per docs |
| --- | --- | --- |
| Cloudflare | Edge and static sites | Account exists, Workers Free. |
| Pyth Hermes | Authenticated price stream (API key) | Key configured locally. |
| Hyperliquid testnet | Hedge venue | Account + named agent wallet configured. |
| Public RPCs (PublicNode, dRPC, Base Flashblocks) | Chain reads and writes | No paid/private RPC yet. |
| GitHub Actions + GHCR | CI and host image | Active. |
