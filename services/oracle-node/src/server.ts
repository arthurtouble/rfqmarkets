import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { SseClients, openSse, sseFrame } from "../../lib/src/sse.js";
import { CANDLE_INTERVALS, candleToWire, resampleCandles, type CandleStore } from "./candles.js";
import type { OracleNode } from "./node.js";

const MAX_CANDLES = 1_500;
const candleQuery = z.object({
  market: z.coerce.number().int().min(0).max(255),
  interval: z.enum(Object.keys(CANDLE_INTERVALS) as [string, ...string[]]).default("1m"),
  /** Unix seconds. */
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
});

export interface OracleServerOptions {
  node: OracleNode;
  candles: CandleStore;
  corsOrigins?: string[];
  heartbeatMs?: number;
  maxSseClients?: number;
  now?: () => number;
}

/** Public, read-only HTTP surface of an oracle node. */
export function buildOracleServer(options: OracleServerOptions) {
  const app = Fastify({ logger: false }),
    clients = new SseClients(),
    now = options.now ?? Date.now;
  if (options.corsOrigins?.length) void app.register(cors, { origin: options.corsOrigins, methods: ["GET"] });

  app.get("/health", async (_request, reply) => {
    const health = { ...options.node.health(), streamClients: clients.size };
    return reply.code(health.ok ? 200 : 503).send(health);
  });

  app.get("/v1/batch/latest", async (_request, reply) => {
    const latest = options.node.latest();
    if (!latest) return reply.code(503).send({ error: "no signed batch yet" });
    return reply.header("cache-control", "no-store").send(latest.wire);
  });

  app.get("/v1/batch/stream", async (request, reply) => {
    if (clients.size >= (options.maxSseClients ?? 1_000))
      return reply.code(503).send({ error: "too many stream clients" });
    const response = openSse(reply, options.corsOrigins);
    clients.add(response);
    const latest = options.node.latest();
    if (latest) clients.send(response, sseFrame("batch", latest.wire, latest.batch.observedAt));
  });

  app.get("/v1/candles", async (request, reply) => {
    const parsed = candleQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid candle query" });
    const { market, interval } = parsed.data,
      intervalMs = CANDLE_INTERVALS[interval],
      toMs = (parsed.data.to ?? Math.floor(now() / 1_000)) * 1_000,
      fromMs = Math.max((parsed.data.from ?? 0) * 1_000, toMs - intervalMs * (MAX_CANDLES - 1));
    if (fromMs > toMs) return reply.code(400).send({ error: "from must not be after to" });
    // Fetch whole buckets so the first resampled candle is complete.
    const minutes = await options.candles.range(market, Math.floor(fromMs / intervalMs) * intervalMs, toMs);
    const candles = resampleCandles(minutes, intervalMs).filter(
      (candle) => candle.start >= fromMs - intervalMs + 1,
    );
    return {
      market,
      symbol: options.node.symbolOf(market) ?? null,
      interval,
      unit: "usdc-micro",
      candles: candles.map(candleToWire),
    };
  });

  const unsubscribe = options.node.subscribe((record) => {
    clients.broadcast(sseFrame("batch", record.wire, record.batch.observedAt));
  });
  const heartbeat = setInterval(() => clients.heartbeat(), options.heartbeatMs ?? 15_000);
  heartbeat.unref();
  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    unsubscribe();
    clients.close();
  });
  return app;
}
