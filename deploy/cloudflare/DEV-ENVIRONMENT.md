# Hosted dev environment (Base mainnet)

A development deployment people can open in a browser: the trading UI and docs on Cloudflare, every backend service in one Cloudflare Container, and the dev-profile contracts on Base mainnet (owner wallet, no timelock, dev caps; see [BASE-MAINNET-DEPLOYMENT.md](../../BASE-MAINNET-DEPLOYMENT.md)). It is for development only. It is not the production trust layout, and it must not hold customer funds.

| Piece | Where | Updated by |
| --- | --- | --- |
| Trading UI | Worker `rfq-markets-dev` → `https://rfq-markets-dev.<account>.workers.dev` | Every green CI run on `main` (`deploy-cloudflare-dev.yml`) |
| Docs | Worker `rfq-markets-docs-testnet` | Same |
| API, 3 approvers, indexer, simulated hedger, gateway | Container behind Worker `rfq-markets-runtime-dev` (no public route; reached only through the UI worker's service bindings) | Same |
| Contracts | Base mainnet, dev profile | Manually, `dev-contracts.yml`, each run approved in GitHub |

## How it fits together

- **Keys.** Every role key comes from one recovery phrase, the `RFQ_DEV_MNEMONIC` secret: account 1 is the owner (governance and ProxyAdmin), 2 the emergency council, 3–5 the approvers, 6 the gas sponsor. Restoring the phrase in any wallet app shows the owner as its first account. The owner key stays in GitHub; the runtime receives only the approver and sponsor keys, as the `RFQ_DEV_RUNTIME_SECRETS` Worker secret.
- **Deployment record.** The contracts workflow stores the record (public addresses, deployment block) and the deployed build-info in the `rfq-markets-dev-state` KV namespace. The runtime reads the record on start; a new proxy address restarts the runtime with empty journals.
- **Journals.** Container disk is ephemeral. The Durable Object that owns the container restores the SQLite journals on start and saves a consistent snapshot every minute (a cron that also keeps the container running). A crash can lose up to a minute of journal. The contract still enforces nonces, signatures and caps, so the loss is operational (an in-flight quote or commitment can be forgotten), not a way around the contract checks. This is acceptable only at dev caps; production uses persistent hosts ([deploy/host/README.md](../host/README.md)).
- **Hedging** is the local simulator. Nothing is sent to Hyperliquid.
- **Prices** come from Pyth Hermes (needs `PYTH_API_KEY`); trades settle against Pyth Core on Base.

## One-time setup

1. **Cloudflare.** Workers Paid on the RFQ Markets account (Containers need it). Create an API token from the "Edit Cloudflare Workers" template and add *Account → Containers → Edit*. Note the account ID.
2. **Wallet.** Create a brand-new wallet (fresh recovery phrase; never reuse one that holds anything else). Send its first account about 0.02 ETH and the USDC you want to test with, on Base.
3. **GitHub** (repository Settings → Environments):
   - `cloudflare-dev`: secret `CLOUDFLARE_API_TOKEN`, variable `CLOUDFLARE_ACCOUNT_ID`.
   - `mainnet-dev`: add yourself as a required reviewer. Secrets `CLOUDFLARE_API_TOKEN`, `RFQ_DEV_MNEMONIC` (the recovery phrase), `PYTH_API_KEY`; optional `RFQ_BASE_MAINNET_RPC_URL` (defaults to `https://mainnet.base.org`) and `RFQ_BASESCAN_API_KEY`. Variable `CLOUDFLARE_ACCOUNT_ID`; optional `RFQ_PYTH_CORE_ADDRESS` (defaults to `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`, which preflight checks) and `RFQ_DEV_POLICY_JSON` to change caps within the dev ceilings.
   - Repository variable `CLOUDFLARE_DEV_DEPLOY_ENABLED=true`.

## Running it

1. Merge to `main`. CI runs, then `deploy-cloudflare-dev.yml` publishes the UI and the runtime. Until contracts exist the UI loads but trading reports the runtime as unavailable.
2. Actions → **Dev contracts (Base mainnet)** → `preflight`, approve the run, read the cost estimate.
3. Same workflow → `deploy`. It deploys and unpauses the dev contracts, tops the sponsor up to 0.003 ETH, and hands the runtime its keys. The runtime picks up the new deployment within a minute.
4. `fund-maker` with an amount (default 100 USDC, the dev manifest's floor). Trades fail until maker capital meets the floor.
5. Open the UI and connect a wallet on Base.

Later: `upgrade` after contract changes land on `main` (storage-checked against the deployed build), `configure` after changing `RFQ_DEV_POLICY_JSON`, `fund-sponsor` when the sponsor runs low, `verify` and `basescan` any time. To start over on a fresh proxy, delete `deployment.json` from the KV namespace and run `deploy` again.

## Not covered yet

- The hedge operations dashboard (`apps/admin`) and internal docs need Cloudflare Access first, so they are not deployed.
- No custom domain; the `workers.dev` address is used.
- Live hedging on Hyperliquid mainnet.
