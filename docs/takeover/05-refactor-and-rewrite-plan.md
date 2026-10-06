# 5. Refactor and rewrite plan

## Recommendation in one paragraph

Do **not** throw the project away. Its security design (three-signature fills, on-chain re-checks, journaled-before-escape reservations, durable sender, startup attestation) is sound and well tested, and that reasoning is the expensive part. What makes it hard to own is the *form*: minified one-line code, one 93 KB API closure, a byte-golfed contract, no package boundaries, and 36 overlapping documents. So the plan is a **rewrite in place, layer by layer, using the existing tests as the safety net**:

- **Contracts: rewrite now, before mainnet.** Mainnet is greenfield, so this is the one moment the storage layout can change for free. After the first mainnet deploy, every layout decision is permanent.
- **Services: restructure, don't rewrite.** Format, split into packages, then replace pieces (viem, zod 4, logging) behind the existing 166 tests.
- **Frontend: rebuild the trading app** on wagmi/viem + TanStack. It is small (about 400 lines of logic), so a fresh build is cheaper than refactoring.
- **Docs: consolidate** 36 files into about eight plus an archive.

## Target repository layout

```
rfqmarkets/
├─ package.json  pnpm-workspace.yaml  turbo.json  biome.json  tsconfig.base.json
├─ contracts/                    # Foundry project
│  ├─ src/
│  │  ├─ RFQClearing.sol         # thin entry points, readable
│  │  ├─ modules/                # Collateral, Positions, Funding, Settlement, Liquidation, Resolution, Sessions, Governance hooks
│  │  ├─ libraries/              # pure math only: Pricing, Margin, Stress, Funding
│  │  ├─ oracle/                 # IPriceOracle, PythAdapter (+ Chainlink only once validated on a fork)
│  │  ├─ governance/             # Timelock (configurable delay), no testnet-only variants
│  │  └─ types/                  # EIP-712 typehashes, structs, errors, constants (one place)
│  ├─ test/                      # unit, fuzz, invariant (handlers), fork (Base mainnet)
│  └─ script/                    # Deploy.s.sol, Upgrade.s.sol (timelock schedule/execute), Configure.s.sol
├─ packages/
│  ├─ protocol/                  # @rfq/protocol — pure TS: markets, eip712 + zod codecs, pricing, risk, oracle-report, errors
│  ├─ economics/                 # economics.json — single source of K matrix, stress set, margin tiers, fees, oracle limits
│  ├─ chain/                     # @rfq/chain — viem clients, generated ABIs, ClearingReader (multicall), authorizeIntent, DurableSender
│  ├─ journal/                   # SQLite wrapper, migrations, atomic(), snapshot/restore, Litestream config
│  ├─ runtime/                   # Fastify factory (pino, zod provider, health), SSE server/parser, config + secrets loader
│  ├─ oracle/                    # OracleSource interface + pyth/ (+ coinbase dev source)
│  ├─ api-contract/              # browser-safe zod schemas shared by services and apps
│  ├─ ui/  tokens/  format/      # frontend primitives, design tokens, formatters
├─ services/
│  ├─ api/        main.ts + quoting/ execution/ actions/ orders/ account/ recovery/
│  ├─ approver/   main.ts + policy/ (one file per rule family, unit-tested per rejection) signer.ts journal.ts
│  ├─ gateway/    unchanged shape on @rfq/runtime/sse
│  ├─ indexer/    Ponder project, or custom with reorg walk-back
│  ├─ keeper/     engine + local margin pre-filter
│  └─ hedger/     pure planner + venues/{local,hyperliquid}.ts + direct chain exposure reads
├─ apps/
│  ├─ trade/      React + TanStack Router/Query + wagmi/viem (was apps/web)
│  ├─ ops/        Access-protected hedge/ops dashboard (was apps/admin)
│  ├─ exit/       vanilla TS + viem, fetches Pyth proofs, hosted off Cloudflare
│  └─ docs/       Astro Starlight: public + internal builds (replaces docs, internal-docs, design-system)
├─ simulator/     Python independent oracle + research lab (pyproject, ruff)
├─ tools/rfq-cli/ one typed ops CLI replacing ~70 npm scripts: local | testnet | mainnet | host | release | data
├─ dev/           local stack, dev-chain helpers, deposit simulator (never shipped)
├─ deploy/        host/ (systemd, per-role images), cloudflare/edge/, operations/
└─ docs/          README, ARCHITECTURE, ECONOMICS-AND-RISK, PRODUCT-AND-UX, DEPLOYMENTS, OPERATIONS, ROADMAP, DECISIONS, archive/
```

