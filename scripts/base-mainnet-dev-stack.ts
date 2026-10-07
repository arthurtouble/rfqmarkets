import { resolve } from "node:path";
import { getAddress, parseUnits } from "ethers";
import { PythHermesSource } from "../services/api/src/oracle.js";
import { startServiceStack, stopOnSignals } from "./lib/service-stack.js";

// All RFQ services for the Base mainnet dev deployment in one process tree (Cloudflare dev container).
// Inputs: RFQ_DEV_DEPLOYMENT_JSON (the dev deployment record) and RFQ_DEV_RUNTIME_SECRETS_JSON
// ({rpcUrl, secondaryRpcUrl, pythApiKey, sponsorKey, approverKeys[3]}). Hedging uses the local simulator.
// Approvers and the hedger stay on loopback; RFQ_BIND_HOST exposes only the API, indexer and gateway.
type Record = {
  chainId: string;
  launchProfile: string;
  contracts: { clearingProxy: string; usdc: string };
  feedIds: [string, string];
  deploymentBlock?: number;
};
type Secrets = {
  rpcUrl: string;
  secondaryRpcUrl: string;
  pythApiKey: string;
  sponsorKey: string;
  approverKeys: [string, string, string];
};
const json = <T>(name: string): T => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return JSON.parse(value) as T;
};
const record = json<Record>("RFQ_DEV_DEPLOYMENT_JSON"),
  secrets = json<Secrets>("RFQ_DEV_RUNTIME_SECRETS_JSON");
if (record.chainId !== "8453" || record.launchProfile !== "dev")
  throw new Error("dev runtime only serves the Base mainnet dev profile");
if (typeof record.deploymentBlock !== "number") throw new Error("deployment record has no deploymentBlock");
for (const url of [secrets.rpcUrl, secrets.secondaryRpcUrl])
  if (!url.startsWith("https://")) throw new Error("RPC URLs must use HTTPS");

const clearing = getAddress(record.contracts.clearingProxy);
const stack = await startServiceStack({
  stateDirectory: resolve(process.env.RFQ_DEV_RUNTIME_DIR ?? ".local-state/base-mainnet-dev-runtime"),
  bindHost: process.env.RFQ_BIND_HOST,
  chainId: 8453n,
  clearingAddress: clearing,
  tokenAddress: record.contracts.usdc,
  startBlock: record.deploymentBlock,
  rpcUrl: secrets.rpcUrl,
  sponsorKey: secrets.sponsorKey,
  oracleSource: new PythHermesSource({
    apiKey: secrets.pythApiKey,
    feedIds: { BTC: record.feedIds[0], ETH: record.feedIds[1] },
  }),
  approvers: {
    keys: secrets.approverKeys,
    rpc: () => ({ primary: secrets.rpcUrl, secondary: secrets.secondaryRpcUrl }),
    rpcBatchMaxCount: "1",
    maxFutureSeconds: 5,
    oracleMode: "pyth",
    tokenPrefix: "dev-transport",
  },
  hedge: {
    token: `dev-hedge-${crypto.randomUUID()}`,
    riskMaxAgeMs: 10_000,
    bandUsdc: parseUnits("25000", 6),
    maxOrderUsdc: parseUnits("25000", 6),
    minOrderUsdc: 0n,
  },
  api: { publicRpcUrl: "https://mainnet.base.org" },
  stopOnApproverExit: true,
});
console.log(`Base mainnet dev services ready for ${clearing} from block ${record.deploymentBlock}`);
stopOnSignals(stack);
