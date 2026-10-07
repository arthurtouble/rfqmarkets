// All RFQ services against a Base Sepolia deployment, with Pyth prices and either the local hedge
// simulator or the Hyperliquid testnet venue.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JsonRpcProvider, parseUnits } from "ethers";
import { PythHermesSource } from "../services/api/src/oracle.js";
import { HyperliquidVenue } from "../services/hedger/src/hyperliquid.js";
import { loadDeploymentConfig } from "./deployment-config.js";
import { startServiceStack, stopOnSignals } from "./lib/service-stack.js";

type Identity = { address: string; privateKey: string };
type Manifest = {
  chainId: string;
  contracts: { clearingProxy: string; usdc: string };
  feedIds: [string, string];
  deploymentBlock?: number;
};
const required = (name: string) => {
  const value = process.env[name];
  if (!value || value.startsWith("replace_")) throw new Error(`missing ${name}`);
  return value;
};
const usdcSetting = (name: string, fallback: string) => {
  const value = parseUnits(process.env[name] ?? fallback, 6);
  if (value <= 0n) throw new Error(`${name} must be positive`);
  return value;
};
const jsonInput = <T>(environmentName: string, fileName: string): T =>
  process.env[environmentName]
    ? JSON.parse(process.env[environmentName])
    : JSON.parse(readFileSync(resolve(fileName), "utf8"));
const config = process.env.RFQ_TESTNET_MANIFEST_JSON
    ? {
        rpcUrl: required("RFQ_BASE_SEPOLIA_RPC_URL"),
        oracleMode: (process.env.RFQ_ORACLE_MODE ?? "pyth") as "pyth" | "chainlink",
      }
    : loadDeploymentConfig(process.env),
  manifest = jsonInput<Manifest>(
    "RFQ_TESTNET_MANIFEST_JSON",
    process.env.RFQ_BASE_SEPOLIA_DEPLOYMENT_FILE ?? ".local-state/base-sepolia-deployment.json",
  ),
  identities = jsonInput<{ sponsor: Identity; approvers: Identity[]; hyperliquidAgent: Identity }>(
    "RFQ_TESTNET_IDENTITIES_JSON",
    ".local-state/testnet-identities.json",
  );
if (manifest.chainId !== "84532") throw new Error("Disposable testnet runtime cannot select another chain");
if (config.oracleMode !== "pyth") throw new Error("Base Sepolia runtime requires RFQ_ORACLE_MODE=pyth");

/** Binary search for the proxy's creation block when the manifest does not record it. */
async function deploymentBlock() {
  if (typeof manifest.deploymentBlock === "number") return manifest.deploymentBlock;
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, { batchMaxCount: 1 });
  try {
    let low = 0,
      high = await provider.getBlockNumber();
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((await provider.getCode(manifest.contracts.clearingProxy, middle)) === "0x") low = middle + 1;
      else high = middle;
    }
    return low;
  } finally {
    provider.destroy();
  }
}

const primaryRpcs = process.env.RFQ_APPROVER_RPC_URLS?.split(",") ?? [
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.drpc.org",
    "https://sepolia-preconf.base.org",
  ],
  secondaryRpcs = process.env.RFQ_APPROVER_SECONDARY_RPC_URLS?.split(",") ?? [
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.drpc.org",
  ];
const ports = {
  api: Number(process.env.RFQ_API_PORT ?? 4100),
  approverBase: Number(process.env.RFQ_APPROVER_BASE_PORT ?? 4201),
  indexer: Number(process.env.RFQ_INDEXER_PORT ?? 4300),
  hedger: Number(process.env.RFQ_HEDGER_PORT ?? 4400),
  gateway: Number(process.env.RFQ_GATEWAY_PORT ?? 4500),
};

const hedgeVenueMode = process.env.RFQ_HEDGE_VENUE ?? "local-simulator";
if (hedgeVenueMode !== "local-simulator" && hedgeVenueMode !== "hyperliquid-testnet")
  throw new Error(`unsupported RFQ_HEDGE_VENUE ${hedgeVenueMode}`);
