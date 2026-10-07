import Fastify from "fastify";
import { MarketFanout, consumeMarketEvents } from "./fanout.js";
import { MarketHistory, type HistoryMarket } from "./history.js";
import {
  CANDLE_INTERVALS,
  CandleBackfill,
  DAY_MS,
  CandleBook,
  candleToWire,
  dayStats,
  resampleCandles,
  type Candle,
  type CandleBackfillOptions,
  type CandleInterval,
} from "./candles.js";
import { clientIdentity, type ClientIpHeader } from "../../../packages/shared/src/client-identity.js";
import { ConnectionBudget } from "../../../packages/shared/src/connection-budget.js";
import { openSse } from "../../lib/src/sse.js";
import { isMarketSymbol } from "../../../packages/shared/src/markets.js";

export interface GatewayOptions {
  upstreamUrl: string;
  corsOrigin?: string;
  fetchImpl?: typeof fetch;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  maxBufferedBytes?: number;
  historyCapacity?: number;
  historySampleIntervalMs?: number;
  upstreamStallMs?: number;
  maxConnections?: number;
  /** SSE connections per client (default 32; the budget's own default of 8 is too tight behind NAT). */
  maxConnectionsPerClient?: number;
  /** Edge header keyed for the per-client SSE budget when the peer is loopback or `trustedProxy`. */
  clientIpHeader?: ClientIpHeader;
  trustedProxy?: string | string[];
  /** How long one-minute candles of the relayed mid are kept in memory (default seven days). */
  candleRetentionMs?: number;
  /** Oracle-node candle history used for windows older than the in-memory candles. */
  candleBackfill?: CandleBackfillOptions;
  now?: () => number;
}

const MAX_CANDLES = 1_000;
const DEFAULT_CONNECTIONS_PER_CLIENT = 32;
const DEFAULT_CANDLES = 300;
/** Five-minute buckets covering the last 24 hours, current bucket included. */
const DAY_BUCKETS = 289;
const STATS_CACHE_MS = 5_000;

