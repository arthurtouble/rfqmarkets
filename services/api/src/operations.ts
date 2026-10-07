import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { MARGIN_TIERS, QUOTE_MODEL_VERSION, marketMarginView } from "../../../packages/shared/src/pricing.js";
import type { ChainReader } from "./chain.js";
import type { ApiContext } from "./context.js";
import type { MarketStream } from "./market-stream.js";
import { marketRegistry, marketSymbols } from "./markets.js";
import type { RuntimeMetrics } from "./metrics.js";
import type { LimitOrders } from "./orders.js";
import type { QuoteEngine } from "./quoting.js";

/**
 * Sender rows that need an operator. `signed` and `submitted` are normal in-flight states and
 * `included`, `reverted` and `superseded` are final, so none of those make the leader unhealthy.
 */
const UNRESOLVED_SENDER_STATUSES = new Set(["ambiguous", "reorged"]);
/** Longest `/v1/config` waits on the margin parameter read before answering without it. */
const CONFIG_CHAIN_READ_MS = 1_500;

/** Constant-time bearer check. Both sides are hashed first so neither the comparison time nor
 * an early length mismatch reveals anything about the configured token. */
export function operationsTokenMatches(header: string | undefined, token: string | undefined) {
  if (!token || typeof header !== "string") return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}

export function senderHealthy(rows: ReadonlyArray<Record<string, unknown>> | undefined) {
  return !rows?.some((row) => UNRESOLVED_SENDER_STATUSES.has(String(row.status)));
}

/** Health, public config and the token-protected operations snapshot. */
export function registerOperationsRoutes(
  app: FastifyInstance,
  ctx: ApiContext,
  services: {
    chain: ChainReader;
    quoting: QuoteEngine;
    stream: MarketStream;
    orders: LimitOrders;
    metrics: RuntimeMetrics;
  },
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
    if (!operationsTokenMatches(request.headers.authorization, options.operationsToken))
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
        version: QUOTE_MODEL_VERSION,
        restoredPaidFills: flowRisk.entries().length,
        markets: Object.fromEntries(
          marketSymbols().flatMap((market) => {
            const price = prices[market];
            return price
              ? [
                  [
                    market,
                    { toxicityScoreBps: flowRisk.score(market, price), volatility: price.volatility ?? null },
                  ],
                ]
              : [];
          }),
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
    // Margin per market for leverage presets and liquidation estimates; null if the chain read fails.
    markets: await Promise.race([
      services.chain
        .marginScales()
        .then((scales) =>
          Object.fromEntries(
            marketSymbols().map((market) => [
              market,
              marketMarginView(scales[market] ?? marketRegistry.get(market).marginScaleBps),
            ]),
          ),
        )
        .catch(() => null),
      // Boot config must stay fast when the chain is slow; clients then fall back to /v1/markets.
      new Promise<null>((resolve) => setTimeout(resolve, CONFIG_CHAIN_READ_MS, null).unref()),
    ]),
    // Registered markets in on-chain index order (`marketMask` bit = index), refreshed from chain.
    marketList: marketRegistry.all().map(({ index, symbol, enabled }) => ({ index, symbol, enabled })),
    marginTiers: MARGIN_TIERS.map((tier) => ({
      maxNotional: tier.maxNotional?.toString() ?? null,
      initialBps: Number(tier.initialBps),
      maintenanceBps: Number(tier.maintenanceBps),
    })),
  }));
}
