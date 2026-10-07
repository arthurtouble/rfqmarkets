import { createClient, type DataStreamsClient, type Report } from "@chainlink/data-streams-sdk";
import { AbiCoder, parseUnits } from "ethers";
import { decodeStreamsV3Envelope } from "../../../packages/shared/src/streams.js";
import type { PriceSnapshot } from "../../../packages/shared/src/policy.js";
import { readSseEvents } from "../../lib/src/sse.js";
import { MarketSignalTracker } from "./market-signals.js";

export type OracleMarket = "BTC" | "ETH";
export interface OracleQuote {
  snapshot: PriceSnapshot;
  report: string;
  validUntil: number;
}
export type OracleListener = (market: OracleMarket) => void;
export interface OracleSource {
  latest(market: OracleMarket): Promise<OracleQuote>;
  settlement?(market: OracleMarket): Promise<OracleQuote>;
  subscribe?(listener: OracleListener): () => void;
  start?(): Promise<void>;
  close?(): Promise<void>;
  status?(): unknown;
}
export interface OracleSourceStatus {
  source: string;
  transport: string;
  agesMs: Record<OracleMarket, number | null>;
  /** Upstream updates dropped because they could not be parsed or failed validation. */
  rejectedUpdates: number;
}

const MARKETS = ["BTC", "ETH"] as const;
const marketId = (market: OracleMarket) => (market === "BTC" ? 0 : 1);
/** Lifetime of locally signed (mock-oracle) reports. */
const LOCAL_REPORT_TTL_SECONDS = 15;

/** Encodes the report format accepted by the local mock oracle adapter. */
function localQuote(snapshot: PriceSnapshot): OracleQuote {
  const observedAt = Math.floor(snapshot.observedAtMs / 1_000),
    validUntil = observedAt + LOCAL_REPORT_TTL_SECONDS;
  return {
    snapshot,
    validUntil,
    report: AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],
      [[marketId(snapshot.market as OracleMarket), snapshot.bid, snapshot.ask, observedAt, validUntil]],
    ),
  };
}

/**
 * Shared plumbing for every source: the per-market quote cache, change listeners, the volatility
 * tracker, request coalescing and the status shape.
 */
abstract class BaseOracleSource implements OracleSource {
  protected cached: Partial<Record<OracleMarket, OracleQuote>> = {};
  protected signals = new MarketSignalTracker();
  protected rejectedUpdates = 0;
  private listeners = new Set<OracleListener>();
  private inFlight = new Map<string, Promise<unknown>>();
  constructor(private sourceName: string) {}

  abstract latest(market: OracleMarket): Promise<OracleQuote>;
  protected abstract transport(): string;
  protected now() {
    return Date.now();
  }

  subscribe(listener: OracleListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  status(): OracleSourceStatus {
    const now = this.now(),
      age = (market: OracleMarket) => {
        const quote = this.cached[market];
        return quote ? now - quote.snapshot.observedAtMs : null;
      };
    return {
      source: this.sourceName,
      transport: this.transport(),
      agesMs: { BTC: age("BTC"), ETH: age("ETH") },
      rejectedUpdates: this.rejectedUpdates,
    };
  }

  protected snapshot(market: OracleMarket, bid: bigint, ask: bigint, observedAtMs: number): PriceSnapshot {
    const volatility = this.signals.observe(market, (bid + ask) / 2n, observedAtMs);
    return {
      market,
      bid,
      ask,
      observedAtMs,
      source: this.sourceName,
      volatilityBps: volatility.riskBps,
      volatility,
    };
  }

  protected emit(market: OracleMarket) {
    for (const listener of this.listeners)
      try {
        listener(market);
      } catch {
        // A failing subscriber must not stop the feed or starve the other subscribers.
      }
  }

  /** Runs at most one request per key; concurrent callers share its result. */
  protected coalesce<T>(key: string, request: () => Promise<T>): Promise<T> {
    const active = this.inFlight.get(key);
    if (active) return active as Promise<T>;
    const run = request().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }
}

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
};
export interface CoinbaseSourceOptions {
  endpoint?: string;
  restEndpoint?: string;
  staleMs?: number;
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => SocketLike;
  reconnectMs?: number;
}

