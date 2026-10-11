#!/usr/bin/env bash
# Publishes the Base mainnet dev environment to Cloudflare: the three oracle nodes
# (scripts/cloudflare-oracle-deploy.sh), the dev runtime container, the trading UI and the docs
# (deploy/cloudflare/DEV-ENVIRONMENT.md). Used by deploy-cloudflare-dev.yml and for redeploys from any
# machine with Docker.
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; RFQ_BASE_MAINNET_RPC_URL, RFQ_BASE_MAINNET_SECONDARY_RPC_URL,
# RFQ_BASE_MAINNET_INDEXER_RPC_URL, RFQ_BASE_MAINNET_READ_RPC_URLS, RFQ_BASE_MAINNET_MAX_LOG_RANGE and
# CLOUDFLARE_WORKERS_SUBDOMAIN (default rfq-markets) are optional. Behind a TLS-intercepting proxy, set
# RFQ_DOCKER_BUILD_CA to a CA bundle; it is mounted only while npm installs and stays out of the image.
# RFQ_DOCKER_NODE_IMAGE swaps the Node base image for a mirror (for example
# public.ecr.aws/docker/library/node:24-bookworm-slim) when Docker Hub rate-limits. Expects `npm ci` to have run.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
export CLOUDFLARE_WORKERS_SUBDOMAIN="${CLOUDFLARE_WORKERS_SUBDOMAIN:-rfq-markets}"
wrangler() { npx wrangler "$@"; }

kv=$(node scripts/cloudflare-kv-namespace.mjs rfq-markets-dev-state)
# The dev contracts, once deployed: pinned into the trading UI and the exit page so neither trusts the API for them.
deployment=$(wrangler kv key get deployment.json --namespace-id "$kv" --remote 2>/dev/null || true)
read_deployment() { printf '%s' "$deployment" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s).$1;if(v!==undefined)process.stdout.write(String(v))}catch{}})"; }
clearing=$(read_deployment contracts.clearingProxy)
usdc=$(read_deployment contracts.usdc)

# The trading UI refuses a /v1/config that names another chain, clearing contract or USDC token, and signs
# only for the pinned contract. Before the first contract deployment only the chain is pinned.
VITE_CHAIN_ID=8453 VITE_CLEARING_ADDRESS="$clearing" VITE_TOKEN_ADDRESS="$usdc" npm run build:web
DOCS_SITE_URL="https://docs.$CLOUDFLARE_WORKERS_SUBDOMAIN.workers.dev" npm run build:docs
VITE_HEDGER_URL=/ops/hedger npm run build:admin
npm run build:internal-docs
npm run validate:cloudflare-static
sha=$(git rev-parse --short=12 HEAD)
generated=deploy/cloudflare/runtime/wrangler.dev.generated.jsonc

# Oracle nodes first: the runtime prices from them.
bash scripts/cloudflare-oracle-deploy.sh "$kv"

image="rfq-markets-runtime-dev:$sha"
build=(docker build --provenance=false --platform linux/amd64 -t "$image" -f Dockerfile.cloudflare-dev)
if [ -n "${RFQ_DOCKER_BUILD_CA:-}" ]; then build+=(--secret "id=ca,src=$RFQ_DOCKER_BUILD_CA"); fi
if [ -n "${RFQ_DOCKER_NODE_IMAGE:-}" ]; then build+=(--build-arg "NODE_IMAGE=$RFQ_DOCKER_NODE_IMAGE"); fi
DOCKER_BUILDKIT=1 "${build[@]}" .
wrangler containers push "$image"
sed -e "s/REPLACED_AT_DEPLOY/$kv/" \
    -e "s#\"image\": \"[^\"]*\"#\"image\": \"registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/$image\"#" \
    deploy/cloudflare/runtime/wrangler.dev.jsonc > "$generated"
wrangler deploy --config "$generated"

