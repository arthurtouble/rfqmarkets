import { resolve } from "node:path";
import { getAddress, parseUnits } from "ethers";
import { SignedOracleSource } from "../services/api/src/oracle.js";
import { startServiceStack, stopOnSignals } from "./lib/service-stack.js";

// All RFQ services for the Base mainnet dev deployment in one process tree (Cloudflare dev container).
// Inputs: RFQ_DEV_DEPLOYMENT_JSON (the dev deployment record) and RFQ_DEV_RUNTIME_SECRETS_JSON
// ({rpcUrl, secondaryRpcUrl, oracleNodes[], sponsorKey, approverKeys[3], hedgeToken?}). Prices come from our own
// oracle nodes, checked against the signer set recorded at deployment. Hedging uses the local simulator.
// Approvers stay on loopback; RFQ_BIND_HOST exposes the API, indexer and gateway, and the hedger too when
// a hedgeToken is given (its routes then need that token; the runtime worker holds it for the operations dashboard).
type Record = {
  chainId: string;
  launchProfile: string;
  contracts: { clearingProxy: string; usdc: string; oracleAdapter: string };
  oracle: { signers: string[]; threshold: number; maxDeviationBps: number; maxSkew: number };
  deploymentBlock?: number;
};
type Secrets = {
  rpcUrl: string;
  secondaryRpcUrl: string;
  /** Indexer RPC and its eth_getLogs block cap; mainnet.base.org allows 500 blocks per call. */
  indexerRpcUrl?: string;
  maxLogRange?: number;
  /** Oracle node base URLs, one per region. */
  oracleNodes: string[];
  sponsorKey: string;
  approverKeys: [string, string, string];
  /** Hedger operations token from the runtime's Durable Object. */
  hedgeToken?: string;
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
for (const url of [
  secrets.rpcUrl,
  secrets.secondaryRpcUrl,
  ...(secrets.indexerRpcUrl ? [secrets.indexerRpcUrl] : []),
])
  if (!url.startsWith("https://")) throw new Error("RPC URLs must use HTTPS");

const clearing = getAddress(record.contracts.clearingProxy);
const stack = await startServiceStack({
  stateDirectory: resolve(process.env.RFQ_DEV_RUNTIME_DIR ?? ".local-state/base-mainnet-dev-runtime"),
  bindHost: process.env.RFQ_BIND_HOST,
  exposeHedger: Boolean(secrets.hedgeToken),
  chainId: 8453n,
  clearingAddress: clearing,
  tokenAddress: record.contracts.usdc,
  startBlock: record.deploymentBlock,
  rpcUrl: secrets.rpcUrl,
  indexerRpcUrl: secrets.indexerRpcUrl,
  maxLogRange: secrets.maxLogRange,
  sponsorKey: secrets.sponsorKey,
  oracleSource: new SignedOracleSource({
    nodes: secrets.oracleNodes,
    signers: record.oracle.signers,
    threshold: record.oracle.threshold,
    maxDeviationBps: record.oracle.maxDeviationBps,
    maxSkewSeconds: record.oracle.maxSkew,
    chainId: 8453n,
    adapter: record.contracts.oracleAdapter,
  }),
  approvers: {
    keys: secrets.approverKeys,
    rpc: () => ({ primary: secrets.rpcUrl, secondary: secrets.secondaryRpcUrl }),
    rpcBatchMaxCount: "1",
    maxFutureSeconds: 5,
    oracleMode: "signed",
    tokenPrefix: "dev-transport",
  },
  hedge: {
    token: secrets.hedgeToken ?? `dev-hedge-${crypto.randomUUID()}`,
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