/** Coinbase best bid/offer over WebSocket, with a REST fallback; produces local mock-oracle reports. */
export class CoinbaseMarketDataSource extends BaseOracleSource {
  private socket?: SocketLike;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private options: CoinbaseSourceOptions = {}) {
    super("coinbase");
  }
  protected transport() {
    return this.socket?.readyState === 1 ? "websocket" : "rest-fallback";
  }
  private store(market: OracleMarket, bidText: string, askText: string, receivedAtMs = Date.now()) {
    const bid = parseUnits(bidText, 6),
      ask = parseUnits(askText, 6);
    if (bid <= 0n || ask < bid) throw new Error("invalid Coinbase market data");
    // Strictly increasing per market so every update yields a distinct report timestamp.
    receivedAtMs = Math.max(receivedAtMs, (this.cached[market]?.snapshot.observedAtMs ?? 0) + 1);
    this.cached[market] = localQuote(this.snapshot(market, bid, ask, receivedAtMs));
    this.emit(market);
  }
  private onMessage(data: unknown) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      this.rejectedUpdates++;
      return;
    }
    if (message?.channel !== "ticker") return;
    const receivedAt = Date.now();
    for (const item of message.events ?? [])
      for (const ticker of item.tickers ?? []) {
        const market =
          ticker.product_id === "BTC-USD" ? "BTC" : ticker.product_id === "ETH-USD" ? "ETH" : undefined;
        if (!market || !ticker.best_bid || !ticker.best_ask) continue;
        try {
          this.store(market, ticker.best_bid, ticker.best_ask, receivedAt);
        } catch {
          this.rejectedUpdates++;
        }
      }
  }
  private connect() {
    if (this.stopped || this.socket) return;
    const socket = (
      this.options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike)
    )(this.options.endpoint ?? "wss://advanced-trade-ws.coinbase.com");
    this.socket = socket;
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD", "ETH-USD"], channel: "ticker" }),
      );
      socket.send(JSON.stringify({ type: "subscribe", channel: "heartbeats" }));
    });
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    const reconnect = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.stopped)
        this.reconnectTimer = setTimeout(() => this.connect(), this.options.reconnectMs ?? 1_000);
    };
    socket.addEventListener("close", reconnect);
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        reconnect();
      }
    });
  }
  async start() {
    this.stopped = false;
    this.connect();
  }
  async close() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }
  async latest(market: OracleMarket) {
    const cached = this.cached[market];
    if (cached && Date.now() - cached.snapshot.observedAtMs <= (this.options.staleMs ?? 1_500)) return cached;
    return this.coalesce(market, async () => {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${this.options.restEndpoint ?? "https://api.exchange.coinbase.com/products"}/${market}-USD/ticker`,
        { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(2_000) },
      );
      if (!response.ok) throw new Error(`Coinbase ${market} ticker returned ${response.status}`);
      const body = (await response.json()) as { bid?: string; ask?: string };
      if (!body.bid || !body.ask) throw new Error(`Coinbase ${market} ticker was incomplete`);
      this.store(market, body.bid, body.ask);
      return this.cached[market]!;
    });
  }
}

interface ReportStream {
  on(event: "report", listener: (report: Report) => void): this;
  connect(): Promise<void>;
  close(): Promise<void>;
}
interface LatestReportClient {
  getLatestReport(feedId: string): Promise<Report>;
  createStream?(feedIds: string[]): ReportStream;
}
export interface ChainlinkSourceOptions {
  apiKey: string;
  userSecret: string;
  endpoint: string;
  wsEndpoint: string;
  feedIds: Record<OracleMarket, string>;
  feedDecimals: Record<OracleMarket, number>;
  timeoutMs?: number;
  client?: LatestReportClient;
}

/** Chainlink Data Streams v3 reports, streamed when the client supports it, otherwise fetched. */
export class ChainlinkDataStreamsSource extends BaseOracleSource {
  private client: LatestReportClient;
  private stream?: ReportStream;
  constructor(private options: ChainlinkSourceOptions) {
    super("chainlink-data-streams");
    if (!options.endpoint.startsWith("https://") || !options.wsEndpoint.startsWith("wss://"))
      throw new Error("Data Streams endpoints must use TLS");
    if (!options.apiKey || !options.userSecret) throw new Error("Data Streams credentials are required");
    this.client =
      options.client ??
      (createClient({
        apiKey: options.apiKey,
        userSecret: options.userSecret,
        endpoint: options.endpoint,
        wsEndpoint: options.wsEndpoint,
        timeout: options.timeoutMs ?? 2_000,
        retryAttempts: 1,
      }) as DataStreamsClient);
  }
  protected transport() {
    return this.stream ? "websocket" : "rest";
  }
  private normalize(market: OracleMarket, report: Report): OracleQuote {
    const feedId = this.options.feedIds[market],
      decoded = decodeStreamsV3Envelope(report.fullReport, feedId, this.options.feedDecimals[market]);
    if (
      report.feedID.toLowerCase() !== feedId.toLowerCase() ||
      report.observationsTimestamp !== decoded.observedAt
    )
      throw new Error("Data Streams metadata mismatch");
    return {
      snapshot: this.snapshot(market, decoded.bid, decoded.ask, decoded.observedAt * 1_000),
      report: report.fullReport,
      validUntil: decoded.validUntil,
    };
  }
  async start() {
    if (this.stream || !this.client.createStream) return;
    this.stream = this.client.createStream(Object.values(this.options.feedIds));
    const byFeed = new Map(MARKETS.map((market) => [this.options.feedIds[market].toLowerCase(), market]));
    this.stream.on("report", (report) => {
      const market = byFeed.get(report.feedID.toLowerCase());
      if (!market) return;
      try {
        this.cached[market] = this.normalize(market, report);
      } catch {
        this.rejectedUpdates++;
        return;
      }
      this.emit(market);
    });
    await this.stream.connect();
  }
  async close() {
    const stream = this.stream;
    this.stream = undefined;
    if (stream) await stream.close();
  }
  async latest(market: OracleMarket) {
    const cached = this.cached[market],
      now = Date.now();
    if (cached && now - cached.snapshot.observedAtMs <= 1_500 && cached.validUntil * 1_000 > now)
      return cached;
    return this.coalesce(market, async () => {
      const quote = this.normalize(market, await this.client.getLatestReport(this.options.feedIds[market]));
      this.cached[market] = quote;
      return quote;
    });
  }
}

export interface PythHermesSourceOptions {
  apiKey: string;
  endpoint?: string;
  feedIds: Record<OracleMarket, string>;
  timeoutMs?: number;
  cacheMs?: number;
  reconnectMs?: number;
  maxObservationAgeSeconds?: number;
  fetchImpl?: typeof fetch;
}
type HermesPrice = { id: string; price: { price: string; conf: string; expo: number; publish_time: number } };
type HermesResponse = { binary?: { encoding?: string; data?: string[] }; parsed?: HermesPrice[] };

/** Pyth Core prices from an authenticated Hermes endpoint; bid/ask are price -/+ confidence. */
export class PythHermesSource extends BaseOracleSource {
  private fetchedAtMs = 0;
  private settlementFetchedAtMs = 0;
  private streamAbort?: AbortController;
  private streamTask?: Promise<void>;
  private stopped = true;
  private streamFailures = 0;
  constructor(private options: PythHermesSourceOptions) {
    super("pyth-core");
    if (!this.endpoint().startsWith("https://")) throw new Error("Pyth Hermes endpoint must use TLS");
    if (!options.apiKey) throw new Error("Pyth Hermes API key is required");
    for (const feed of Object.values(options.feedIds))
      if (!/^0x[0-9a-fA-F]{64}$/.test(feed)) throw new Error("invalid Pyth feed ID");
  }
  protected transport() {
    return this.streamTask ? "authenticated-sse" : "authenticated-rest";
  }
  status() {
    return { ...super.status(), streamFailures: this.streamFailures };
  }
  private endpoint() {
    return (this.options.endpoint ?? "https://pyth.dourolabs.app/hermes").replace(/\/$/, "");
  }
  private url(path: string) {
    const url = new URL(`${this.endpoint()}${path}`);
    for (const feed of Object.values(this.options.feedIds)) url.searchParams.append("ids[]", feed);
    return url;
  }
  private scale(value: bigint, exponent: number, roundUp: boolean) {
    const scale = exponent + 6;
    if (scale < -18 || scale > 18) throw new Error("unsupported Pyth exponent");
    if (scale >= 0) return value * 10n ** BigInt(scale);
    const divisor = 10n ** BigInt(-scale);
    return roundUp ? (value + divisor - 1n) / divisor : value / divisor;
  }
  /** Validates a Hermes payload and caches every market it covers; returns those markets. */
  private accept(body: HermesResponse) {
    const raw = body.binary?.data;
    if (body.binary?.encoding !== "hex" || !raw?.length || !body.parsed?.length)
      throw new Error("Pyth Hermes response was incomplete");
    const updates = raw.map((value) => `0x${value.replace(/^0x/, "")}`),
      now = Math.floor(Date.now() / 1_000),
      changed: OracleMarket[] = [];
    for (const market of MARKETS) {
      const wanted = this.options.feedIds[market].toLowerCase().replace(/^0x/, ""),
        feed = body.parsed.find((item) => item.id.toLowerCase().replace(/^0x/, "") === wanted);
      if (!feed) continue;
      if (!Number.isInteger(feed.price.expo) || !Number.isInteger(feed.price.publish_time))
        throw new Error(`Pyth ${market} feed invalid`);
      const center = BigInt(feed.price.price),
        confidence = BigInt(feed.price.conf),
        observedAt = feed.price.publish_time;
      if (
        center <= 0n ||
        confidence < 0n ||
        confidence >= center ||
        observedAt > now + 2 ||
        now - observedAt > (this.options.maxObservationAgeSeconds ?? 4)
      )
        throw new Error(`Pyth ${market} observation rejected`);
      const bid = this.scale(center - confidence, feed.price.expo, false),
        ask = this.scale(center + confidence, feed.price.expo, true);
      this.cached[market] = {
        snapshot: this.snapshot(market, bid, ask, observedAt * 1_000),
        report: AbiCoder.defaultAbiCoder().encode(["uint8", "bytes[]"], [marketId(market), updates]),
        validUntil: observedAt + 15,
      };
      changed.push(market);
    }
    this.fetchedAtMs = Date.now();
    return changed;
  }
  /** Fetches one atomic REST batch covering every feed. */
  private refresh() {
    return this.coalesce("refresh", async () => {
      const response = await (this.options.fetchImpl ?? fetch)(this.url("/v2/updates/price/latest"), {
        headers: { authorization: `Bearer ${this.options.apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 2_500),
      });
      if (!response.ok) throw new Error(`Pyth Hermes returned ${response.status}`);
      if (this.accept((await response.json()) as HermesResponse).length !== MARKETS.length)
        throw new Error("Pyth Hermes response was incomplete");
      this.settlementFetchedAtMs = Date.now();
    });
  }
  private async stream(signal: AbortSignal) {
    const url = this.url("/v2/updates/price/stream");
    url.searchParams.set("parsed", "true");
    url.searchParams.set("encoding", "hex");
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      headers: { authorization: `Bearer ${this.options.apiKey}`, accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`Pyth Hermes stream returned ${response.status}`);
    for await (const event of readSseEvents(response.body)) {
      if (signal.aborted) return;
      let changed: OracleMarket[];
      try {
        changed = this.accept(JSON.parse(event.data) as HermesResponse);
      } catch {
        // One malformed or stale update does not invalidate the connection.
        this.rejectedUpdates++;
        continue;
      }
      for (const market of changed) this.emit(market);
    }
  }
  async start() {
    if (this.streamTask) return;
    this.stopped = false;
    this.streamAbort = new AbortController();
    const signal = this.streamAbort.signal;
    this.streamTask = (async () => {
      while (!this.stopped) {
        try {
          await this.stream(signal);
        } catch {
          if (signal.aborted) break;
          this.streamFailures++;
        }
        if (!this.stopped)
          await new Promise((resolve) => setTimeout(resolve, this.options.reconnectMs ?? 1_000));
      }
    })().finally(() => {
      this.streamTask = undefined;
    });
  }
  async close() {
    this.stopped = true;
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    await this.streamTask?.catch(() => {});
  }
  async latest(market: OracleMarket) {
    const cached = this.cached[market],
      now = Date.now();
    if (cached && now - this.fetchedAtMs <= (this.options.cacheMs ?? 500) && cached.validUntil * 1_000 > now)
      return cached;
    await this.refresh();
    const value = this.cached[market];
    if (!value) throw new Error(`Pyth ${market} market data unavailable`);
    return value;
  }
  async settlement(market: OracleMarket) {
    // SSE may carry only the feed that changed. Settlement needs an atomic REST
    // batch whose binary payload covers every parsed feed in the signed report.
    if (Date.now() - this.settlementFetchedAtMs > 100) await this.refresh();
    const value = this.cached[market];
    if (!value) throw new Error(`Pyth ${market} settlement data unavailable`);
    return value;
  }
}

