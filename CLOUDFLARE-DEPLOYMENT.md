# Cloudflare testnet deployment

Status: the deployment design and static-site CI are source controlled. The public testnet shell and public documentation are deployed to the RFQ Markets Cloudflare account. Service ports remain intentionally unavailable until the edge/API runtime is deployed. This is a testnet hosting profile, not the final production trust layout.

## Current testnet surfaces

| Surface | URL | Status |
| --- | --- | --- |
| Trading terminal | `https://rfq-markets-testnet.rfq-markets.workers.dev` | Static shell deployed with same-origin service routes; trading remains disabled until API, indexer and market-stream routes are live. |
| Public documentation | `https://rfq-markets-docs-testnet.rfq-markets.workers.dev` | Deployed and usable. |
| Internal manuals | Local port 4176 only | Deliberately withheld until Cloudflare Access is configured and verified deny-by-default. |

Both public surfaces send CSP, HSTS, frame-denial, MIME-sniffing, referrer and permissions-policy headers. Hashed assets use immutable caching; HTML revalidates. `npm run validate:cloudflare-static` rejects production bundles containing the local service ports and rejects missing security-header files.

## Decision

Cloudflare is useful now for public ingress, static applications, streaming fanout, test telemetry, immutable research tapes and scheduled calibration. It must not collapse the production security model into one provider or one control plane.

| Component | Testnet Cloudflare placement | Durable state | Production direction |
| --- | --- | --- | --- |
| Trading UI and public docs | Workers Static Assets | Git build artifact | Cloudflare edge remains appropriate |
| Internal docs and hedge UI | Static Assets behind Access | Git build artifact | Private identity-aware access |
| Public API ingress | Worker with WAF, rate limits and service binding | None | Edge remains stateless |
| Market SSE fanout | Worker plus market-sharded Durable Objects | Short replay ring in DO SQLite | Multi-region edge fanout |
| API coordinator and sponsor | One explicitly selected stateful instance; initially Container or VPS origin | External durable journal | Isolated active/passive hosts |
| Approvers | Three separately deployed services reachable only over private bindings | Independent append-only journals | Different providers/accounts and hardware-backed keys |
| Indexer/Ponder | Container or external managed runtime | PostgreSQL | Dedicated database with replicas/backups |
| Hedge worker | Isolated Container for testnet only | D1/R2 journal plus venue reconciliation | Dedicated private host and hardware-backed venue key |
| Market-flow recorder | Durable Object connection manager, Queue, R2 shards and Workflow | Immutable R2 objects and manifests | Independent redundant collectors |
| Calibration | Workflow-triggered research job or CI artifact initially | Versioned reports in private R2 | Dedicated research runtime |

Ordinary Workers are request-scoped and are not a drop-in host for the existing Fastify processes, SQLite journals or Python Hyperliquid bridge. Containers can run the existing runtime on the Workers Paid plan, but their local disk cannot be the sole journal. The first Cloudflare service work therefore starts with static surfaces and a new edge boundary; stateful services move only after their journals use explicit durable bindings.

## Target request path

```text
Browser
  -> Cloudflare DNS / TLS / WAF / rate limiting
  -> public edge Worker
       -> static trading asset
       -> market-sharded Durable Object for SSE
       -> private service binding to active API coordinator
            -> private approver A / B / C
            -> Base RPC quorum and Pyth
            -> sponsor sender journal
  -> Base clearing contract

Finalized Base events -> indexer -> public read API
                               -> private hedge worker -> Hyperliquid testnet

Coinbase + Binance -> recorder DO -> Queue -> immutable R2 shards
                                      -> calibration workflow -> private reports
```

The edge cannot approve trades, sign maker commitments, hold governance authority or change risk parameters. Firm execution still requires the wallet intent, two independent approver signatures, valid settlement evidence and contract checks.

## Environments

- Pull requests: local tests and production builds only. No persistent Cloudflare resources and no chain writes.
- Testnet: Base Sepolia, Pyth test feeds, Hyperliquid testnet, capped disposable keys and Cloudflare test resources.
- Production: separate Cloudflare account/project, separate domains, new secrets, independent approver hosts and explicit release approval.

Never share bindings, buckets, databases, queues, service names or secrets between testnet and production. Wrangler environment configuration is non-inheriting; declare every binding per environment and validate generated types in CI.

## GitHub CI/CD

