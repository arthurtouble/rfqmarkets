import { Wallet } from "ethers";
import { MemoryCandleStore } from "./candles.js";
import { loadConfig } from "./config.js";
import { StaticMarketSource } from "./markets.js";
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
const node = new OracleNode({
  signer,
  domain: { chainId: config.chainId, verifyingContract: config.verifyingContract },
  marketSource: new StaticMarketSource(config.markets),
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
  `signer ${signer.address} chain ${config.chainId} adapter ${config.verifyingContract} markets ${config.markets
    .map((market) => `${market.id}:${market.symbol}`)
    .join(",")} listening on ${config.host}:${config.port}`,
);

const shutdown = async () => {
  await node.close();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