export interface SimulatedSourceOptions {
  prices?: Partial<Record<OracleMarket, number>>;
  spreadBps?: number;
  volatilityBpsPerMinute?: number;
  tickMs?: number;
  random?: () => number;
  now?: () => number;
}

/** Offline random-walk prices for local development; same report encoding as the Coinbase source. */
export class SimulatedMarketDataSource extends BaseOracleSource {
  private mids: Record<OracleMarket, number>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private options: SimulatedSourceOptions = {}) {
    super("simulated");
    this.mids = { BTC: options.prices?.BTC ?? 100_000, ETH: options.prices?.ETH ?? 4_000 };
  }
  protected now() {
    return (this.options.now ?? Date.now)();
  }
  protected transport() {
    return "local";
  }
  private publish(market: OracleMarket) {
    const halfSpread = (this.mids[market] * (this.options.spreadBps ?? 1)) / 20_000;
    const bid = parseUnits((this.mids[market] - halfSpread).toFixed(6), 6),
      ask = parseUnits((this.mids[market] + halfSpread).toFixed(6), 6);
    const observedAtMs = Math.max(this.now(), (this.cached[market]?.snapshot.observedAtMs ?? 0) + 1);
    this.cached[market] = localQuote(this.snapshot(market, bid, ask, observedAtMs));
    this.emit(market);
  }
  /** Moves both markets one random-walk step. */
  step() {
    const tickMs = this.options.tickMs ?? 250,
      random = this.options.random ?? Math.random;
    const sigma = ((this.options.volatilityBpsPerMinute ?? 20) / 10_000) * Math.sqrt(tickMs / 60_000);
    for (const market of MARKETS) {
      const shock = (random() * 2 - 1) * Math.sqrt(3) * sigma;
      this.mids[market] *= 1 + shock;
      this.publish(market);
    }
  }
  /** Sets a market's mid price, for scripted scenarios such as a crash before a liquidation. */
  setPrice(market: OracleMarket, price: number) {
    if (!(price > 0)) throw new Error("price must be positive");
    this.mids[market] = price;
    this.publish(market);
  }
  prices() {
    return { ...this.mids };
  }
  async start() {
    for (const market of MARKETS) this.publish(market);
    if (!this.timer) {
      this.timer = setInterval(() => this.step(), this.options.tickMs ?? 250);
      this.timer.unref?.();
    }
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  status() {
    return { ...super.status(), prices: this.prices() };
  }
  async latest(market: OracleMarket): Promise<OracleQuote> {
    if (!this.cached[market]) this.publish(market);
    return this.cached[market]!;
  }
}
