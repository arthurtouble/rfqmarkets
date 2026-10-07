import Fastify from "fastify";
import cors from "@fastify/cors";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { keccak256, toUtf8Bytes } from "ethers";
import { z } from "zod";
import type {
  HedgeExecutionSignal,
  HedgeMarketRisk,
  HedgeRiskSnapshot,
} from "../../../packages/shared/src/hedge-risk.js";
import { marketRegistry } from "../../../packages/shared/src/markets.js";
import { SseClients, openSse, sseFrame } from "../../lib/src/sse.js";

/**
 * A market symbol as the indexer's exposure reports it. Venues are addressed by venue coin (see
 * `hedgeCoins`); the local venue uses the symbol itself.
 */
export type HedgeMarket = string;
const integerString = z.string().regex(/^-?\d+$/);
const exposureMarket = z.object({ aggregateBase: integerString, bid: integerString, ask: integerString });
/** The indexer's finalized `/v1/exposure` response: every market the chain has. */
const exposureResponse = z.object({
  blockNumber: z.number().int().nonnegative(),
  markets: z.record(z.string(), exposureMarket),
});
/** The reason a market without a hedge venue mapping reports while reduce-only. */
export const NO_HEDGE_MAPPING = "no_hedge_mapping";
const hedgeMarketsFile = z.object({
  coins: z.record(
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/),
    z.string().regex(/^[A-Za-z0-9:._-]{1,32}$/),
  ),
});
/**
 * The market symbol -> venue coin map, from a JSON data file (`{ "coins": { "BTC": "BTC" } }`). The
 * default file is `services/hedger/hedge-markets.json`; `RFQ_HEDGE_MARKETS_FILE` overrides it.
 */
export function loadHedgeCoins(
  path = process.env.RFQ_HEDGE_MARKETS_FILE ?? new URL("../hedge-markets.json", import.meta.url),
): Record<string, string> {
  return hedgeMarketsFile.parse(JSON.parse(readFileSync(path, "utf8"))).coins;
}
type ExposureResponse = z.infer<typeof exposureResponse>;

const ONE = 10n ** 18n;
const abs = (value: bigint) => (value < 0n ? -value : value);
/** USDC notional (6 decimals) of a signed 18-decimal base amount at `mid`. */
const notional = (base: bigint, mid: bigint) => (abs(base) * mid) / ONE;

/** Customer exposure versus the venue position for one market. */
function marketGap(exposure: ExposureResponse | undefined, market: HedgeMarket, venueBase: bigint) {
  const source = exposure?.markets[market],
    bid = BigInt(source?.bid ?? 0),
    ask = BigInt(source?.ask ?? 0),
    mid = (bid + ask) / 2n,
    target = BigInt(source?.aggregateBase ?? 0),
    gap = target - venueBase;
  return { bid, ask, mid, target, current: venueBase, gap, gapNotional: notional(gap, mid) };
}
export interface VenueOrder {
  clientId: string;
  /** The venue coin (`hedgeCoins[symbol]`). */
  market: HedgeMarket;
  baseDelta: bigint;
  limitPrice: bigint;
}
export interface VenueResult {
  venueOrderId: string;
  status: "open" | "partial" | "filled" | "rejected";
  filledBase: bigint;
  reason?: string;
}
/** A hedge venue, addressed by venue coin. */
export interface HedgeVenue {
  readonly mode: string;
  position(market: HedgeMarket): Promise<bigint>;
  find(clientId: string): Promise<VenueResult | null>;
  submit(order: VenueOrder): Promise<VenueResult>;
  execution?(market: HedgeMarket, referenceMid: bigint, notional: bigint): Promise<HedgeExecutionSignal>;
  close?(): Promise<void>;
}
export interface HedgeOptions {
  indexerUrl: string;
  databasePath: string;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  bandUsdc?: bigint;
  maxOrderUsdc?: bigint;
  minOrderUsdc?: bigint;
  riskStaleMs?: number;
  venue?: HedgeVenue;
  /** Bearer token for /internal/risk, /v1/status, /v1/status/stream and /v1/tick. Required. */
  healthToken: string;
  /** Origins allowed to read the operations endpoints from a browser (defaults to the local admin UI). */
  corsOrigin?: string | string[];
  /**
   * Market symbol -> venue coin. A market without an entry is never hedged and reports reduce-only
   * (`no_hedge_mapping`), the same fail-closed policy as an unhealthy venue. Defaults to
   * `loadHedgeCoins()`.
   */
  hedgeCoins?: Record<string, string>;
  /** Where hedger notices (e.g. an unmapped market) are logged; defaults to stderr. */
  log?: (message: string) => void;
}
class IndexerUnavailable extends Error {}

