import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { SseClients, openSse, sseFrame } from "../../lib/src/sse.js";
import { CANDLE_INTERVALS, candleToWire, resampleCandles, type CandleStore } from "./candles.js";
import { BatchHistory } from "./history.js";
import type { OracleNode } from "./node.js";

const MAX_CANDLES = 1_500;
const candleQuery = z.object({
  market: z.coerce.number().int().min(0).max(255),
  interval: z.enum(Object.keys(CANDLE_INTERVALS) as [string, ...string[]]).default("1m"),
  /** Unix seconds. */
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
});
const MAX_BATCH_PAGE = 1_000;
const batchesQuery = z.object({
  /** Unix seconds; batches strictly after this observedAt. */
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(MAX_BATCH_PAGE).default(MAX_BATCH_PAGE),
});

export interface OracleServerOptions {
  node: OracleNode;
  candles: CandleStore;
  /** Recent signed batches served at /v1/batches; created (15 minutes) when omitted. */
  history?: BatchHistory;
  corsOrigins?: string[];
  heartbeatMs?: number;
  maxSseClients?: number;
  now?: () => number;
}

/** Public, read-only HTTP surface of an oracle node. */
export function buildOracleServer(options: OracleServerOptions) {
  const app = Fastify({ logger: false }),
    clients = new SseClients(),
    now = options.now ?? Date.now,
    history = options.history ?? new BatchHistory();
  const current = options.node.latest();
  if (current) history.push(current.wire);
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

  /** Signed batches after `after`, ascending; how a collector catches up on what it missed. */
  app.get("/v1/batches", async (request, reply) => {
    const parsed = batchesQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid batches query" });
    const { after, limit } = parsed.data,
      page = history.after(after, limit + 1);
    return reply.header("cache-control", "no-store").send({
      batches: page.slice(0, limit),
      more: page.length > limit,
      oldest: history.oldest(),
    });
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
    history.push(record.wire);
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
