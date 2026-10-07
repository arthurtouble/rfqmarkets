#!/usr/bin/env bash
# Builds the oracle node image once and deploys the three oracle node workers one at a time
# (oracle-1 wnam, -2 weur, -3 apac; deploy/cloudflare/DEV-ENVIRONMENT.md). After each
# deploy it waits for that node to answer before touching the next, so a bad build stops after one node.
# Usage: scripts/cloudflare-oracle-deploy.sh KV_NAMESPACE_ID. Called by scripts/cloudflare-dev-deploy.sh.
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Optional: CLOUDFLARE_WORKERS_SUBDOMAIN
# (default rfq-markets), RFQ_ORACLE_ROLLOUT_TIMEOUT seconds per node (default 300),
# RFQ_ORACLE_RENDER_ONLY=1 to only write the configs, and RFQ_DOCKER_BUILD_CA / RFQ_DOCKER_NODE_IMAGE as
# for the runtime image.
set -euo pipefail
cd "$(dirname "$0")/.."
kv="${1:?usage: cloudflare-oracle-deploy.sh KV_NAMESPACE_ID}"
: "${CLOUDFLARE_ACCOUNT_ID:?}"
subdomain="${CLOUDFLARE_WORKERS_SUBDOMAIN:-rfq-markets}"
timeout="${RFQ_ORACLE_ROLLOUT_TIMEOUT:-300}"
wrangler() { npx wrangler "$@"; }
regions=(wnam weur apac)

sha=$(git rev-parse --short=12 HEAD)
image="rfq-markets-oracle:$sha"
render() {
  local index=$1 hint=$2
  sed -e "s/ORACLE_NODE_INDEX_VALUE/$index/g" \
      -e "s/ORACLE_LOCATION_HINT_VALUE/$hint/g" \
      -e "s/REPLACED_AT_DEPLOY/$kv/" \
      -e "s#\"image\": \"[^\"]*\"#\"image\": \"registry.cloudflare.com/$CLOUDFLARE_ACCOUNT_ID/$image\"#" \
      deploy/cloudflare/runtime/wrangler.oracle.jsonc > "deploy/cloudflare/runtime/wrangler.oracle-$index.generated.jsonc"
}
for index in 1 2 3; do render "$index" "${regions[$((index - 1))]}"; done
if [ "${RFQ_ORACLE_RENDER_ONLY:-}" = 1 ]; then exit 0; fi
: "${CLOUDFLARE_API_TOKEN:?}"

build=(docker build --provenance=false --platform linux/amd64 -t "$image" -f Dockerfile.cloudflare-oracle)
if [ -n "${RFQ_DOCKER_BUILD_CA:-}" ]; then build+=(--secret "id=ca,src=$RFQ_DOCKER_BUILD_CA"); fi
if [ -n "${RFQ_DOCKER_NODE_IMAGE:-}" ]; then build+=(--build-arg "NODE_IMAGE=$RFQ_DOCKER_NODE_IMAGE"); fi
DOCKER_BUILDKIT=1 "${build[@]}" .
wrangler containers push "$image"

# A node is up when /health is 200, or when it is serving but waiting for a deployment that names it;
# anything else (including node_start_failed) holds the rollout.
wait_for() {
  local url="https://oracle-$1.$subdomain.workers.dev/health" deadline=$((SECONDS + timeout)) body
  while [ "$SECONDS" -lt "$deadline" ]; do
    body=$(curl -sS --max-time 10 -w '\n%{http_code}' "$url" 2>/dev/null || true)
    case "${body##*$'\n'}" in
      200) echo "oracle node $1 is signing"; return 0 ;;
      503) if grep -Eq '"reason":"(contracts_not_deployed|oracle_adapter_missing|signer_not_in_deployment)"' <<<"$body"; then echo "oracle node $1 is up, waiting for a deployment: $(head -n 1 <<<"$body")"; return 0; fi ;;
    esac
    sleep 10
  done
  echo "oracle node $1 did not come back within ${timeout}s; stopping the rollout" >&2
  return 1
}
for index in 1 2 3; do
  wrangler deploy --config "deploy/cloudflare/runtime/wrangler.oracle-$index.generated.jsonc"
  wait_for "$index"
done
