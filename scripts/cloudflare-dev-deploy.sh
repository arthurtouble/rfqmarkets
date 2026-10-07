#!/usr/bin/env bash
# Publishes the Base mainnet dev environment to Cloudflare: the three oracle nodes
# (scripts/cloudflare-oracle-deploy.sh), the dev runtime container, the trading UI and the docs
# (deploy/cloudflare/DEV-ENVIRONMENT.md). Used by deploy-cloudflare-dev.yml and for redeploys from any
# machine with Docker.
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; ALCHEMY_API_KEY, RFQ_BASE_MAINNET_RPC_URL,
# RFQ_BASE_MAINNET_SECONDARY_RPC_URL, RFQ_BASE_MAINNET_INDEXER_RPC_URL, RFQ_BASE_MAINNET_MAX_LOG_RANGE and
# CLOUDFLARE_WORKERS_SUBDOMAIN (default rfq-markets) are optional. Behind a TLS-intercepting proxy, set
# RFQ_DOCKER_BUILD_CA to a CA bundle; it is mounted only while npm installs and stays out of the image.
# RFQ_DOCKER_NODE_IMAGE swaps the Node base image for a mirror (for example
# public.ecr.aws/docker/library/node:24-bookworm-slim) when Docker Hub rate-limits. RFQ_ACCESS_EMAILS (default:
# KV access-emails) lists who Cloudflare Access lets into the operations dashboard and internal docs when their
# Access applications are first created. Expects `npm ci` to have run.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
export CLOUDFLARE_WORKERS_SUBDOMAIN="${CLOUDFLARE_WORKERS_SUBDOMAIN:-rfq-markets}"
wrangler() { npx wrangler "$@"; }

npm run build:web
npm run build:docs
npm run validate:cloudflare-static
kv=$(node scripts/cloudflare-kv-namespace.mjs rfq-markets-dev-state)
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

# With ALCHEMY_API_KEY set, the runtime sends calls to Alchemy and keeps drpc as the second RPC for the
# approver quorum. Without it, drpc is primary and mainnet.base.org secondary. Either way the indexer reads
# logs from mainnet.base.org in 500-block steps (its cap): Alchemy's free tier and drpc cap eth_getLogs at
# 10 blocks. Override with the RFQ_BASE_MAINNET_* variables.
node -e 'const env=process.env,key=env.ALCHEMY_API_KEY,sub=env.CLOUDFLARE_WORKERS_SUBDOMAIN;const rpc=env.RFQ_BASE_MAINNET_RPC_URL||(key?`https://base-mainnet.g.alchemy.com/v2/${key}`:"https://base.drpc.org");process.stdout.write(JSON.stringify({rpcUrl:rpc,secondaryRpcUrl:env.RFQ_BASE_MAINNET_SECONDARY_RPC_URL||(key?"https://base.drpc.org":"https://mainnet.base.org"),indexerRpcUrl:env.RFQ_BASE_MAINNET_INDEXER_RPC_URL||"https://mainnet.base.org",maxLogRange:Number(env.RFQ_BASE_MAINNET_MAX_LOG_RANGE||500),oracleNodes:[1,2,3].map(n=>`https://rfq-markets-oracle-${n}.${sub}.workers.dev`)}))' \
  | wrangler secret put RFQ_DEV_RUNTIME_SECRETS --name rfq-markets-runtime-dev
wrangler deploy --config deploy/cloudflare/static/wrangler.web.dev.jsonc
wrangler deploy --config deploy/cloudflare/static/wrangler.docs.jsonc

# Private surfaces behind Cloudflare Access (private-edge.mjs locks them when Access is not set up).
export RFQ_ACCESS_EMAILS="${RFQ_ACCESS_EMAILS:-$(wrangler kv key get access-emails --namespace-id "$kv" --remote 2>/dev/null || true)}"
deploy_private() { # worker config hostname-prefix label
  local flags
  flags=$(node scripts/cloudflare-access.mjs "$2.$CLOUDFLARE_WORKERS_SUBDOMAIN.workers.dev" "$3")
  # shellcheck disable=SC2086
  wrangler deploy --config "$1" $flags
}
VITE_HEDGER_URL=/ops/hedger npm run build:admin
npm run build:internal-docs
deploy_private deploy/cloudflare/static/wrangler.admin.dev.jsonc rfq-markets-admin-dev "RFQ Markets hedge operations (dev)"
deploy_private deploy/cloudflare/static/wrangler.internal-docs.jsonc rfq-markets-internal-docs-testnet "RFQ Markets internal docs"

# Direct exit page, built against the dev clearing contract once it exists.
clearing=$(wrangler kv key get deployment.json --namespace-id "$kv" --remote 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).contracts.clearingProxy)}catch{}})')
if [ -n "$clearing" ]; then
  VITE_EXIT_CHAIN_ID=8453 VITE_EXIT_CLEARING_ADDRESS="$clearing" npm run build:exit
  wrangler deploy --config deploy/cloudflare/static/wrangler.exit.dev.jsonc
fi
wrangler kv key put deployed-commit "$(git rev-parse HEAD)" --namespace-id "$kv" --remote