## Contracts v1 (before mainnet)

Keep the economics and the authority model. Change the shape and fix the findings.

| Change | Reason |
| --- | --- |
| Move to Foundry; pin `evm_version`; readable formatting | Speed, fuzzing, fork tests, scripted deploys and verification. |
| Split `RFQClearing` into internal modules with one storage struct (ERC-7201 namespaced storage) | Readability, auditability, safe future upgrades. Drop the 21,000-byte gate; enforce EIP-170 (24,576) per contract with real headroom. |
| Libraries become pure math; storage writes stay in the clearing contract | Today `RFQRiskMath` writes proxy storage through delegatecall, which auditors must treat as part of the core anyway. |
| `mapping(uint8 => Market)` + `marketCount` instead of `Market[2]` | Adding a market later without a layout-breaking upgrade. |
| Monotonic oracle recording (`observedAt >= lastPriceTime`) and one `_touchOracle` helper | Stops keepers choosing the worst valid price in a 15s window. |
| Resolution: grace period or separate lower trigger threshold; bounded, time-bucketed sampling; surplus sweep back to maker/insurance; handle zero-claims | Today it is an irreversible griefable kill switch that locks leftover capital. |
| `setMarketPolicy` accrues funding before changing the limit; decide the funding scale (spec $250k vs limit-based) | Retroactive funding and a 20x spec mismatch. |
| Reduce-only trades judged against maintenance margin, not initial | Lets users de-risk when equity sits between MM and IM. |
| Session grant cannot overwrite another account's session key | Griefing fix. |
| Initialize **paused** with caps passed to `initialize` | A fresh proxy must never be live at maximum caps waiting 72h for governance. |
| Specific custom errors and events for every admin action | Monitoring and debugging. Today `Replay` is reused for "fee too high". |
| Delete `RFQAuthorization`, `RFQInvariants`, unused constants | Dead code that the tests currently exercise instead of the real contract. |
| Foundry invariant suite: buckets == USDC balance; sum of positions == aggregate; no nonce reuse; nothing settles while paused; claims ≤ assets | The protocol has no real fuzzing today. |
| Fork tests against Base mainnet Pyth and USDC | Real EIP-3009, real Pyth fees. |
| Slither + coverage in CI | Standard hygiene before an external audit. |

Keep the existing JS risk-differential (13,500 comparisons) and the Python fixed-point model as independent oracles, and point them at the new contracts.

## Services restructure (order matters; every step keeps `npm test` green)

1. **Format everything** (Biome, ruff) in one mechanical commit. No logic changes.
2. **Workspaces**: pnpm + Turborepo, each service and package gets its own `package.json`. Move shared tests next to their package.
3. **Delete dead code**: Cloudflare container runtime, `prepare-cloudflare-runtime.ts`, dev-only paths moved to `dev/`.
4. **Extract `@rfq/protocol`** and remove the duplicates: funding projection (3 copies), oracle report encoding (5), ERC-1271/session authorization (4), SSE server (4) and parser (2), market type (6), `BASE/RATE/MASK` constants, wire codecs.
5. **Introduce `@rfq/chain`** with viem, typed ABIs and a multicall `ClearingReader`. Approvers and the API stop making ~20 sequential RPC calls per request.
6. **Split `buildApi`** into quoting, execution, actions (one generic `signedAction` helper replaces four copy-pasted prepare/execute pairs), orders (no more `app.inject` loopback through the public rate limiter), account, recovery.
7. **Fix the sender**: stop re-reading every historical receipt every 5s, model reorgs explicitly, and stop reporting unhealthy during normal in-flight trades.
8. **Logging and contracts between services**: pino with correlation ids; zod-validate the hedge snapshot, indexer pages and exposure payloads; stable machine error codes in API responses.
9. **Hedger**: read exposure from the chain, require its auth token always, make the venue network a config value, then replace the Python bridge with a TypeScript adapter.
10. **Indexer**: Ponder/Postgres evaluation, or reorg walk-back + `finalized` tag + SSE connection cap.
11. **Keeper** in the local and testnet stacks, with a margin pre-filter instead of simulating every account.
12. **Ops CLI** (`tools/rfq-cli`) built on shared `env`, `manifest`, `identities`, `poll`, `rfq-client` and `evidence` modules; it replaces about 70 npm scripts and removes provider leaks.

