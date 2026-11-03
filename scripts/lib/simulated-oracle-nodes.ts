// Production-parity oracle for the local stack: real oracle-node code (aggregation, signing, HTTP/SSE server)
// fed by simulated venue quotes instead of exchange websockets. The API reads them with SignedOracleSource and
// the contract verifies their multi-market reports with SignedPriceOracle, exactly as on dev and mainnet.
import { Contract, Wallet, parseUnits } from "ethers";
import { clearingStateAbi } from "../../packages/shared/src/abi.js";
import type { MarketRegistryReader } from "../../packages/shared/src/markets-chain.js";
import { MemoryCandleStore } from "../../services/oracle-node/src/candles.js";
import { ADAPTERS } from "../../services/oracle-node/src/exchanges/index.js";
import { ExchangeFeed, type FeedQuote } from "../../services/oracle-node/src/feed.js";
import { ChainMarketSource } from "../../services/oracle-node/src/markets.js";
import { OracleNode } from "../../services/oracle-node/src/node.js";
import { buildOracleServer } from "../../services/oracle-node/src/server.js";
import { SYMBOLS, resolveSymbol, type ExchangeName } from "../../services/oracle-node/src/symbols.js";
import { rpcProvider } from "../../services/lib/src/rpc.js";

/** USD-quoted venues only, so no stablecoin conversion is needed; three of them meet the node's source minimum. */
export const SIMULATED_VENUES: readonly ExchangeName[] = ["coinbase", "kraken", "bitstamp"];

/** Venue ticker -> [market symbol, base units per market unit], for every symbol the nodes know. */
function tickerTable() {
  const table = new Map<string, { symbol: string; multiplier: bigint }>();
  for (const symbol of Object.keys(SYMBOLS)) {
    const resolved = resolveSymbol(symbol, SYMBOLS, SIMULATED_VENUES);
    for (const instrument of resolved.instruments)
      table.set(`${instrument.exchange}:${instrument.ticker}`, { symbol, multiplier: resolved.multiplier });
  }
  return table;
}

/** A venue that always quotes the simulated mid (per market unit) with a one-basis-point spread. */
class SimulatedFeed extends ExchangeFeed {
  constructor(
    private venue: ExchangeName,
    tickers: string[],
    private mids: () => Record<string, number>,
    private table: ReturnType<typeof tickerTable>,
  ) {
    super(ADAPTERS[venue], tickers);
  }
  override get connected() {
    return true;
  }
  override start() {}
  override close() {}
  override quote(ticker: string): FeedQuote | undefined {
    const entry = this.table.get(`${this.venue}:${ticker}`),
      mid = entry ? this.mids()[entry.symbol] : undefined;
    if (!entry || !(mid !== undefined && mid > 0)) return undefined;
    // Venues quote one base unit; a market unit can bundle several (kPEPE = 1000 PEPE).
    const perBase = mid / Number(entry.multiplier),
      now = Date.now();
    return {
      // Oracle-node prices are 18-decimal fixed point.
      bid: parseUnits((perBase * (1 - 0.00005)).toFixed(12), 18),
      ask: parseUnits((perBase * (1 + 0.00005)).toFixed(12), 18),
      receivedAtMs: now,
      asOfMs: now,
      transport: "websocket",
    };
  }
}

export interface SimulatedOracleNodesOptions {
  keys: readonly string[];
  chainId: bigint;
  adapter: string;
  clearing: string;
  rpcUrl: string;
  mids: () => Record<string, number>;
  basePort?: number;
}

/** Starts one oracle node per key on 127.0.0.1:basePort+i; returns their URLs and a close function. */
export async function startSimulatedOracleNodes(options: SimulatedOracleNodesOptions) {
  const table = tickerTable(),
    basePort = options.basePort ?? 4901,
    closers: Array<() => Promise<void>> = [],
    urls: string[] = [];
  for (const [index, key] of options.keys.entries()) {
    const reader = new Contract(
      options.clearing,
      clearingStateAbi,
      rpcProvider(options.rpcUrl, undefined, { staticNetwork: true }),
    ) as unknown as MarketRegistryReader;
    const candles = new MemoryCandleStore(3_600_000);
    const node = new OracleNode({
      signer: new Wallet(key),
      domain: { chainId: options.chainId, verifyingContract: options.adapter },
      marketSource: new ChainMarketSource(reader, {
        log: (message) => console.error(`[oracle-${index}] ${message}`),
      }),
      marketRefreshMs: 5_000,
      candles,
      exchanges: SIMULATED_VENUES,
      feedFactory: (venue, tickers) => new SimulatedFeed(venue, tickers, options.mids, table),
      logError: (message) => console.error(`[oracle-${index}] ${message}`),
    });
    const app = buildOracleServer({ node, candles });
    await node.start();
    const port = basePort + index;
    await app.listen({ host: "127.0.0.1", port });
    urls.push(`http://127.0.0.1:${port}`);
    closers.push(async () => {
      await node.close();
      await app.close();
    });
  }
  return { urls, close: () => Promise.all(closers.map((close) => close())).then(() => undefined) };
}
