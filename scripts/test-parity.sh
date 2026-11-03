#!/usr/bin/env bash
# Production-parity gate: boots the local stack with the dev/mainnet oracle path (SignedPriceOracle, three signing
# oracle nodes, signed-mode approvers, no dev-chain shortcuts) and runs the trader's journey against it.
# Usage: npm run test:parity [-- --skip-compile]. Logs: .local-state/parity-stack.log.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .local-state
log=.local-state/parity-stack.log
if curl -sf http://127.0.0.1:4100/health >/dev/null 2>&1; then
  echo "Something already answers on :4100; stop the running stack first." >&2
  exit 1
fi
setsid npm run --silent dev:stack -- --parity "$@" >"$log" 2>&1 &
stack=$!
cleanup() { kill -TERM -- "-$stack" 2>/dev/null || true; wait "$stack" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 200); do
  curl -sf http://127.0.0.1:4100/health >/dev/null 2>&1 && break
  if ! kill -0 "$stack" 2>/dev/null; then
    tail -50 "$log" >&2
    exit 1
  fi
  sleep 3
done
curl -sf http://127.0.0.1:4100/health >/dev/null || { tail -50 "$log" >&2; exit 1; }
status=0
RFQ_PRICE_CONTROL_URL=http://127.0.0.1:4600 npm run --silent journey || status=$?
if [ "$status" -ne 0 ]; then
  echo "--- last stack log lines ---" >&2
  grep -v ExperimentalWarning "$log" | tail -60 >&2
fi
exit "$status"
