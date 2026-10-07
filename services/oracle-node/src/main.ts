import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { clearingStateAbi } from "../../../packages/shared/src/abi.js";
import type { MarketRegistryReader } from "../../../packages/shared/src/markets.js";
import { MemoryCandleStore } from "./candles.js";
import { loadConfig } from "./config.js";
import { ChainMarketSource, StaticMarketSource, type MarketSource } from "./markets.js";
import { OracleNode } from "./node.js";
import { buildOracleServer } from "./server.js";

/** Oracle node entry point: `node --import tsx services/oracle-node/src/main.ts` (see config.ts for env). */
const config = loadConfig();
let signer: Wallet;
try {
  signer = new Wallet(config.signerKey);
} catch {
  throw new Error("invalid ORACLE_SIGNER_KEY");
}
config.signerKey = "";
const log = (message: string) => console.error(`[oracle-node] ${message}`);

const candles = new MemoryCandleStore(config.candleRetentionMs);
// With ORACLE_RPC_URL + ORACLE_CLEARING_ADDRESS the node prices every registered market it has a
// symbol table entry for; otherwise exactly ORACLE_MARKETS.
const marketSource: MarketSource = config.registry
  ? new ChainMarketSource(
      new Contract(
        config.registry.clearing,
        clearingStateAbi,
        new JsonRpcProvider(config.registry.rpcUrl, undefined, { staticNetwork: true }),
      ) as unknown as MarketRegistryReader,
      {
        allow: config.marketsConfigured ? config.markets : undefined,
        fallback: config.markets,
        log,
      },
    )
  : new StaticMarketSource(config.markets);
const node = new OracleNode({
  signer,
  domain: { chainId: config.chainId, verifyingContract: config.verifyingContract },
  marketSource,
  marketRefreshMs: config.registry?.refreshMs,
  candles,
  exchanges: config.exchanges,
  aggregation: config.aggregation,
  stable: config.stable,
  tickMs: config.tickMs,
  logError: log,
});
const app = buildOracleServer({ node, candles, corsOrigins: config.corsOrigins });

await node.start();
await app.listen({ host: config.host, port: config.port });
log(
  `signer ${signer.address} chain ${config.chainId} adapter ${config.verifyingContract} markets ${
    config.registry
      ? `from clearing registry ${config.registry.clearing}`
      : config.markets.map((market) => `${market.id}:${market.symbol}`).join(",")
  } listening on ${config.host}:${config.port}`,
);

const shutdown = async () => {
  await node.close();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
