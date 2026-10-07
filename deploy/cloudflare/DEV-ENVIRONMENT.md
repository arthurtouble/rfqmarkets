# Hosted dev environment (Base mainnet)

A development deployment people can open in a browser: the trading UI and docs on Cloudflare, every backend service in one Cloudflare Container, and the dev-profile contracts on Base mainnet (owner wallet, no timelock, dev caps; see [Base mainnet deployment](../../docs/operations/base-mainnet.md)). It is for development only. It is not the production trust layout, and it must not hold customer funds.

| Piece | Where | Updated by |
| --- | --- | --- |
| Trading UI | Worker `rfq-markets-dev` → `https://rfq-markets-dev.<account>.workers.dev` | Every green CI run on `main` (`deploy-cloudflare-dev.yml`) |
| Docs | Worker `rfq-markets-docs-testnet` | Same |
| API, 3 approvers, indexer, simulated hedger, gateway | Container behind Worker `rfq-markets-runtime-dev` (no public route; reached only through the UI worker's service bindings) | Same |
| Contracts | Base mainnet, dev profile | Manually, `dev-contracts.yml`, each run approved in GitHub |

## How it fits together

- **Keys.** The owner (governance and ProxyAdmin) is a dedicated private key generated for this environment and kept in the `owner-key` entry of the `rfq-markets-dev-state` KV namespace (its address is in `owner-address`). An `RFQ_DEV_OWNER_KEY` secret in the `mainnet-dev` environment overrides it. The emergency council, three approvers and gas sponsor are generated inside the runtime's Durable Object on first start and never leave Cloudflare. The runtime publishes only their addresses (KV `identities.json`), and it refuses to run against a deployment whose approver set is not its own keys. No recovery phrase is stored anywhere. The `RFQ_DEV_RUNTIME_SECRETS` Worker secret holds only the RPC URLs and the Pyth API key.
- **Deployment record.** The contracts workflow stores the record (public addresses, deployment block) and the deployed build-info in the `rfq-markets-dev-state` KV namespace. The runtime reads the record on start; a new proxy address restarts the runtime with empty journals.
- **Journals.** Container disk is ephemeral. The Durable Object that owns the container restores the SQLite journals on start and saves a consistent snapshot every minute (a cron that also keeps the container running). A crash can lose up to a minute of journal. The contract still enforces nonces, signatures and caps, so the loss is operational (an in-flight quote or commitment can be forgotten), not a way around the contract checks. This is acceptable only at dev caps; production uses persistent hosts ([deploy/host/README.md](../host/README.md)).
- **Hedging** is the local simulator. Nothing is sent to Hyperliquid.
- **Prices** come from Pyth Hermes (needs `PYTH_API_KEY`); trades settle against Pyth Core on Base.

## Deploying without GitHub secrets

Both workflows run shell scripts that work from any machine with Docker, Node and a Cloudflare token (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; plus `PYTH_API_KEY` for the runtime):

- `scripts/cloudflare-dev-deploy.sh` builds and publishes the runtime, UI and docs, and records the commit in KV `deployed-commit`. Behind a TLS-intercepting proxy, set `RFQ_DOCKER_BUILD_CA` to the proxy's CA bundle.
- `scripts/dev-contracts.sh ACTION [AMOUNT]` runs a dev-contracts action with the state from KV. Everything except `identities` and `preflight` sends Base mainnet transactions.

The live environment is on the RFQ Markets account: UI `https://rfq-markets-dev.rfq-markets.workers.dev`, docs `https://rfq-markets-docs-testnet.rfq-markets.workers.dev`.

## One-time setup (GitHub automation)

1. **Cloudflare.** Workers Paid on the RFQ Markets account (Containers need it). Create an API token from the "Edit Cloudflare Workers" template and add *Account → Containers → Edit*. Note the account ID.
2. **Owner key.** Fund the address in KV `owner-address` with about 0.02 ETH and the USDC you want to test with, on Base.
3. **GitHub** (repository Settings → Environments):
   - `cloudflare-dev`: secrets `CLOUDFLARE_API_TOKEN`, `PYTH_API_KEY`; optional `RFQ_BASE_MAINNET_RPC_URL` (defaults to `https://mainnet.base.org`) and `RFQ_BASE_MAINNET_SECONDARY_RPC_URL`. Variable `CLOUDFLARE_ACCOUNT_ID`.
   - `mainnet-dev`: add yourself as a required reviewer and limit deployment branches to `main`. Secret `CLOUDFLARE_API_TOKEN`; optional `RFQ_DEV_OWNER_KEY` (overrides the KV owner key), `RFQ_BASE_MAINNET_RPC_URL` and `RFQ_BASESCAN_API_KEY`. Variable `CLOUDFLARE_ACCOUNT_ID`; optional `RFQ_PYTH_CORE_ADDRESS` (defaults to `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`, which preflight checks) and `RFQ_DEV_POLICY_JSON` to change caps within the dev ceilings.
   - Repository variable `CLOUDFLARE_DEV_DEPLOY_ENABLED=true`.

## Running it

1. Merge to `main`. CI runs, then `deploy-cloudflare-dev.yml` publishes the UI and the runtime. Within a minute the runtime generates its keys and publishes their addresses. Until contracts exist the UI loads but trading reports the runtime as unavailable.
2. Actions → **Dev contracts (Base mainnet)** → `preflight`, approve the run, read the cost estimate.
3. Same workflow → `deploy`. It deploys the dev contracts with the runtime's approvers and emergency key, unpauses them, and tops the sponsor up to 0.003 ETH. The runtime picks up the new deployment within a minute.
4. `fund-maker` with an amount (default 100 USDC, the dev manifest's floor). Trades fail until maker capital meets the floor.
5. Open the UI and connect a wallet on Base.

Later: `upgrade` after contract changes land on `main` (storage-checked against the deployed build), `configure` after changing `RFQ_DEV_POLICY_JSON`, `fund-sponsor` when the sponsor runs low, `verify` and `basescan` any time. To start over on a fresh proxy, delete `deployment.json` from the KV namespace and run `deploy` again. If the runtime's Durable Object storage is ever lost, it generates new keys and refuses the old deployment; rotate approvers with the owner or deploy fresh.

## Not covered yet

- The hedge operations dashboard (`apps/admin`) and internal docs need Cloudflare Access first, so they are not deployed.
- No custom domain; the `workers.dev` address is used.
- Live hedging on Hyperliquid mainnet.