# The runtime runs on free public RPCs: publicnode for calls, transactions and the indexer's logs, drpc as
# the second RPC for the approver quorum, and Tenderly's public gateway as the fallback for the reads that run
# continuously (the hedger's exposure poll, the API's market snapshot). publicnode only serves recent blocks,
# so the indexer's catch-up from the deployment block falls back to Tenderly, which serves archive logs in
# 1,000-block ranges. Alchemy is no longer a default: its compute units ran out under this load, so
# ALCHEMY_API_KEY is not read here; set the RFQ_BASE_MAINNET_* variables to use any other RPC
# (RFQ_BASE_MAINNET_READ_RPC_URLS and RFQ_BASE_MAINNET_INDEXER_FALLBACK_RPC_URLS are comma-separated).
node -e 'const env=process.env,sub=env.CLOUDFLARE_WORKERS_SUBDOMAIN,publicnode="https://base-rpc.publicnode.com",tenderly="https://base.gateway.tenderly.co",list=(text)=>text.split(",").map(url=>url.trim()).filter(Boolean);process.stdout.write(JSON.stringify({rpcUrl:env.RFQ_BASE_MAINNET_RPC_URL||publicnode,secondaryRpcUrl:env.RFQ_BASE_MAINNET_SECONDARY_RPC_URL||"https://base.drpc.org",indexerRpcUrl:env.RFQ_BASE_MAINNET_INDEXER_RPC_URL||publicnode,indexerFallbackRpcUrls:list(env.RFQ_BASE_MAINNET_INDEXER_FALLBACK_RPC_URLS||tenderly),readRpcUrls:list(env.RFQ_BASE_MAINNET_READ_RPC_URLS||`${publicnode},${tenderly}`),maxLogRange:Number(env.RFQ_BASE_MAINNET_MAX_LOG_RANGE||1000),oracleNodes:[1,2,3].map(n=>`https://oracle-${n}.${sub}.workers.dev`)}))' \
  | wrangler secret put RFQ_DEV_RUNTIME_SECRETS --name rfq-markets-runtime-dev
wrangler deploy --config deploy/cloudflare/static/wrangler.web.dev.jsonc
wrangler deploy --config deploy/cloudflare/static/wrangler.docs.jsonc

# Private surfaces behind Cloudflare Access (private-edge.mjs locks them when Access is not set up).
deploy_private() { # worker config hostname-prefix label
  local flags
  flags=$(node scripts/cloudflare-access.mjs "$2.$CLOUDFLARE_WORKERS_SUBDOMAIN.workers.dev" "$3")
  # shellcheck disable=SC2086
  wrangler deploy --config "$1" $flags
}
deploy_private deploy/cloudflare/static/wrangler.admin.dev.jsonc admin "RFQ Markets hedge operations (dev)"
deploy_private deploy/cloudflare/static/wrangler.internal-docs.jsonc internal-docs "RFQ Markets internal docs"

# Direct exit page, built against the dev clearing contract once it exists (the runtime may have just
# deployed it on a first run).
if [ -z "$clearing" ]; then
  deployment=$(wrangler kv key get deployment.json --namespace-id "$kv" --remote 2>/dev/null || true)
  clearing=$(read_deployment contracts.clearingProxy)
fi
if [ -n "$clearing" ]; then
  # The oracle nodes default to the dev ones; the deployment block bounds the one-click key search.
  VITE_EXIT_CHAIN_ID=8453 VITE_EXIT_CLEARING_ADDRESS="$clearing" VITE_EXIT_DEPLOYMENT_BLOCK="$(read_deployment deploymentBlock)" \
    VITE_EXIT_APP_URL="https://dev.$CLOUDFLARE_WORKERS_SUBDOMAIN.workers.dev" \
    VITE_EXIT_DOCS_URL="https://docs.$CLOUDFLARE_WORKERS_SUBDOMAIN.workers.dev/protocol/safety-and-exits" npm run build:exit
  wrangler deploy --config deploy/cloudflare/static/wrangler.exit.dev.jsonc
fi
wrangler kv key put deployed-commit "$(git rev-parse HEAD)" --namespace-id "$kv" --remote