const hedgeVenue =
  hedgeVenueMode === "hyperliquid-testnet"
    ? new HyperliquidVenue({
        accountAddress: required("RFQ_HYPERLIQUID_ACCOUNT_ADDRESS"),
        agentPrivateKey: identities.hyperliquidAgent.privateKey,
        agentName: required("RFQ_HYPERLIQUID_AGENT_NAME"),
        pythonPath: process.env.RFQ_HYPERLIQUID_PYTHON,
        apiUrl: process.env.RFQ_HYPERLIQUID_API_URL,
        minimumPerpUsdc: process.env.RFQ_HYPERLIQUID_MIN_PERP_USDC ?? "1",
      })
    : undefined;
if (hedgeVenue) {
  try {
    await hedgeVenue.verify();
  } catch (error) {
    await hedgeVenue.close();
    throw error;
  }
}
const hedgeBand = usdcSetting("RFQ_HEDGE_BAND_USDC", "25000"),
  hedgeMaximum = usdcSetting("RFQ_HEDGE_MAX_ORDER_USDC", "25000"),
  hedgeMinimum = hedgeVenue ? usdcSetting("RFQ_HEDGE_MIN_ORDER_USDC", "10") : 0n;
if (hedgeMaximum < hedgeMinimum) throw new Error("RFQ_HEDGE_MAX_ORDER_USDC must meet the venue minimum");

const startBlock = await deploymentBlock();
const trustedProxy = process.env.RFQ_TRUSTED_PROXY?.split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const stack = await startServiceStack({
  stateDirectory: resolve(process.env.RFQ_TESTNET_RUNTIME_DIR ?? ".local-state/base-sepolia-runtime"),
  bindHost: process.env.RFQ_BIND_HOST,
  exposeHedger: true,
  ports,
  chainId: BigInt(manifest.chainId),
  clearingAddress: manifest.contracts.clearingProxy,
  tokenAddress: manifest.contracts.usdc,
  startBlock,
  rpcUrl: process.env.RFQ_API_RPC_URL ?? config.rpcUrl,
  sponsorKey: identities.sponsor.privateKey,
  oracleSource: new PythHermesSource({
    apiKey: required("PYTH_API_KEY"),
    feedIds: { BTC: manifest.feedIds[0], ETH: manifest.feedIds[1] },
  }),
  approvers: {
    keys: identities.approvers.map((approver) => approver.privateKey),
    rpc: (index) => ({ primary: primaryRpcs[index], secondary: secondaryRpcs[index] }),
    rpcBatchMaxCount: process.env.RFQ_APPROVER_RPC_BATCH_MAX_COUNT ?? "1",
    maxFutureSeconds: 5,
    oracleMode: "signed",
    tokenPrefix: "testnet-transport",
  },
  hedge: {
    token: process.env.RFQ_HEDGE_OPS_TOKEN ?? `testnet-hedge-${crypto.randomUUID()}`,
    riskMaxAgeMs: Number(process.env.RFQ_HEDGE_RISK_MAX_AGE_MS ?? 10_000),
    venue: hedgeVenue,
    bandUsdc: hedgeBand,
    maxOrderUsdc: hedgeMaximum,
    minOrderUsdc: hedgeMinimum,
  },
  api: {
    approverTimeoutMs: Number(process.env.RFQ_APPROVER_TIMEOUT_MS ?? 5_000),
    trustedProxy: trustedProxy?.length ? trustedProxy : undefined,
    publicRpcUrl: process.env.RFQ_PUBLIC_RPC_URL ?? "https://sepolia.base.org",
  },
});
console.log(
  `Base Sepolia RFQ services ready from block ${startBlock}: API :${ports.api}; Pyth SSE; approvers :${ports.approverBase}-${ports.approverBase + 2}; indexer :${ports.indexer}; ${hedgeVenueMode} hedge :${ports.hedger}; gateway :${ports.gateway}`,
);
stopOnSignals(stack);
