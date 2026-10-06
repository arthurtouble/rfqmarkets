import type { FastifyInstance } from "fastify";
import type { ApiContext } from "./context.js";
import type { MarketStream } from "./market-stream.js";
import { MARKETS } from "./markets.js";
import type { RuntimeMetrics } from "./metrics.js";
import type { LimitOrders } from "./orders.js";
import type { QuoteEngine } from "./quoting.js";

/**
 * Sender rows that need an operator. `signed` and `submitted` are normal in-flight states and
 * `included`, `reverted` and `superseded` are final, so none of those make the leader unhealthy.
 */
const UNRESOLVED_SENDER_STATUSES = new Set(["ambiguous", "reorged"]);

export function senderHealthy(rows: ReadonlyArray<Record<string, unknown>> | undefined) {
  return !rows?.some((row) => UNRESOLVED_SENDER_STATUSES.has(String(row.status)));
}

/** Health, public config and the token-protected operations snapshot. */
export function registerOperationsRoutes(
  app: FastifyInstance,
  ctx: ApiContext,
  services: { quoting: QuoteEngine; stream: MarketStream; orders: LimitOrders; metrics: RuntimeMetrics },
) {
  const { options, domain } = ctx;

  app.get("/health", async () => ({
    ok: senderHealthy(ctx.sender?.status()),
    role: "leader",
    epoch: (ctx.clearing ? await ctx.clearing.leaderEpoch() : 1n).toString(),
    chain: options.chain
      ? { chainId: domain.chainId.toString(), clearingAddress: domain.verifyingContract }
      : null,
    marketData: options.oracleSource?.status?.() ?? { source: "configured" },
  }));

  app.get("/internal/metrics", async (request, reply) => {
    if (!options.operationsToken || request.headers.authorization !== `Bearer ${options.operationsToken}`)
      return reply.code(401).send({ error: "unauthorized" });
    const { grossReservations, flowRisk, prices } = ctx;
    return {
      grossReservations: {
        active: grossReservations.size,
        capacity: ctx.maxActiveQuotes,
        finalizedBlock: grossReservations.finalizedBlock,
        finalizedTimestamp: grossReservations.finalizedTimestamp,
      },
      quoteModel: {
        version: "adaptive-v1",
        restoredPaidFills: flowRisk.entries().length,
        markets: Object.fromEntries(
          MARKETS.map((market) => [
            market,
            {
              toxicityScoreBps: flowRisk.score(market, prices[market]),
              volatility: prices[market].volatility ?? null,
            },
          ]),
        ),
      },
      shadowModel: services.quoting.shadowTelemetry.snapshot(),
      streams: services.stream.stats,
      firmQuotes: { active: ctx.quotes.size, capacity: ctx.maxActiveQuotes },
      orders: services.orders.stats,
      sender: ctx.sender?.status(),
      latency: services.metrics.snapshot(),
    };
  });

  app.get("/v1/config", async () => ({
    chainId: `0x${domain.chainId.toString(16)}`,
    chainName: ctx.devFund ? "RFQ Local" : domain.chainId === 84532n ? "Base Sepolia" : "Base",
    rpcUrl: options.publicRpcUrl,
    clearingAddress: domain.verifyingContract,
    tokenAddress: options.chain?.tokenAddress,
  }));
}
