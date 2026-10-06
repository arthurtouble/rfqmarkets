#!/usr/bin/env bash
# Runs one Base mainnet dev-contracts action (dev-contracts.yml) against the state kept in the
# rfq-markets-dev-state KV namespace: loads the deployment record and the runtime's public keys,
# runs the action, and saves the record back.
#   scripts/dev-contracts.sh ACTION [AMOUNT]
# ACTION: identities, preflight, deploy, upgrade, unpause, fund-maker, fund-sponsor, configure, verify, basescan.
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. The owner key is RFQ_DEV_OWNER_KEY when set,
# otherwise the dev environment's `owner-key` KV entry. Expects `npm ci` and `npm run compile:contracts`.
# Every action except identities and preflight sends Base mainnet transactions.
set -euo pipefail
cd "$(dirname "$0")/.."
action=${1:?usage: dev-contracts.sh ACTION [AMOUNT]} amount=${2:-}
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
export STATE=${RFQ_MAINNET_DEV_STATE_DIR:-.local-state/base-mainnet-dev}
export RFQ_MAINNET_DEV_STATE_DIR=$STATE
kv=$(node scripts/cloudflare-kv-namespace.mjs rfq-markets-dev-state)
get() { npx wrangler kv key get "$1" --namespace-id "$kv" --remote --text > "$2" 2>/dev/null && [ -s "$2" ] || rm -f "$2"; }
put() { [ -f "$2" ] && npx wrangler kv key put "$1" --path "$2" --namespace-id "$kv" --remote || true; }

if [ -z "${RFQ_DEV_OWNER_KEY:-}" ]; then
  RFQ_DEV_OWNER_KEY=$(npx wrangler kv key get owner-key --namespace-id "$kv" --remote --text 2>/dev/null)
  [ -n "$RFQ_DEV_OWNER_KEY" ] || { echo "no RFQ_DEV_OWNER_KEY and no owner-key in KV" >&2; exit 1; }
fi
export RFQ_DEV_OWNER_KEY

save() {
  put deployment.json "$STATE/deployment.json"
  put build-info-deployed.json "$STATE/build-info-deployed/rfq-build.json"
  if [ -f "$STATE/deployment.json" ]; then npx wrangler kv key delete deployment.partial.json --namespace-id "$kv" --remote || true; else put deployment.partial.json "$STATE/deployment.partial.json"; fi
}

mkdir -p "$STATE/build-info-deployed"
get deployment.json "$STATE/deployment.json"
get deployment.partial.json "$STATE/deployment.partial.json"
get build-info-deployed.json "$STATE/build-info-deployed/rfq-build.json"
get identities.json "$STATE/runtime-identities.json"
node --import tsx scripts/base-mainnet-dev-ci.ts prepare
trap save EXIT

ci() { node --import tsx scripts/base-mainnet-dev-ci.ts "$@"; }
case "$action" in
  identities) ci identities ;;
  preflight) ci cli dev-preflight ;;
  deploy) ci cli dev-deploy --unpause && ci fund-sponsor ;;
  upgrade) ci cli dev-upgrade ;;
  configure) ci cli dev-configure ;;
  verify) ci cli dev-verify ;;
  basescan) ci cli dev-basescan ;;
  unpause) ci unpause ;;
  fund-maker) ci fund-maker "${amount:-100}" ;;
  fund-sponsor) ci fund-sponsor "${amount:-0.003}" ;;
  *) echo "unknown action $action" >&2; exit 2 ;;
esac
