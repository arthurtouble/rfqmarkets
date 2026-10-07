// Starts every RFQ service in one process tree: indexer, hedger, three approver child processes,
// API, stream gateway and, when configured, the liquidation keeper. The local, Base Sepolia and Base mainnet dev stacks differ only in the
// configuration they pass here. The persistent-host profile runs one role per process instead
// (scripts/persistent-service.ts).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { clearingStateAbi } from "../../packages/shared/src/abi.js";
import { syncMarketRegistry } from "../../packages/shared/src/markets.js";
import { childEnvironment } from "../../packages/shared/src/process-environment.js";
import { buildApi, type ApiOptions } from "../../services/api/src/server.js";
import { HttpHedgeRiskSource } from "../../services/api/src/hedge-risk.js";
import type { OracleSource } from "../../services/api/src/oracle.js";
import type { SenderOptions } from "../../services/api/src/sender.js";
import { buildGateway, type GatewayOptions } from "../../services/gateway/src/server.js";
import { buildHedger, type HedgeVenue } from "../../services/hedger/src/server.js";
import { buildIndexer } from "../../services/indexer/src/server.js";
import { buildKeeper, type KeeperOptions } from "../../services/keeper/src/server.js";

export interface Closable {
  close(): Promise<unknown>;
}

export interface StackPorts {
  api: number;
  approverBase: number;
  indexer: number;
  hedger: number;
  gateway: number;
  keeper: number;
}

export const DEFAULT_PORTS: StackPorts = {
  api: 4100,
  approverBase: 4201,
  indexer: 4300,
  hedger: 4400,
  gateway: 4500,
  keeper: 4700,
};

export interface ServiceStackConfig {
  stateDirectory: string;
  /** Host for the public surfaces (API, indexer, gateway). Approvers always stay on loopback. */
  bindHost?: string;
  /** Also bind the hedger to bindHost (the Base Sepolia operations UI reads it directly). */
  exposeHedger?: boolean;
  ports?: Partial<StackPorts>;
  chainId: bigint;
  clearingAddress: string;
  tokenAddress: string;
  startBlock: number;
  /** RPC used by the API sender and the indexer. */
  rpcUrl: string;
  /** Indexer RPC when it must differ from rpcUrl (for example one with a wider eth_getLogs range). */
  indexerRpcUrl?: string;
  /** Most blocks per indexer eth_getLogs call. */
  maxLogRange?: number;
  sponsorKey: string;
  oracleSource: OracleSource;
  approvers: {
    keys: string[];
    /** Primary and secondary RPC for approver `index`; independent providers keep quorum honest. */
    rpc(index: number): { primary: string; secondary: string };
    rpcBatchMaxCount?: string;
    maxFutureSeconds: number;
    oracleMode?: "local" | "signed";
    tokenPrefix: string;
  };
  hedge: {
    token: string;
    riskMaxAgeMs?: number;
    venue?: HedgeVenue;
    bandUsdc?: bigint;
    maxOrderUsdc?: bigint;
    minOrderUsdc?: bigint;
  };
  /** Extra API options (public RPC, trusted proxies, dev funding). */
  api?: Omit<
    ApiOptions,
    | "approvers"
    | "chainId"
    | "verifyingContract"
    | "journalPath"
    | "oracleSource"
    | "hedgeRiskSource"
    | "operationsToken"
    | "hedgeRiskMaxAgeMs"
    | "chain"
  > & {
    chain?: Pick<NonNullable<ApiOptions["chain"]>, "devFund" | "devWallet">;
  };
  /**
   * Liquidation and resolution keeper. It signs with its own sponsor key (never the API's), reads
   * accounts from the stack's indexer and is bound to loopback.
   */
  keeper?: {
    sponsorKey: string;
    token: string;
    /** Explicit sponsor ceilings; the keeper refuses to start without them. */
    budget: Required<Pick<SenderOptions, "dailyBudgetWei" | "maxGasLimit" | "maxFeePerGas" | "maxValue">>;
    oracleFee?: KeeperOptions["oracleFee"];
    pollMs?: number;
  };
  /** Stream gateway chart options: candle retention and oracle-node candle backfill. */
  gateway?: Pick<GatewayOptions, "candleRetentionMs" | "candleBackfill">;
  /** Stop the whole stack when an approver dies. Local scenarios kill approvers on purpose, so it is opt-in. */
  stopOnApproverExit?: boolean;
}

export interface ServiceStack {
  ports: StackPorts;
  approverProcesses: ChildProcess[];
  /** Registers another closable (for example a dev control server) to stop with the stack. */
  add(server: Closable): void;
  close(): Promise<void>;
}