`.github/workflows/ci.yml` runs the complete repository validation on pull requests and pushes to `main`. `.github/workflows/deploy-cloudflare.yml` deploys only the public trading and documentation assets after CI succeeds. Deployment remains disabled until the GitHub environment variable `CLOUDFLARE_DEPLOY_ENABLED` is set to `true`.

Required GitHub testnet environment configuration:

- `CLOUDFLARE_API_TOKEN`: narrowly scoped to edit Workers Scripts for the selected account. Do not use a global API key.
- `CLOUDFLARE_ACCOUNT_ID`: non-secret variable containing the selected account identifier.

The internal manuals and hedge dashboard are excluded from automatic deployment until a Cloudflare Access application and deny-by-default policy are verified. API keys, wallet keys, approver keys, sponsor keys and hedge keys never enter GitHub build logs or static Vite variables.

## Long-running market-flow study

The current laptop recorder remains useful while the Cloudflare collector is built. A qualifying run requests 25 hours so the observed trade interval can exceed the 24-hour gate after startup and retain five-minute forward labels:

```bash
npm run capture:market-flow -- --seconds 90000 --output .local-state/market-flow/study-01.csv
npm run calibrate:market-flow -- ../.local-state/market-flow/study-01.csv \
  --horizons-ms 1000,5000,30000,300000 \
  --output ../.local-state/calibration/study-01.json
```

The recorder writes an atomic `.progress.json` every ten seconds and always flushes a completion summary on normal timeout, `SIGINT` or `SIGTERM`. An interrupted capture, missing summary, transport error or sequence gap fails the promotion gates.

The Cloudflare replacement uses one recorder Durable Object per venue and market, not one global object. Each object maintains the upstream connection and monotonically checks trade IDs. Small normalized batches enter a Queue; the consumer writes time-partitioned immutable R2 objects and a manifest. A Workflow waits for all label horizons, verifies hashes and completeness, launches calibration, and records the report as research-only. No workflow writes active quote configuration.

## Resource creation sequence

1. Authenticate Wrangler to the test Cloudflare account and confirm Workers Paid if Containers are required.
2. Deploy the public static applications to generated `workers.dev` addresses.
3. Add the chosen testnet domain and validate headers, caching, CSP and SPA routing.
4. Configure Cloudflare Access before deploying internal documentation or hedge operations.
5. Create private R2 buckets for raw tapes and reports, then Queues and market-sharded recorder Durable Objects.
6. Port the stateless API ingress and SSE fanout. Load-test the edge independently from the coordinator.
7. Move the API coordinator only after its reservation, sender and paid-flow journals have durable external storage and restart tests.
8. Move Ponder/indexing and the testnet hedge worker last. Re-run chain reorg, acknowledgement-loss, partial-fill and venue-outage drills.

## What is needed from the account owner

After the repository-side setup passes locally, the remaining inputs are:

1. A Cloudflare account with Workers enabled; Workers Paid is needed only if we choose Containers for the existing Node/Python services.
2. Browser authorization for `wrangler login`, or a narrowly scoped testnet deployment token entered through the interactive secret flow.
3. The Cloudflare account and zone/domain to use. Generated `workers.dev` addresses are sufficient for the first test.
4. Authorization to install the Cloudflare GitHub App or permission to add the two GitHub environment secrets and one enable variable listed above.
5. The identities allowed into the internal-docs and hedge-operations Access application.

No Pyth, RPC, sponsor, approver or Hyperliquid secret should be sent in chat. They will be entered directly into the corresponding Cloudflare secret store or future private host.

## Verification and rollback

- CI must pass before deployment and Wrangler performs a dry run before publishing.
- Smoke-test asset hashes, CSP, caching, navigation and mobile layouts at the generated testnet URLs.
- Record the deployed Git commit and Worker version identifiers.
- Roll back static applications by redeploying the previous immutable Git commit or selecting the prior Worker version.
- A failed edge deployment cannot mutate contracts, maker limits or venue positions.
- Stateful migration rollback requires journal reconciliation before the old coordinator can become active.

## Production limits of this profile

Cloudflare testnet hosting improves availability and removes dependence on an awake laptop. It does not prove provider independence, geographic/legal suitability, hardware key custody, sustained oracle/RPC latency, or mainnet economics. In production, the three approvers must not all inherit one Cloudflare account compromise, and the hedge key must remain outside public edge workloads.