export class LocalHedgeVenue implements HedgeVenue {
  readonly mode = "local-simulator";
  constructor(private db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS local_venue_positions(market TEXT PRIMARY KEY,base_size TEXT NOT NULL); CREATE TABLE IF NOT EXISTS local_venue_orders(client_id TEXT PRIMARY KEY,venue_order_id TEXT NOT NULL,market TEXT NOT NULL,base_delta TEXT NOT NULL,status TEXT NOT NULL)",
    );
  }
  async position(market: HedgeMarket) {
    const row = this.db.prepare("SELECT base_size FROM local_venue_positions WHERE market=?").get(market) as
      { base_size: string } | undefined;
    return BigInt(row?.base_size ?? "0");
  }
  async find(clientId: string) {
    const row = this.db
      .prepare("SELECT venue_order_id,base_delta,status FROM local_venue_orders WHERE client_id=?")
      .get(clientId) as
      { venue_order_id: string; base_delta: string; status: VenueResult["status"] } | undefined;
    return row
      ? { venueOrderId: row.venue_order_id, status: row.status, filledBase: BigInt(row.base_delta) }
      : null;
  }
  async submit(order: VenueOrder) {
    const found = await this.find(order.clientId);
    if (found) return found;
    const venueOrderId = `local-${order.clientId.slice(2, 14)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = await this.position(order.market);
      this.db
        .prepare("INSERT INTO local_venue_orders VALUES(?,?,?,?, 'filled')")
        .run(order.clientId, venueOrderId, order.market, order.baseDelta.toString());
      this.db
        .prepare(
          "INSERT INTO local_venue_positions VALUES(?,?) ON CONFLICT(market) DO UPDATE SET base_size=excluded.base_size",
        )
        .run(order.market, (current + order.baseDelta).toString());
      this.db.exec("COMMIT");
      return { venueOrderId, status: "filled", filledBase: order.baseDelta } as VenueResult;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function buildHedger(options: HedgeOptions) {
  if (!options.healthToken) throw new Error("hedger requires an operations token");
  const corsOrigin = options.corsOrigin ?? "http://127.0.0.1:4174",
    band = options.bandUsdc ?? 25_000n * 1_000_000n,
    riskStaleMs = options.riskStaleMs ?? 3_000;
  const app = Fastify({ logger: false });
  app.register(cors, { origin: corsOrigin });
  const db = new DatabaseSync(options.databasePath);
  const fetchImpl = options.fetchImpl ?? fetch;
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS hedge_orders(client_id TEXT PRIMARY KEY,market TEXT NOT NULL,target_block INTEGER NOT NULL,base_delta TEXT NOT NULL,limit_price TEXT NOT NULL,status TEXT NOT NULL,venue_order_id TEXT,filled_base TEXT NOT NULL DEFAULT '0',reason TEXT,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL)",
  );
  const columns = db.prepare("PRAGMA table_info(hedge_orders)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "filled_base"))
    db.exec("ALTER TABLE hedge_orders ADD COLUMN filled_base TEXT NOT NULL DEFAULT '0'");
  if (!columns.some((column) => column.name === "reason"))
    db.exec("ALTER TABLE hedge_orders ADD COLUMN reason TEXT");
  const venue: HedgeVenue = options.venue ?? new LocalHedgeVenue(db),
    hedgeCoins = options.hedgeCoins ?? loadHedgeCoins(),
    log = options.log ?? ((message: string) => console.error(message)),
    unmappedLogged = new Set<string>();
  /** The venue coin for `market`, or undefined (logged once) when the market is not hedged. */
  const coinOf = (market: HedgeMarket) => {
    const coin = Object.hasOwn(hedgeCoins, market) ? hedgeCoins[market] : undefined;
    if (!coin && !unmappedLogged.has(market)) {
      unmappedLogged.add(market);
      log(
        `hedger: market ${market} has no hedge venue mapping; it is not hedged and stays reduce-only until one is configured`,
      );
    }
    return coin;
  };
  /** Markets in the latest exposure report (every market the chain has). */
  // Every market in the latest exposure report (all markets the chain has), plus the registry's markets so
  // a snapshot taken before the first report still names them (as reduce-only).
  const exposureMarkets = () => [
    ...new Set([...marketRegistry.symbols(), ...Object.keys(lastExposure?.markets ?? {})]),
  ];
  let ticking: Promise<void> | undefined,
    timer: ReturnType<typeof setInterval> | undefined,
    lastError: string | undefined,
    lastFailureCritical = false,
    lastIndexedBlock = -1,
    lastExposure: ExposureResponse | undefined,
    lastSuccessAtMs = 0;
  const lastVenuePositions: Record<HedgeMarket, bigint> = {},
    lastExecution: Partial<Record<HedgeMarket, HedgeExecutionSignal>> = {},
    executionErrors: Partial<Record<HedgeMarket, string>> = {},
    statusClients = new SseClients(64 * 1024);
  const record = (clientId: string, result: VenueResult) =>
    db
      .prepare(
        "UPDATE hedge_orders SET status=?,venue_order_id=?,filled_base=?,reason=?,updated_ms=? WHERE client_id=?",
      )
      .run(
        result.status,
        result.venueOrderId,
        result.filledBase.toString(),
        result.reason ?? null,
        Date.now(),
        clientId,
      );
  async function reconcileOrSubmit(order: VenueOrder) {
    const found = await venue.find(order.clientId);
    if (found) {
      record(order.clientId, found);
      if (found.status === "rejected")
        throw new Error(`hedge rejected${found.reason ? `: ${found.reason}` : ""}`);
      return;
    }
    db.prepare("UPDATE hedge_orders SET status='submitted',reason=NULL,updated_ms=? WHERE client_id=?").run(
      Date.now(),
      order.clientId,
    );
    const result = await venue.submit(order);
    record(order.clientId, result);
    if (result.status === "rejected")
      throw new Error(`hedge rejected${result.reason ? `: ${result.reason}` : ""}`);
  }
  async function doTick() {
    const outstanding = db
      .prepare(
        "SELECT client_id,market,base_delta,limit_price FROM hedge_orders WHERE status IN ('planned','submitted','open') ORDER BY created_ms",
      )
      .all() as Array<{ client_id: string; market: HedgeMarket; base_delta: string; limit_price: string }>;
    for (const order of outstanding) {
      // Orders are journaled by market symbol and sent to the venue by coin.
      const coin = coinOf(order.market);
      if (!coin) throw new Error(`outstanding hedge order for unmapped market ${order.market}`);
      await reconcileOrSubmit({
        clientId: order.client_id,
        market: coin,
        baseDelta: BigInt(order.base_delta),
        limitPrice: BigInt(order.limit_price),
      });
    }
    // An open venue order already reserves risk. Do not stack another order on the
    // same exposure until the venue reports a terminal fill or rejection.
    const blockedMarkets = new Set(
      (
        db
          .prepare("SELECT DISTINCT market FROM hedge_orders WHERE status IN ('planned','submitted','open')")
          .all() as Array<{ market: HedgeMarket }>
      ).map((row) => row.market),
    );
    let exposure: ExposureResponse;
    try {
      const response = await fetchImpl(`${options.indexerUrl}/v1/exposure?finalized=true`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(String(response.status));
      exposure = exposureResponse.parse(await response.json());
    } catch (error) {
      throw new IndexerUnavailable(`indexer unavailable: ${String(error)}`);
    }
    lastExposure = exposure;
    lastIndexedBlock = exposure.blockNumber;
    for (const market of Object.keys(exposure.markets)) {
      const coin = coinOf(market);
      if (!coin) continue;
      const current = await venue.position(coin);
      lastVenuePositions[market] = current;
      const { bid, ask, mid, target, gap, gapNotional } = marketGap(exposure, market, current);
      if (bid === 0n || ask === 0n) continue;
      if (venue.execution)
        try {
          lastExecution[market] = await venue.execution(coin, mid, gapNotional > band ? gapNotional : band);
          delete executionErrors[market];
        } catch (error) {
          executionErrors[market] = String(error);
          delete lastExecution[market];
        }
      if (blockedMarkets.has(market) || gapNotional <= band) continue;
      // Trade toward the middle of the band; if the customer side is already inside the band and the
      // venue position is large enough to close, flatten the venue instead.
      const residualBase = ((band / 2n) * ONE) / mid,
        minOrder = options.minOrderUsdc ?? 0n;
      let delta =
        minOrder > 0n && notional(target, mid) <= band && notional(current, mid) >= minOrder
          ? -current
          : gap - (gap > 0n ? residualBase : -residualBase);
      const maxBase = ((options.maxOrderUsdc ?? 25_000n * 1_000_000n) * ONE) / mid;
      if (delta > maxBase) delta = maxBase;
      if (delta < -maxBase) delta = -maxBase;
      if (notional(delta, mid) < minOrder) continue;
      const limit = gap > 0n ? (ask * 10_020n) / 10_000n : (bid * 9_980n) / 10_000n,
        clientId = keccak256(toUtf8Bytes(`rfq:${exposure.blockNumber}:${market}:${target}:${current}`));
      const exists = db.prepare("SELECT status FROM hedge_orders WHERE client_id=?").get(clientId) as
        { status: string } | undefined;
      if (exists) {
        if (exists.status === "planned" || exists.status === "submitted")
          await reconcileOrSubmit({ clientId, market: coin, baseDelta: delta, limitPrice: limit });
        continue;
      }
      db.prepare(
        "INSERT INTO hedge_orders(client_id,market,target_block,base_delta,limit_price,status,venue_order_id,filled_base,reason,created_ms,updated_ms) VALUES(?,?,?,?,?,'planned',NULL,'0',NULL,?,?)",
      ).run(
        clientId,
        market,
        exposure.blockNumber,
        delta.toString(),
        limit.toString(),
        Date.now(),
        Date.now(),
      );
      await reconcileOrSubmit({ clientId, market: coin, baseDelta: delta, limitPrice: limit });
      lastVenuePositions[market] = await venue.position(coin);
    }
  }
  const statusSnapshot = () => {
    const positions = venuePositions(),
      markets = Object.fromEntries(
        exposureMarkets().map((market) => {
          const coin = coinOf(market),
            { target, current, gap, gapNotional } = marketGap(
              lastExposure,
              market,
              lastVenuePositions[market] ?? 0n,
            );
          return [
            market,
            {
              customerBase: target.toString(),
              venueBase: current.toString(),
              gapBase: gap.toString(),
              gapNotional: gapNotional.toString(),
              bandUsdc: band.toString(),
              coin: coin ?? null,
              state: !coin ? "unhedged" : gapNotional <= band ? "within_band" : "hedge_required",
              /** What the API currently allows in this market (`/internal/risk`'s mode). */
              tradingMode: marketRisk(market).mode,
              execution: lastExecution[market],
              executionError: executionErrors[market],
            },
          ];
        }),
      );
    return {
      mode: venue.mode,
      indexedBlock: lastIndexedBlock,
      observedAtMs: lastSuccessAtMs,
      healthy: effectivelyHealthy(),
      error: lastError,
      positions,
      markets,
      orders: db.prepare("SELECT * FROM hedge_orders ORDER BY created_ms DESC LIMIT 20").all(),
    };
  };
  /** Venue position per hedged market symbol. */
  const venuePositions = () =>
    Object.fromEntries(
      exposureMarkets()
        .filter((market) => coinOf(market))
        .map((market) => [market, (lastVenuePositions[market] ?? 0n).toString()]),
    );
  const broadcastStatus = () => statusClients.broadcast(sseFrame("status", statusSnapshot()));
  async function tick() {
    if (ticking) return ticking;
    ticking = doTick()
      .then(() => {
        lastError = undefined;
        lastFailureCritical = false;
        lastSuccessAtMs = Date.now();
      })
      .catch((error) => {
        lastError = String(error);
        lastFailureCritical = !(error instanceof IndexerUnavailable);
      })
      .finally(() => {
        ticking = undefined;
        broadcastStatus();
      });
    return ticking;
  }
  const effectivelyHealthy = () => !lastFailureCritical && Date.now() - lastSuccessAtMs <= riskStaleMs;
  const authorized = (request: { headers: { authorization?: string } }) =>
    request.headers.authorization === `Bearer ${options.healthToken}`;
  /** The trading mode the API enforces for `market`: the same rules /internal/risk reports. */
  function marketRisk(market: HedgeMarket, healthy = effectivelyHealthy()): HedgeMarketRisk {
    const minOrder = options.minOrderUsdc ?? 0n,
      executableBand = minOrder > band ? minOrder : band,
      { gapNotional } = marketGap(lastExposure, market, lastVenuePositions[market] ?? 0n);
    // Unhedgeable: only exposure-reducing trades, as when the venue is down.
    if (!coinOf(market))
      return {
        mode: "reduce_only",
        gapNotional: gapNotional.toString(),
        bandUsdc: band.toString(),
        reason: NO_HEDGE_MAPPING,
      };
    const execution = lastExecution[market],
      executionHealthy =
        !venue.execution || (execution !== undefined && Date.now() - execution.observedAtMs <= riskStaleMs),
      mode =
        !healthy || !executionHealthy || gapNotional > executableBand * 2n
          ? "reduce_only"
          : gapNotional > executableBand
            ? "guarded"
            : "normal";
    return {
      mode,
      gapNotional: gapNotional.toString(),
      bandUsdc: band.toString(),
      ...(execution ? { execution } : {}),
    };
  }
  async function riskSnapshot(): Promise<HedgeRiskSnapshot> {
    const healthy = effectivelyHealthy(),
      markets = {} as HedgeRiskSnapshot["markets"];
    for (const market of exposureMarkets()) markets[market] = marketRisk(market, healthy);
    return { observedAtMs: lastSuccessAtMs, healthy, indexedBlock: lastIndexedBlock, markets };
  }
  app.get("/health", async () => ({
    ok: effectivelyHealthy(),
    indexedBlock: lastIndexedBlock,
    error: lastError,
  }));
  app.get("/internal/risk", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "unauthorized" });
    return riskSnapshot();
  });
  app.get("/v1/status", async (request, reply) =>
    authorized(request) ? statusSnapshot() : reply.code(401).send({ error: "unauthorized" }),
  );
  app.get("/v1/status/stream", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "unauthorized" });
    const response = openSse(reply, corsOrigin);
    statusClients.add(response);
    statusClients.send(response, sseFrame("status", statusSnapshot()));
  });
  app.post("/v1/tick", async (request, reply) => {
    if (!authorized(request)) return reply.code(401).send({ error: "unauthorized" });
    await tick();
    return {
      ok: !lastError,
      error: lastError,
      positions: venuePositions(),
    };
  });
  app.addHook("onReady", async () => {
    await tick();
    timer = setInterval(() => void tick(), options.pollMs ?? 1_000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    statusClients.close();
    await ticking;
    if (venue.close) await venue.close();
    db.close();
  });
  return app;
}
