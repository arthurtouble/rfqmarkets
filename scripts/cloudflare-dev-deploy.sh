#!/usr/bin/env bash
# Publishes the Base mainnet dev environment to Cloudflare: the dev runtime container, the trading UI
# and the docs (deploy/cloudflare/DEV-ENVIRONMENT.md). Used by deploy-cloudflare-dev.yml and for
# redeploys from any machine with Docker.
# Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and PYTH_API_KEY; RFQ_BASE_MAINNET_RPC_URL and
# RFQ_BASE_MAINNET_SECONDARY_RPC_URL are optional. Behind a TLS-intercepting proxy, set
# RFQ_DOCKER_BUILD_CA to a CA bundle; it is mounted only while npm installs and stays out of the image.
# RFQ_DOCKER_NODE_IMAGE swaps the Node base image for a mirror (for example
# public.ecr.aws/docker/library/node:24-bookworm-slim) when Docker Hub rate-limits. Expects `npm ci` to have run.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${PYTH_API_KEY:?PYTH_API_KEY is required}"
wrangler() { npx wrangler "$@"; }

npm run build:web
npm run build:docs
npm run validate:cloudflare-static
kv=$(node scripts/cloudflare-kv-namespace.mjs rfq-markets-dev-state)
sha=$(git rev-parse --short=12 HEAD)
generated=deploy/cloudflare/runtime/wrangler.dev.generated.jsonc

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

node -e 'const rpc=process.env.RFQ_BASE_MAINNET_RPC_URL||"https://mainnet.base.org";process.stdout.write(JSON.stringify({rpcUrl:rpc,secondaryRpcUrl:process.env.RFQ_BASE_MAINNET_SECONDARY_RPC_URL||rpc,pythApiKey:process.env.PYTH_API_KEY}))' \
  | wrangler secret put RFQ_DEV_RUNTIME_SECRETS --name rfq-markets-runtime-dev
wrangler deploy --config deploy/cloudflare/static/wrangler.web.dev.jsonc
wrangler deploy --config deploy/cloudflare/static/wrangler.docs.jsonc
wrangler kv key put deployed-commit "$(git rev-parse HEAD)" --namespace-id "$kv" --remote
