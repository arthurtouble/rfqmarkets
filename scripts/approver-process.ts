import { QUOTE_MODEL_VERSION } from "../packages/shared/src/pricing.js";
import { buildApprover } from "../services/approver/src/server.js";
import type { OracleMode } from "../services/approver/src/options.js";

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

const rpcUrl = required("RFQ_RPC_URL");
const app = buildApprover({
  privateKey: required("RFQ_APPROVER_KEY"),
  transportToken: required("RFQ_APPROVER_TOKEN"),
  databasePath: required("RFQ_APPROVER_DB"),
  expectedChainId: BigInt(required("RFQ_CHAIN_ID")),
  expectedVerifyingContract: required("RFQ_CLEARING_ADDRESS"),
  expectedQuoteModelVersion: env.RFQ_QUOTE_MODEL_VERSION ?? QUOTE_MODEL_VERSION,
  rpcUrl,
  secondaryRpcUrl: env.RFQ_SECONDARY_RPC_URL ?? rpcUrl,
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
