import { readFileSync, statSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { z } from "zod";
import { buildApi } from "../services/api/src/server.js";
import { buildApprover } from "../services/approver/src/server.js";
import { buildIndexer } from "../services/indexer/src/server.js";
import { buildGateway } from "../services/gateway/src/server.js";
import { buildHedger } from "../services/hedger/src/server.js";
import { HyperliquidVenue } from "../services/hedger/src/hyperliquid.js";
import { PythHermesSource } from "../services/api/src/oracle.js";
import { HttpHedgeRiskSource } from "../services/api/src/hedge-risk.js";
import { QUOTE_MODEL_VERSION } from "../packages/shared/src/pricing.js";
import { buildKeeper } from "../services/keeper/src/server.js";
import { validateRuntimeIdentity } from "./runtime-identity.js";
import { feedIdsByMarket, hedgeVenueApiUrl, persistentConfigSchema } from "./persistent-config.js";
import { clearingStateAbi } from "../packages/shared/src/abi.js";
import { marketRegistry, syncMarketRegistry } from "../packages/shared/src/markets.js";
const role = z.enum(["api", "approver", "indexer", "gateway", "hedger", "keeper"]).parse(process.argv[2]);
const config = persistentConfigSchema.parse(JSON.parse(readFileSync(process.argv[3], "utf8")));
// Separate secret files and host users are required for every signing role.
if (statSync(process.argv[3]).mode & 0o077) throw new Error("Role configuration must be private (0600)");
const secretPath = process.argv[4];
if (secretPath && statSync(secretPath).mode & 0o077)
  throw new Error("Role secret file must have mode 0600 or stricter");
const secretSchemas = {
  api: z
    .object({
      sponsorKey: z.string(),
      oracleKey: z.string(),
      operationsToken: z.string(),
      dailyBudgetWei: z.string(),
      maxFeePerGas: z.string(),
      maxOracleValueWei: z.string(),
    })
    .strict(),
  keeper: z
    .object({
      sponsorKey: z.string(),
      oracleKey: z.string(),
      operationsToken: z.string(),
      dailyBudgetWei: z.string(),
      maxFeePerGas: z.string(),
      maxOracleValueWei: z.string(),
    })
    .strict(),
  approver: z.object({ privateKey: z.string(), transportToken: z.string(), hedgeToken: z.string() }).strict(),
  hedger: z
    .object({
      agentKey: z.string(),
      accountAddress: z.string(),
      agentName: z.string(),
      operationsToken: z.string(),
    })
    .strict(),
  indexer: z.object({}).strict(),
  gateway: z.object({}).strict(),
};
const secrets = secretSchemas[role].parse(
  secretPath ? JSON.parse(readFileSync(secretPath, "utf8")) : {},
) as Record<string, string>;
if (!isAbsolute(config.stateDirectory) || !realpathSync(config.stateDirectory).startsWith("/var/lib/rfq/"))
  throw new Error("State must reside on the provisioned /var/lib/rfq persistent volume");
const provider = new JsonRpcProvider(config.rpcUrl, undefined, { batchMaxCount: 1 });
if ((await provider.getNetwork()).chainId !== BigInt(config.chainId))
  throw new Error("RPC chain does not match manifest");
const secondary = new JsonRpcProvider(config.secondaryRpcUrl, undefined, { batchMaxCount: 1 });
try {
  await validateRuntimeIdentity(provider, secondary, {
    ...config.runtimeIdentity,
    chainId: BigInt(config.chainId),
    clearingAddress: config.clearingAddress,
    tokenAddress: config.tokenAddress,
  });
} finally {
  secondary.destroy();
}
if ((await provider.getCode(config.clearingAddress)) === "0x") throw new Error("Clearing proxy missing");
const clearing = new Contract(
  config.clearingAddress,
  [
    ...clearingStateAbi,
    "function usdc() view returns(address)",
    "function isApprover(address) view returns(bool)",
  ],
  provider,
);
if (String(await clearing.usdc()).toLowerCase() !== config.tokenAddress.toLowerCase())
  throw new Error("Settlement token mismatch");
// The market list comes from the clearing registry (markets governance added included); every
// service then refreshes it while running.
if (role !== "gateway" && role !== "hedger") await syncMarketRegistry(clearing);
if (role === "api" || role === "approver") {
  for (let market = 0; market < marketRegistry.count; market++)
    if (!(await clearing.exposureState(market)).ready)
      throw new Error("Exposure migration must finish before starting financial admission services");
}
if (role === "api" || role === "keeper") {
  const sponsor = new Wallet(secrets.sponsorKey).address;
  if (
    !config.sponsorAddress ||
    sponsor.toLowerCase() !== config.sponsorAddress.toLowerCase() ||
    [
      config.runtimeIdentity.governance,
      config.runtimeIdentity.emergencyCouncil,
      ...config.runtimeIdentity.approvers,
    ].some((address) => address.toLowerCase() === sponsor.toLowerCase())
  )
    throw new Error("Sponsor must match its reviewed independent role identity");
}
const databasePath = join(config.stateDirectory, `${role}.sqlite`),
  chainId = BigInt(config.chainId);
let app;
switch (role) {
  case "keeper":
    app = buildKeeper({
      rpcUrl: config.rpcUrl,
      chainId,
      clearingAddress: config.clearingAddress,
      tokenAddress: config.tokenAddress,
      sponsorKey: secrets.sponsorKey,
      databasePath,
      indexerUrl: config.indexerUrl,
      operationsToken: secrets.operationsToken,
      budget: {
        maxGasLimit: 2_000_000n,
        maxFeePerGas: BigInt(secrets.maxFeePerGas),
        maxValue: BigInt(secrets.maxOracleValueWei),
        dailyBudgetWei: BigInt(secrets.dailyBudgetWei),
      },
      oracleSource: new PythHermesSource({
        apiKey: secrets.oracleKey,
        feedIds: feedIdsByMarket(config.feedIds),
      }),
    });
    break;
  case "indexer":
    app = buildIndexer({
      rpcUrl: config.rpcUrl,
      clearingAddress: config.clearingAddress,
      databasePath,
      startBlock: config.startBlock,
      confirmations: 12,
      corsOrigin: config.corsOrigin,
    });
    break;
  case "gateway":
    app = buildGateway({ upstreamUrl: config.apiUrl, corsOrigin: config.corsOrigin });
    break;
  case "approver":
    if (!(await clearing.isApprover(new Wallet(secrets.privateKey).address)))
      throw new Error("Key is not a current approver");
    app = buildApprover({
      privateKey: secrets.privateKey,
      transportToken: secrets.transportToken,
      databasePath,
      expectedChainId: chainId,
      expectedVerifyingContract: config.clearingAddress,
      expectedQuoteModelVersion: QUOTE_MODEL_VERSION,
      rpcUrl: config.rpcUrl,
      secondaryRpcUrl: config.secondaryRpcUrl,
      oracleMode: "signed",
      hedgeRisk: { url: config.hedgeRiskUrl, token: secrets.hedgeToken, maxAgeMs: 3000 },
    });
    break;
  case "api":
    if (!config.approvers) throw new Error("Missing independently provisioned approvers");
    app = buildApi({
      approvers: config.approvers,
      chainId,
      verifyingContract: config.clearingAddress,
      journalPath: databasePath,
      senderBudget: {
        maxGasLimit: 2_000_000n,
        maxFeePerGas: BigInt(secrets.maxFeePerGas),
        maxValue: BigInt(secrets.maxOracleValueWei),
        dailyBudgetWei: BigInt(secrets.dailyBudgetWei),
      },
      oracleSource: new PythHermesSource({
        apiKey: secrets.oracleKey,
        feedIds: feedIdsByMarket(config.feedIds),
      }),
      hedgeRiskSource: new HttpHedgeRiskSource(config.hedgeRiskUrl, secrets.operationsToken),
      operationsToken: secrets.operationsToken,
      publicRpcUrl: config.publicRpcUrl,
      chain: {
        rpcUrl: config.rpcUrl,
        sponsorPrivateKey: secrets.sponsorKey,
        clearingAddress: config.clearingAddress,
        tokenAddress: config.tokenAddress,
      },
    });
    break;
  case "hedger": {
    const venue = new HyperliquidVenue({
      agentPrivateKey: secrets.agentKey,
      accountAddress: secrets.accountAddress,
      agentName: secrets.agentName,
      apiUrl: hedgeVenueApiUrl(config.environment),
      pythonPath: "/opt/hyperliquid/bin/python",
      minimumPerpUsdc: config.hedgeMinOrderUsdc,
    });
    await venue.verify();
    app = buildHedger({
      indexerUrl: config.indexerUrl,
      databasePath,
      venue,
      healthToken: secrets.operationsToken,
      bandUsdc: BigInt(config.hedgeBandUsdc),
      maxOrderUsdc: BigInt(config.hedgeMaxOrderUsdc),
      minOrderUsdc: BigInt(config.hedgeMinOrderUsdc),
    });
    break;
  }
}
provider.destroy();
await app.listen({ host: "127.0.0.1", port: config.port });
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