const waitForHealth = async (url: string, child: ChildProcess) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`approver exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(250) })).ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`approver did not become ready at ${url}`);
};

export async function startServiceStack(config: ServiceStackConfig): Promise<ServiceStack> {
  const ports = { ...DEFAULT_PORTS, ...config.ports };
  const bindHost = config.bindHost ?? "127.0.0.1";
  const servers: Closable[] = [];
  const approverProcesses: ChildProcess[] = [];
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    for (const child of approverProcesses) {
      child.removeAllListeners("exit");
      child.kill("SIGTERM");
    }
    await Promise.allSettled([...servers].reverse().map((server) => server.close()));
  };
  mkdirSync(config.stateDirectory, { recursive: true });
  const state = (name: string) => resolve(config.stateDirectory, name);

  try {
    const indexer = buildIndexer({
      rpcUrl: config.indexerRpcUrl ?? config.rpcUrl,
      readRpcUrl: config.rpcUrl,
      clearingAddress: config.clearingAddress,
      databasePath: state("indexer.sqlite"),
      startBlock: config.startBlock,
      confirmations: 2,
      maxLogRange: config.maxLogRange,
    });
    await indexer.listen({ host: bindHost, port: ports.indexer });
    servers.push(indexer);

    const hedger = buildHedger({
      indexerUrl: `http://127.0.0.1:${ports.indexer}`,
      databasePath: state("hedger.sqlite"),
      healthToken: config.hedge.token,
      venue: config.hedge.venue,
      bandUsdc: config.hedge.bandUsdc,
      maxOrderUsdc: config.hedge.maxOrderUsdc,
      minOrderUsdc: config.hedge.minOrderUsdc,
      riskStaleMs: config.hedge.riskMaxAgeMs,
    });
    await hedger.listen({ host: config.exposeHedger ? bindHost : "127.0.0.1", port: ports.hedger });
    servers.push(hedger);
    const hedgeRiskUrl = `http://127.0.0.1:${ports.hedger}/internal/risk`;

    const approvers: Array<{ url: string; token: string }> = [];
    for (const [index, key] of config.approvers.keys.entries()) {
      const token = `${config.approvers.tokenPrefix}-${index}-${crypto.randomUUID()}`,
        port = ports.approverBase + index,
        url = `http://127.0.0.1:${port}`,
        rpc = config.approvers.rpc(index);
      const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/approver-process.ts")], {
        stdio: ["ignore", "inherit", "inherit"],
        env: childEnvironment({
          RFQ_APPROVER_KEY: key,
          RFQ_APPROVER_TOKEN: token,
          RFQ_APPROVER_DB: state(`approver-${index}.sqlite`),
          RFQ_CHAIN_ID: config.chainId.toString(),
          RFQ_CLEARING_ADDRESS: config.clearingAddress,
          RFQ_RPC_URL: rpc.primary,
          RFQ_SECONDARY_RPC_URL: rpc.secondary,
          RFQ_RPC_BATCH_MAX_COUNT: config.approvers.rpcBatchMaxCount,
          RFQ_APPROVER_PORT: String(port),
          RFQ_MAX_FUTURE_SECONDS: String(config.approvers.maxFutureSeconds),
          RFQ_ORACLE_MODE: config.approvers.oracleMode,
          RFQ_HEDGE_RISK_URL: hedgeRiskUrl,
          RFQ_HEDGE_RISK_TOKEN: config.hedge.token,
          RFQ_HEDGE_RISK_MAX_AGE_MS: config.hedge.riskMaxAgeMs?.toString(),
        }),
      });
      approverProcesses.push(child);
      await waitForHealth(url, child);
      // Outage scenarios (scripts/approver-outage-smoke.ts) stop approvers by PID.
      writeFileSync(state(`approver-${index}.pid`), String(child.pid));
      approvers.push({ url, token });
      if (config.stopOnApproverExit)
        child.once("exit", (code) => {
          console.error(`approver ${index} exited with ${code}; stopping`);
          void close().then(() => process.exit(1));
        });
    }

    const { chain: apiChain, ...apiOptions } = config.api ?? {};
    // Load the clearing registry before the API rebuilds journaled quotes for markets beyond BTC/ETH.
    {
      const provider = new JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
      try {
        await syncMarketRegistry(new Contract(config.clearingAddress, clearingStateAbi, provider));
      } finally {
        provider.destroy();
      }
    }
    const api = buildApi({
      ...apiOptions,
      approvers,
      chainId: config.chainId,
      verifyingContract: config.clearingAddress,
      journalPath: state("api.sqlite"),
      oracleSource: config.oracleSource,
      hedgeRiskSource: new HttpHedgeRiskSource(hedgeRiskUrl, config.hedge.token),
      hedgeRiskMaxAgeMs: config.hedge.riskMaxAgeMs,
      operationsToken: config.hedge.token,
      chain: {
        ...apiChain,
        rpcUrl: config.rpcUrl,
        sponsorPrivateKey: config.sponsorKey,
        clearingAddress: config.clearingAddress,
        tokenAddress: config.tokenAddress,
      },
    });
    await api.listen({ host: bindHost, port: ports.api });
    servers.push(api);

    const gateway = buildGateway({ ...config.gateway, upstreamUrl: `http://127.0.0.1:${ports.api}` });
    await gateway.listen({ host: bindHost, port: ports.gateway });
    servers.push(gateway);

    if (config.keeper) {
      if (new Wallet(config.keeper.sponsorKey).address === new Wallet(config.sponsorKey).address)
        throw new Error("keeper sponsor key must differ from the API sponsor key");
      const keeper = buildKeeper({
        rpcUrl: config.rpcUrl,
        chainId: config.chainId,
        clearingAddress: config.clearingAddress,
        tokenAddress: config.tokenAddress,
        sponsorKey: config.keeper.sponsorKey,
        databasePath: state("keeper.sqlite"),
        oracleSource: config.oracleSource,
        indexerUrl: `http://127.0.0.1:${ports.indexer}`,
        operationsToken: config.keeper.token,
        budget: config.keeper.budget,
        oracleFee: config.keeper.oracleFee,
        pollMs: config.keeper.pollMs,
      });
      await keeper.listen({ host: "127.0.0.1", port: ports.keeper });
      servers.push(keeper);
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { ports, approverProcesses, add: (server) => servers.push(server), close };
}

/** Closes the stack on SIGINT/SIGTERM, forcing exit if a server hangs. */
export function stopOnSignals(stack: { close(): Promise<void> }) {
  const shutdown = async () => {
    const forced = setTimeout(() => process.exit(1), 5_000);
    forced.unref();
    await stack.close();
    clearTimeout(forced);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
