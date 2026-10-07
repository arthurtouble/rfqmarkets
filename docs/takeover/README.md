# RFQ Markets takeover pack

A full read of the repository on 2026-10-06 (HEAD `bae3332`), done so the project can be owned, restructured and taken to production. Nothing was deployed, upgraded or funded during this audit, and no source code was changed.

## Read in this order

1. [Product and architecture](01-product-and-architecture.md): what the product is, every surface and feature, the system map.
2. [Deployment inventory](02-deployment-inventory.md): what is live today, every address and URL, GitHub state.
3. [Decisions review](03-decisions-review.md): the key decisions and whether each holds up.
4. [Tech stack](04-tech-stack.md): what to keep, upgrade, replace and delete.
5. [Refactor and rewrite plan](05-refactor-and-rewrite-plan.md): target layout and the order of work.
6. [Flowcharts](06-flowcharts.md): products, trade, limit orders, funds, liquidation, resolution, hedging, governance, delivery, target topology.
7. [Roadmap](07-roadmap.md): milestones to a capped Base mainnet canary, then feature by feature.

Detailed evidence with `file:line` references:
[contracts](reviews/contracts.md) · [services](reviews/services.md) · [frontend, edge and CI](reviews/frontend-edge-ci.md) · [scripts and simulator](reviews/scripts-and-simulator.md) · [existing docs and decision log](reviews/existing-docs.md)

## The short version

- **What it is.** A BTC/ETH perpetuals venue on Base where the operator is the only market maker, every fill needs the trader's signature plus 2 of 3 operator approvers, and the contract re-checks price limits, margin, exposure caps and stress loss. Hedging happens on Hyperliquid.
- **What is live.** Two Base Sepolia deployments, a trading terminal and a docs site on Cloudflare `workers.dev`. The terminal cannot trade because no backend is hosted; every service ran on a developer laptop. **Nothing is on Base mainnet.**
- **Is it good?** The security design is genuinely strong and well tested: the full `npm test` gate passes (contracts, 13,500 risk comparisons, 600-step stateful run, 166 service tests, 50 Python tests, 10 edge tests, six app builds). The form is the problem: code written as minified one-liners (one line is 3,013 characters), a 93 KB API closure, a contract squeezed to 5 bytes under a self-imposed size gate, no formatter, no logging, no wallet library, and 36 overlapping docs.
- **Bugs that matter before real money.** Oracle prices can be overwritten by older ones (keepers can pick the worst price); anyone can push the venue into irreversible wind-down once maker capital dips below the opening floor; leftover capital after wind-down is locked; a fresh deploy starts unpaused at maximum caps; the hedger cannot run on mainnet.
- **Recommendation.** Keep the design, rewrite the form. Rewrite the contracts in Foundry **before** the first mainnet deploy (mainnet storage layout is permanent), restructure the services behind the existing tests, rebuild the trading app on wagmi/viem + TanStack, consolidate the docs. Deploy mainnet governance (Safes + timelock) now; deploy the clearing contracts paused after the rewrite.

## Corrections to the detailed reviews

The five reviews were written in parallel from the code alone. Facts checked afterwards:

- Both Cloudflare sites **are live** (fetched 2026-10-06). The terminal's `/edge/health` reports no backend bindings.
- The rapid-iteration proxy `0x35eD…1D90` runs implementation `0x2128C4C8148F5210cA3C6a6C0a3651751aE4b676`, which no repo document records. Its last transaction was an `unpause` on 2026-09-16.
- The governed proxy `0x1114…6782` still runs its original implementation `0xB7Df…9B9F`.
- The repository is **private**, so the `workflow_run` token exposure in `deploy-cloudflare.yml` is low risk today (no outside forks); still worth fixing.
- The Cloudflare deploy workflow has been **skipped** on every run, so the live sites were deployed by hand and may not match `main`.