export function buildGateway(options: GatewayOptions) {
  const connections = new ConnectionBudget(
      options.maxConnections,
      options.maxConnectionsPerClient ?? DEFAULT_CONNECTIONS_PER_CLIENT,
    ),
    client = clientIdentity(options);
  const app = Fastify({ logger: false }),
    fanout = new MarketFanout(options.maxBufferedBytes),
    history = new MarketHistory(options.historyCapacity, options.historySampleIntervalMs),
    candles = new CandleBook(options.candleRetentionMs),
    now = options.now ?? Date.now,
    backfill = options.candleBackfill?.urls.length
      ? new CandleBackfill({ now, ...options.candleBackfill })
      : undefined,
    candleCache = new Map<string, { second: number; body: unknown }>(),
    fetchImpl = options.fetchImpl ?? fetch,
    corsOrigin = options.corsOrigin ?? "http://127.0.0.1:4173";
  /** A launch market or one the relayed stream has carried (markets are added by governance, not code). */
  const knownMarket = (market: string) =>
    isMarketSymbol(market) && (candles.has(market) || history.has(market));
  /** Candles for the `limit` buckets ending with the current one; older buckets come from the backfill. */
  async function candleWindow(market: HistoryMarket, interval: CandleInterval, limit: number) {
    const intervalMs = CANDLE_INTERVALS[interval],
      nowMs = now(),
      fromMs = Math.floor(nowMs / intervalMs) * intervalMs - (limit - 1) * intervalMs,
      local = resampleCandles(candles.range(market, fromMs, nowMs), intervalMs),
      earliest = candles.earliest(market);
    let merged: Candle[] = local,
      source = "gateway";
    // The first local bucket is only complete when the book began at its boundary.
    const cutoff = earliest === null ? Infinity : Math.ceil(earliest / intervalMs) * intervalMs;
    if (backfill && cutoff > fromMs) {
      const older = await backfill.get(market, interval, fromMs, candles.marketId(market));
      if (older?.length) {
        merged = [
          ...older.filter((candle) => candle.start >= fromMs && candle.start < cutoff),
          ...local.filter((candle) => candle.start >= cutoff),
        ];
        source = "oracle+gateway";
      }
    }
    return { source, candles: merged.slice(-limit) };
  }
  let controller: AbortController | undefined,
    loop: Promise<void> | undefined,
    heartbeat: ReturnType<typeof setInterval> | undefined,
    stopped = false,
    connected = false,
    lastFrameAtMs = 0,
    lastError: string | undefined,
    reconnects = 0;
  async function run() {
    let delay = options.reconnectMinMs ?? 100;
    while (!stopped) {
      controller = new AbortController();
      let lastProgress = Date.now();
      const watchdog = setInterval(
        () => {
          if (Date.now() - lastProgress > (options.upstreamStallMs ?? 10_000)) controller?.abort();
        },
        Math.min(1000, options.upstreamStallMs ?? 10_000),
      );
      watchdog.unref();
      try {
        const response = await fetchImpl(`${options.upstreamUrl}/v1/markets/stream`, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        connected = true;
        lastError = undefined;
        delay = options.reconnectMinMs ?? 100;
        await consumeMarketEvents(response, (data) => {
          lastProgress = lastFrameAtMs = Date.now();
          history.record(data);
          candles.record(data);
          fanout.publish(data);
        });
        if (!stopped) throw new Error("upstream market stream ended");
      } catch (error) {
        connected = false;
        if (stopped) break;
        lastError = error instanceof Error ? error.message : String(error);
        reconnects++;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(options.reconnectMaxMs ?? 5_000, delay * 2);
      } finally {
        clearInterval(watchdog);
        controller = undefined;
      }
    }
  }
  app.get("/health", async () => ({
    ok: connected && Date.now() - lastFrameAtMs < 5_000,
    upstreamConnected: connected,
    lastFrameAtMs,
    lastError: lastError ? "upstream_unavailable" : undefined,
    reconnects,
    connections: connections.status(),
    fanout: fanout.status(),
    history: history.status(),
    candles: candles.status(),
  }));
  app.get<{ Querystring: { market?: string; interval?: string; limit?: string } }>(
    "/v1/candles",
    async (request, reply) => {
      reply.header("access-control-allow-origin", corsOrigin).header("cache-control", "public, max-age=1");
      const { market, interval = "1m" } = request.query;
      if (!market || !knownMarket(market)) return reply.code(400).send({ error: "unknown market" });
      if (!Object.hasOwn(CANDLE_INTERVALS, interval))
        return reply.code(400).send({ error: "interval must be one of 1m, 5m, 15m, 1h, 4h, 1d" });
      const limit = Number(request.query.limit ?? DEFAULT_CANDLES);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CANDLES)
        return reply.code(400).send({ error: `limit must be an integer between 1 and ${MAX_CANDLES}` });
      // Recomputed at most once per second per query; the relayed stream ticks faster than charts redraw.
      const key = `${market}:${interval}:${limit}`,
        second = Math.floor(now() / 1_000),
        cached = candleCache.get(key);
      if (cached?.second === second) return cached.body;
      const window = await candleWindow(market, interval as CandleInterval, limit),
        body = {
          market,
          interval,
          unit: "usdc-micro",
          source: window.source,
          candles: window.candles.map(candleToWire),
        };
      if (candleCache.size >= 64) candleCache.clear();
      candleCache.set(key, { second, body });
      return body;
    },
  );
  let statsCache: { atMs: number; body?: Promise<unknown> } = { atMs: 0 };
  /** Rolling 24h open, high, low, change and hourly sparkline for every market with candles. */
  async function marketStats() {
    const serverTimeMs = now(),
      entries = await Promise.all(
        candles.markets().map(async (market) => {
          const window = await candleWindow(market, "5m", DAY_BUCKETS);
          return [market, dayStats(window.candles)] as const;
        }),
      );
    return {
      serverTimeMs,
      windowMs: DAY_MS,
      unit: "usdc-micro",
      markets: Object.fromEntries(entries.filter(([, stats]) => stats)),
    };
  }
  app.get("/v1/markets/stats", async (_request, reply) => {
    reply.header("access-control-allow-origin", corsOrigin).header("cache-control", "public, max-age=5");
    // Every client asks for the same summary, so it is computed at most once per STATS_CACHE_MS.
    if (!statsCache.body || now() - statsCache.atMs >= STATS_CACHE_MS) {
      const body = marketStats();
      statsCache = { atMs: now(), body };
      body.catch(() => {
        statsCache = { atMs: 0 };
      });
    }
    return statsCache.body;
  });
  app.get<{ Querystring: { market?: string; limit?: string } }>(
    "/v1/markets/history",
    async (request, reply) => {
      reply.header("access-control-allow-origin", corsOrigin).header("cache-control", "private, max-age=1");
      const market = request.query.market;
      if (!market || !knownMarket(market)) return reply.code(400).send({ error: "unknown market" });
      const limit = Number(request.query.limit ?? 300);
      if (!Number.isInteger(limit) || limit < 2 || limit > 1_800)
        return reply.code(400).send({ error: "limit must be an integer between 2 and 1800" });
      return { market: market as HistoryMarket, points: history.get(market, limit) };
    },
  );
  app.get("/v1/markets/stream", async (request, reply) => {
    const release = connections.acquire(client(request));
    if (!release)
      return reply.code(429).header("retry-after", "5").send({ error: "stream connection limit reached" });
    const response = openSse(reply, corsOrigin);
    response.once("close", release);
    const remove = fanout.add({
      write: (chunk) => response.write(chunk),
      bufferedBytes: () => response.writableLength,
      close: () => response.end(),
    });
    response.on("close", remove);
  });
  app.addHook("onReady", async () => {
    stopped = false;
    loop = run();
    heartbeat = setInterval(() => fanout.heartbeat(), 15_000);
    heartbeat.unref();
  });
  app.addHook("onClose", async () => {
    stopped = true;
    controller?.abort();
    if (heartbeat) clearInterval(heartbeat);
    fanout.close();
    await loop;
  });
  return app;
}
