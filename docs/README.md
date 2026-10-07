# Documentation

Every file under `docs/` is published to the private internal manual (`npm run dev:internal-docs`); the folder becomes its section. Start with the overview, then read whichever area you are changing.

## Takeover pack

[takeover/](takeover/README.md) is the October 2026 handover: product and architecture summary, deployment inventory, decisions review, tech stack, refactor plan, flowcharts and roadmap, plus per-area code reviews.

## Architecture: how the system works

- [Overview](architecture/overview.md): components, trust boundaries, request paths and launch gates. Read this first.
- [Contracts](architecture/contracts.md): clearing state, settlement order, oracle adapter, liquidation and authority.
- [Economic specification](architecture/economic-specification.md): margin, funding, impact, loss waterfall and invariants.
- [Gross approval reservations](architecture/gross-approval-reservations.md): how the API and approvers reserve gross exposure before signing.
- [Hedging](architecture/hedging.md): venue capital, reconciliation and the hedge worker.
- [Indexer](architecture/indexer.md) and [read model and orders](architecture/read-model-and-orders.md): chain-derived account state and conditional orders.
- [Scale and streaming](architecture/scale-and-streaming.md): SSE fan-out and admission control.
- [Wallets and deposits](architecture/wallets-and-deposits.md) and [edge and origin privacy](architecture/edge-and-origin-privacy.md).

## Product

- [Trading UX and intents](product/trading-ux-and-intents.md): the amount plus Buy/Sell ticket and what the app signs.
- [Design system](product/design-system.md): tokens and component rules; the live specimen is `npm run dev:design-system`.

## Operations

- [Local development](operations/local-development.md): run the full stack on a local chain.
- [Base mainnet deployment](operations/base-mainnet.md): dev and production profiles, deploy, upgrade and handover commands.
- [Cloudflare](operations/cloudflare.md): Workers, the runtime container and CI delivery.
- [Cloudflare dev environment](../deploy/cloudflare/DEV-ENVIRONMENT.md): the hosted dev stack wired to the mainnet dev contracts.
- [Market lifecycle](operations/market-lifecycle.md): enabling, tightening, pausing and retiring markets.
- [Market making](operations/market-making.md) and [market-flow calibration](operations/market-flow-calibration.md): quote policy and the research pipeline behind it.
- The incident runbook and alert rules live in [deploy/operations](../deploy/operations/INCIDENT-RUNBOOK.md).

## Release

- [Implementation plan](release/implementation-plan.md): open production work and its status.
- [Release checklist](release/release-checklist.md): evidence required before a production mainnet release.
- [Independent review package](release/independent-review-package.md): what external reviewers receive.

## History

[history/](history/) keeps superseded designs, dated audits and the retired Base Sepolia deployment records. They explain why the current design looks the way it does, but where they disagree with the documents above, the documents above win. File names start with the date they describe.