## Frontend rebuild

1. Safety fixes on the current app first (small PR): stop requesting `/v1/dev/wallet` in production, SSE reconnect after HTTP errors, fix the docs "Open app" link, remove the admin bundle token option.
2. New `apps/trade` on TanStack Router + Query, wagmi/viem + RainbowKit, `@rfq/api-contract` types, `packages/ui` primitives.
3. Port features one by one: markets view, ticket (market/limit), account and positions, deposit (add sponsored EIP-3009), withdraw, close (partial closes from PR #5), quick trading, history with realized PnL (from PR #5).
4. Exit app on viem with client-side Pyth proof fetching; host on IPFS or GitHub Pages.
5. Starlight docs replacing three apps.
6. Playwright e2e against the local stack, axe checks, bundle budgets.

## Documentation

Consolidate the 36 root documents into:

| New doc | Built from |
| --- | --- |
| `README.md` | README, summary of this takeover pack |
| `docs/ARCHITECTURE.md` | CURRENT-ARCHITECTURE, REPO-CONTEXT system map, CONTRACT-IMPLEMENTATION, INDEXER-DESIGN, SCALE-AND-STREAMING, EDGE-AND-ORIGIN-PRIVACY |
| `docs/ECONOMICS-AND-RISK.md` | ECONOMIC-SPECIFICATION reconciled with the code (spec value vs implemented value vs calibration status), contracts/*.md, ADVERSARIAL-FLOW |
| `docs/PRODUCT-AND-UX.md` | UX-AND-INTENT, PRODUCT-READ-MODEL-AND-ORDERS, WALLET-AND-DEPOSITS, DESIGN-SYSTEM |
| `docs/DEPLOYMENTS.md` | BASE-SEPOLIA-DEPLOYMENT, CLOUDFLARE-DEPLOYMENT, EXTERNAL-INTEGRATION-INPUTS, LOCAL-DEVELOPMENT, the inventory in this pack |
| `docs/OPERATIONS.md` | INCIDENT-RUNBOOK, MARKET-LIFECYCLE-PLAYBOOK, HEDGING-OPERATIONS, keeper and host READMEs |
| `docs/ROADMAP.md` | PRODUCTION-IMPLEMENTATION-PLAN, PRODUCTION-RELEASE-CHECKLIST, INDEPENDENT-REVIEW-PACKAGE, [07-roadmap.md](07-roadmap.md) |
| `docs/DECISIONS.md` | the D1–D34 log in [reviews/existing-docs.md](reviews/existing-docs.md) plus [03](03-decisions-review.md) |
| `docs/archive/` | ARCHITECTURE, SYSTEM-DESIGN, SIMPLIFIED-DESIGN, ARCHITECTURE-REVIEW, AUTHORIZATION-AND-UPGRADES, RFQ-PROTOCOL-RESEARCH, both SYSTEM-AUDITs, LOCAL-READINESS-REVIEW, VALIDATION-REPORT, REPO-CONTEXT review, MARKET-MAKING-AND-TESTNET-PLAN |

Every status statement gets a date and one label: implemented, demonstrated on testnet, proposed, or qualified.

## What stays exactly as it is

- The trade authorization model and the contract's economic checks.
- The approver "journal before signing" ordering and finalized-time reservation release.
- Signed-before-broadcast sending.
- Runtime identity attestation at startup.
- The persistent-host model (one systemd unit per role, file locks, sandboxing).
- The secret-free stream gateway.
- The design language (square corners, IBM Plex, semantic colours).
