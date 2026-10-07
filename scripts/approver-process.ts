import { QUOTE_MODEL_VERSION } from "../packages/shared/src/pricing.js";
import { buildApprover } from "../services/approver/src/server.js";
import type { OracleMode } from "../services/approver/src/options.js";
import { requireStrongToken } from "../services/lib/src/auth.js";
import { rpcEndpointsMatch } from "./persistent-config.js";

const env = process.env;
const required = (name: string) => {
  const value = env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
/** Misconfigured numbers fail startup instead of turning comparisons into NaN no-ops. */
const integer = (name: string, fallback?: number) => {
  const value = fallback === undefined ? Number(required(name)) : Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${name}`);
  return value;
};
const oracleMode = (env.RFQ_ORACLE_MODE ?? "local") as OracleMode;
if (!["local", "signed"].includes(oracleMode)) throw new Error("invalid RFQ_ORACLE_MODE");

const rpcUrl = required("RFQ_RPC_URL"),
  secondaryRpcUrl = env.RFQ_SECONDARY_RPC_URL || rpcUrl,
  chainId = BigInt(required("RFQ_CHAIN_ID"));
// The secondary RPC independently cross-checks chain reads: on Base mainnet it must be a different
// endpoint; elsewhere a shared one only warns (local Hardhat has a single node).
if (rpcEndpointsMatch(rpcUrl, secondaryRpcUrl)) {
  if (chainId === 8453n)
    throw new Error("RFQ_SECONDARY_RPC_URL must differ from RFQ_RPC_URL on Base mainnet");
  if (chainId !== 31337n)
    console.warn("[approver] RFQ_SECONDARY_RPC_URL equals RFQ_RPC_URL: chain reads are not cross-checked");
}
const app = buildApprover({
  privateKey: required("RFQ_APPROVER_KEY"),
  transportToken: requireStrongToken("RFQ_APPROVER_TOKEN", env.RFQ_APPROVER_TOKEN),
  databasePath: required("RFQ_APPROVER_DB"),
  expectedChainId: chainId,
  expectedVerifyingContract: required("RFQ_CLEARING_ADDRESS"),
  expectedQuoteModelVersion: env.RFQ_QUOTE_MODEL_VERSION ?? QUOTE_MODEL_VERSION,
  rpcUrl,
  secondaryRpcUrl,
  rpcBatchMaxCount: integer("RFQ_RPC_BATCH_MAX_COUNT", 1),
  maxFutureSeconds: integer("RFQ_MAX_FUTURE_SECONDS", 5),
  oracleMode,
  hedgeRisk:
    env.RFQ_HEDGE_RISK_URL && env.RFQ_HEDGE_RISK_TOKEN
      ? {
          url: env.RFQ_HEDGE_RISK_URL,
          token: env.RFQ_HEDGE_RISK_TOKEN,
          maxAgeMs: integer("RFQ_HEDGE_RISK_MAX_AGE_MS", 3_000),
        }
      : undefined,
});
await app.listen({ host: "127.0.0.1", port: integer("RFQ_APPROVER_PORT") });
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
