# Hosted dev environment (Base mainnet)

A development deployment people can open in a browser: the trading UI and docs on Cloudflare, every backend service in one Cloudflare Container, and the dev-profile contracts on Base mainnet (owner wallet, no timelock, dev caps; see [Base mainnet deployment](../../docs/operations/base-mainnet.md)). It is for development only. It is not the production trust layout, and it must not hold customer funds.

| Piece | Where | Updated by |
| --- | --- | --- |
| Trading UI | Worker `dev` → `https://dev.<account>.workers.dev` | Every green CI run on `main` (`deploy-cloudflare-dev.yml`) |
| Docs | Worker `docs` → `https://docs.<account>.workers.dev` | Same |
| Hedge operations dashboard (`apps/admin`) | Worker `admin`, behind Cloudflare Access | Same |
| Internal docs (`apps/internal-docs`) | Worker `internal-docs`, behind Cloudflare Access | Same |
| Direct exit page (`apps/exit`) | Worker `exit`, public, built for the clearing address in KV `deployment.json` | Same, once contracts exist |
| Oracle nodes 1-3 | Workers `oracle-1` (`wnam`), `-2` (`weur`), `-3` (`apac`), each one container | Same, one node at a time |
| API, 3 approvers, indexer, simulated hedger, gateway | Container behind Worker `rfq-markets-runtime-dev` (no public route; reached only through the UI worker's service bindings) | Same |
| Contracts | Base mainnet, dev profile | Manually, `dev-contracts.yml`, each run approved in GitHub |

## How it fits together

- **Keys.** The owner (governance and ProxyAdmin) is a dedicated private key generated for this environment and kept in the `owner-key` entry of the `rfq-markets-dev-state` KV namespace (its address is in `owner-address`). An `RFQ_DEV_OWNER_KEY` secret in the `mainnet-dev` environment overrides it. The emergency council, three approvers and gas sponsor are generated inside the runtime's Durable Object on first start and never leave Cloudflare. The runtime publishes only their addresses (KV `identities.json`), and it refuses to run against a deployment whose approver set is not its own keys. No recovery phrase is stored anywhere. Each oracle node's signer key is generated the same way inside that node's own Durable Object and published only as an address (KV `oracle-node-<n>.json`). The `RFQ_DEV_RUNTIME_SECRETS` Worker secret holds only the RPC URLs and the three oracle node URLs.
- **Deployment record.** The contracts workflow stores the record (public addresses, deployment block) and the deployed build-info in the `rfq-markets-dev-state` KV namespace. The runtime reads the record on start; a new proxy address restarts the runtime with empty journals.
- **Journals.** Container disk is ephemeral. The Durable Object that owns the container restores the SQLite journals on start and saves a consistent snapshot every minute (a cron that also keeps the container running). A crash can lose up to a minute of journal. The contract still enforces nonces, signatures and caps, so the loss is operational (an in-flight quote or commitment can be forgotten), not a way around the contract checks. This is acceptable only at dev caps; production uses persistent hosts ([deploy/host/README.md](../host/README.md)).
- **Hedging** is the local simulator. Nothing is sent to Hyperliquid.
- **Prices** come from our three oracle nodes (below). The API combines their signed batches and trades settle against the `SignedPriceOracle` adapter, which accepts a 2-of-3 majority.

## Oracle nodes

| Node | URL | Durable Object region |
| --- | --- | --- |
| 1 | `https://oracle-1.rfq-markets.workers.dev` | `wnam` (western North America) |
| 2 | `https://oracle-2.rfq-markets.workers.dev` | `weur` (western Europe) |
| 3 | `https://oracle-3.rfq-markets.workers.dev` | `apac` (Asia-Pacific) |

Each node is its own Worker (`deploy/cloudflare/runtime/oracle-worker.mjs`, rendered from `wrangler.oracle.jsonc`) with one Container-backed Durable Object running `services/oracle-node` (`Dockerfile.cloudflare-oracle`). The region is a location hint for the Durable Object; Cloudflare places the container near it. Separate workers mean a deploy rolls one node at a time and each key lives in its own Durable Object namespace.

- **Keys.** On first use the Durable Object creates a key, keeps it only in its storage, and writes `{ "address": ... }` to KV `oracle-node-<n>.json`. These three addresses are the signers the dev `SignedPriceOracle` adapter must be deployed with. No route returns the key.
- **Domain.** The node signs EIP-712 batches for chain 8453 and the adapter in KV `deployment.json` (`contracts.oracleAdapter`), BTC (market 0) and ETH (1). Until that record exists and its `oracle.signers` include the node, every node route answers 503 `oracle_not_ready` with a reason. A new adapter restarts the container on the new domain within a minute.
- **Routes** (GET only, per-IP and global rate limits): `/health`, `/v1/batch/latest`, `/v1/batch/stream` (SSE) from the node; `/v1/history/candles?market=&interval=1m|5m|15m|1h|4h|1d&from=&to=` and `/v1/history/batches?market=&from=&to=&limit=` from storage. Times are unix seconds.
- **History.** A cron every minute keeps the container running and copies what it signed into the Durable Object's SQLite: every signed batch for 30 days and one-minute candles permanently (coarser intervals are resampled on read). History routes read only SQLite, so they keep working while the container restarts; a crash loses at most the last minute. `/v1/history/batches` returns each batch exactly as signed, with `signature`, `signer`, `chainId` and `verifyingContract`, so anyone can check a trade's price by recovering the signer from the adapter's EIP-712 domain (`recoverBatchSigner` in `packages/shared/src/signed-oracle.ts`). Pages hold at most 1,000 batches; follow `next`.

## Private pages (Cloudflare Access)

The hedge operations dashboard and the internal docs sit behind a Cloudflare Access application each, which signs people in with their Cloudflare account and lets in only members of the RFQ Markets Cloudflare account. Their worker (`deploy/cloudflare/static/private-edge.mjs`) also checks the Access token on every request, assets included, against the application's audience tag, so a missing or misconfigured Access application leaves the page locked rather than public.

- `scripts/cloudflare-access.mjs` runs during the deploy: it creates the Access application on first use, allowing the account's Cloudflare login method (restricted to account members), and passes the team domain and audience tag to the worker. An existing application keeps its policy; change who may sign in under Zero Trust → Access → Applications.
- It needs Zero Trust enabled on the account (any plan) and the API token permissions *Account → Access: Apps and Policies → Edit* and *Account → Access: Organizations, Identity Providers, and Groups → Read*. Without them the deploy warns and the pages answer 503.
- The dashboard reads the indexer's `/v1/risk` and update stream and the hedger's `/v1/status[/stream]` through the runtime's service binding (`/ops/hedger/...`). The runtime adds the hedger's operations token, which it keeps in its Durable Object; the browser never sees it. The public UI worker does not forward `/ops/` paths.

## Deploying without GitHub secrets

Both workflows run shell scripts that work from any machine with Docker, Node and a Cloudflare token (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`):

- `scripts/cloudflare-dev-deploy.sh` builds and publishes the oracle nodes (`scripts/cloudflare-oracle-deploy.sh`, which waits for each node before deploying the next), the runtime, UI, docs, the private pages and the exit page, and records the commit in KV `deployed-commit`. The trading UI is built with `VITE_CHAIN_ID=8453` and, once KV `deployment.json` exists, `VITE_CLEARING_ADDRESS` and `VITE_TOKEN_ADDRESS` from it, so it refuses a `/v1/config` naming other contracts (`apps/web/src/wallet/settlement.ts`); after a contract redeployment, redeploy the UI. Set `CLOUDFLARE_WORKERS_SUBDOMAIN` if the account's `workers.dev` subdomain is not `rfq-markets`. Behind a TLS-intercepting proxy, set `RFQ_DOCKER_BUILD_CA` to the proxy's CA bundle.
- `scripts/dev-contracts.sh ACTION [AMOUNT]` runs a dev-contracts action with the state from KV. Everything except `identities` and `preflight` sends Base mainnet transactions.

The live environment is on the RFQ Markets account: UI `https://dev.rfq-markets.workers.dev`, docs `https://docs.rfq-markets.workers.dev`.

## One-time setup (GitHub automation)

1. **Cloudflare.** Workers Paid on the RFQ Markets account (Containers need it). Create an API token from the "Edit Cloudflare Workers" template and add *Account → Containers → Edit*. Note the account ID.
2. **Owner key.** Fund the address in KV `owner-address` with about 0.02 ETH and the USDC you want to test with, on Base.
3. **GitHub** (repository Settings → Environments):
   - `cloudflare-dev`: secret `CLOUDFLARE_API_TOKEN`; optional `ALCHEMY_API_KEY` (a Base Mainnet Alchemy app; makes Alchemy the primary RPC with `https://base.drpc.org` as the secondary), `RFQ_BASE_MAINNET_RPC_URL` (defaults to Alchemy when the key is set, else `https://base.drpc.org`), `RFQ_BASE_MAINNET_SECONDARY_RPC_URL` (defaults to drpc with Alchemy, else `https://mainnet.base.org`), `RFQ_BASE_MAINNET_INDEXER_RPC_URL` (defaults to `https://mainnet.base.org`; Alchemy's free tier caps `eth_getLogs` at 10 blocks), and `RFQ_BASE_MAINNET_MAX_LOG_RANGE` (blocks per indexer `eth_getLogs` call, default 500). Variable `CLOUDFLARE_ACCOUNT_ID`; optional `CLOUDFLARE_WORKERS_SUBDOMAIN` (defaults to `rfq-markets`).
   - `mainnet-dev`: add yourself as a required reviewer and limit deployment branches to `main`. Secret `CLOUDFLARE_API_TOKEN`; optional `RFQ_DEV_OWNER_KEY` (overrides the KV owner key), `ALCHEMY_API_KEY`, `RFQ_BASE_MAINNET_RPC_URL` (defaults to Alchemy when the key is set, else `https://mainnet.base.org`) and `RFQ_BASESCAN_API_KEY`. Variable `CLOUDFLARE_ACCOUNT_ID`; optional `RFQ_DEV_ORACLE_SIGNERS` (comma-separated; overrides the three addresses the oracle node workers publish to KV) and optional `RFQ_DEV_POLICY_JSON` to change caps within the dev ceilings.
   - Repository variable `CLOUDFLARE_DEV_DEPLOY_ENABLED=true`.

## Running it

1. Merge to `main`. CI runs, then `deploy-cloudflare-dev.yml` publishes the oracle nodes, the UI and the runtime. Within a minute the runtime and each oracle node generate their keys and publish their addresses. Until contracts exist the UI loads but trading reports the runtime as unavailable.
2. Actions → **Dev contracts (Base mainnet)** → `preflight`, approve the run, read the cost estimate.
3. Same workflow → `deploy`. It deploys the dev contracts with the runtime's approvers and emergency key, unpauses them, and tops the sponsor up to 0.003 ETH. The runtime picks up the new deployment within a minute.
4. `fund-maker` with an amount (default 100 USDC, the dev manifest's floor). Trades fail until maker capital meets the floor.
5. Open the UI and connect a wallet on Base.

Later: `upgrade` after contract changes land on `main` (storage-checked against the deployed build), `configure` after changing `RFQ_DEV_POLICY_JSON`, `fund-sponsor` when the sponsor runs low, `verify` and `basescan` any time. To start over on a fresh proxy, delete `deployment.json` from the KV namespace and run `deploy` again. If the runtime's Durable Object storage is ever lost, it generates new keys and refuses the old deployment; rotate approvers with the owner or deploy fresh. If an oracle node worker is replaced or renamed, it gets a new Durable Object and a new key; once the new nodes have published their addresses, run `oracle-signers` to move the adapter to them (one owner transaction), then delete the old workers.

## Not covered yet

- No custom domain; the `workers.dev` address is used.
- Live hedging on Hyperliquid mainnet.
