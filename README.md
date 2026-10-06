# RFQ Markets

A leveraged perpetual RFQ venue on Base. Customers hold USDC collateral in an on-chain clearing contract; one operator prices trades, three private approvers co-sign them (two of three), and the operator hedges its inventory on Hyperliquid. The contract is the ledger: every balance and position can be rebuilt from chain events.

## Where it runs today

| Surface | Location |
| --- | --- |
| Trading UI (dev) | https://rfq-markets-dev.rfq-markets.workers.dev |
| Public docs | https://rfq-markets-docs-testnet.rfq-markets.workers.dev |
| Clearing proxy, Base mainnet (dev) | `0x6e67c66f955D88EBD6D69eD3343359651C6f45a1` |

The Base mainnet deployment is a **development** deployment: owner-controlled, no timelock, capped at 25 USDC per trade and 100 USDC per market. Services run in a Cloudflare container with the hedger simulated. Production governance (Safes, timelock, independent review) comes later and is tracked in the [release checklist](docs/release/release-checklist.md). The earlier Base Sepolia deployments are retired; their record is in [docs/history](docs/history/base-sepolia-deployment.md).

## Repository layout

| Path | What lives there |
| --- | --- |
| `contracts/` | Solidity clearing contract, oracle adapter, libraries, mocks and tests |
| `services/` | `api` (pricing and execution leader), `approver`, `gateway` (SSE fan-out), `indexer`, `keeper`, `hedger` (TypeScript plus a Python Hyperliquid bridge) |
| `packages/` | Shared TypeScript (`shared`) and design tokens (`design-system`) |
| `apps/` | React apps: `web` (trading), `admin` (operations), `exit` (direct withdrawal), `docs` (public guide), `internal-docs` (this repository's `docs/` as a private manual), `design-system` (specimen) |
| `deploy/` | Cloudflare Workers and container config, host units, alert rules and the incident runbook |
| `scripts/` | Local stack, deployment, smoke, soak and release-evidence tooling |
| `simulator/` | Python economic model, replay, calibration and fault harness |
| `docs/` | Architecture, product, operations and release documentation ([index](docs/README.md)) |

## Working on it

```sh
npm ci
npm run compile:contracts
npm run dev:chain        # terminal 1: local OP-compatible Hardhat chain
npm run deploy:local     # terminal 2: deploy contracts and mocks
npm run dev:services     # terminal 2: API, approvers, gateway, indexer, hedger
npm run dev:web          # terminal 3: trading UI
```

The full walkthrough is in [local development](docs/operations/local-development.md). Before opening a pull request, run the narrowest relevant check, then `npm test`:

| Change | Check |
| --- | --- |
| TypeScript anywhere | `npm run typecheck` |
| Services and scripts | `npm run test:services` |
| Contracts | `npm run test:contracts` and `npm run validate:upgrades` |
| Simulator | `npm run test:python` |
| Cloudflare edge | `npm run test:cloudflare-edge` |
| Documentation | `npm run check:docs` |

[AGENTS.md](AGENTS.md) lists the safety boundaries for automated contributors. The most important: never weaken signature, quorum, replay, oracle-freshness, exposure or fail-closed checks to make a test pass, and never broadcast mainnet transactions without the owner's explicit go-ahead.
