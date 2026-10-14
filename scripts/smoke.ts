// Runs one smoke or load check by name: `npm run smoke -- funds`. Extra arguments pass through.
import { spawnSync } from "node:child_process";

const SMOKES: Record<string, string> = {
  local: "live-smoke.ts",
  funds: "funds-smoke.ts",
  reorg: "reorg-smoke.ts",
  failover: "leader-failover-smoke.ts",
  "approver-outage": "approver-outage-smoke.ts",
  "sender-replacement": "sender-replacement-smoke.ts",
  "settlement-concurrency": "settlement-concurrency-smoke.ts",
  "quote-load": "quote-load-smoke.ts",
  "adversarial-load": "adversarial-load.ts",
  "limit-order": "limit-order-smoke.ts",
  "live-market": "live-market-data-smoke.ts",
  "sse-gateway": "sse-gateway-load.ts",
  "runtime-readiness": "runtime-readiness.ts",
  "hyperliquid-testnet": "hyperliquid-testnet-smoke.ts",
};

const [name, ...rest] = process.argv.slice(2);
const script = name ? SMOKES[name] : undefined;
if (!script) {
  console.error(`Usage: npm run smoke -- <name> [args]\nNames: ${Object.keys(SMOKES).join(", ")}`);
  process.exit(2);
}
const result = spawnSync(process.execPath, ["--import", "tsx", `scripts/${script}`, ...rest], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
