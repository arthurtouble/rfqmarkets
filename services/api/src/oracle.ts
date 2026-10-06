import { createClient, type DataStreamsClient, type Report } from "@chainlink/data-streams-sdk";
import { AbiCoder, parseUnits } from "ethers";
import { decodeStreamsV3Envelope } from "../../../packages/shared/src/streams.js";
import type { PriceSnapshot } from "../../../packages/shared/src/policy.js";
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

export class CoinbaseMarketDataSource implements OracleSource {
  private cached: Partial<Record<OracleMarket, { snapshot: PriceSnapshot; receivedAtMs: number }>> = {};
  private socket?: SocketLike;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private inFlight: Partial<Record<OracleMarket, Promise<OracleQuote>>> = {};
  private listeners = new Set<OracleListener>();
  private signals = new MarketSignalTracker();
  constructor(private options: CoinbaseSourceOptions = {}) {}
  private store(market: OracleMarket, bidText: string, askText: string, receivedAtMs = Date.now()) {
    const bid = parseUnits(bidText, 6),
      ask = parseUnits(askText, 6);
    if (bid <= 0n || ask < bid) throw new Error("invalid Coinbase market data");
    receivedAtMs = Math.max(receivedAtMs, (this.cached[market]?.receivedAtMs ?? 0) + 1);
    const mid = (bid + ask) / 2n,
      volatility = this.signals.observe(market, mid, receivedAtMs);
    this.cached[market] = {
      snapshot: {
        market,
        bid,
        ask,
        observedAtMs: receivedAtMs,
        source: "coinbase",
        volatilityBps: volatility.riskBps,
        volatility,
      },
      receivedAtMs,
    };
    for (const listener of this.listeners) listener(market);
  }
  private quote(market: OracleMarket): OracleQuote {
    const item = this.cached[market];
    if (!item) throw new Error(`${market} market data unavailable`);
    const observedAt = Math.floor(item.receivedAtMs / 1_000),
      validUntil = observedAt + 15,
      marketId = market === "BTC" ? 0 : 1;
    return {
      snapshot: item.snapshot,
      validUntil,
      report: AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],
        [[marketId, item.snapshot.bid, item.snapshot.ask, observedAt, validUntil]],
      ),
    };
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
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        if (message.channel !== "ticker") return;
        const receivedAt = Date.now();
        for (const item of message.events ?? [])
          for (const ticker of item.tickers ?? []) {
            const market =
              ticker.product_id === "BTC-USD" ? "BTC" : ticker.product_id === "ETH-USD" ? "ETH" : undefined;
            if (market && ticker.best_bid && ticker.best_ask)
              this.store(market, ticker.best_bid, ticker.best_ask, receivedAt);
          }
      } catch {}
    });
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
  subscribe(listener: OracleListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }
  status() {
    const now = Date.now();
    return {
      source: "coinbase",
      transport: this.socket?.readyState === 1 ? "websocket" : "rest-fallback",
      agesMs: {
        BTC: this.cached.BTC ? now - this.cached.BTC.receivedAtMs : null,
        ETH: this.cached.ETH ? now - this.cached.ETH.receivedAtMs : null,
      },
    };
  }
  async latest(market: OracleMarket) {
    const item = this.cached[market],
      staleMs = this.options.staleMs ?? 1_500;
    if (item && Date.now() - item.receivedAtMs <= staleMs) return this.quote(market);
    const active = this.inFlight[market];
    if (active) return active;
    const request = (async () => {
      const product = `${market}-USD`,
        response = await (this.options.fetchImpl ?? fetch)(
          `${this.options.restEndpoint ?? "https://api.exchange.coinbase.com/products"}/${product}/ticker`,
          { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(2_000) },
        );
      if (!response.ok) throw new Error(`Coinbase ${market} ticker returned ${response.status}`);
      const body = (await response.json()) as { bid?: string; ask?: string };
      if (!body.bid || !body.ask) throw new Error(`Coinbase ${market} ticker was incomplete`);
      this.store(market, body.bid, body.ask);
      return this.quote(market);
    })().finally(() => {
      delete this.inFlight[market];
    });
    this.inFlight[market] = request;
    return request;
  }
}

export class ChainlinkDataStreamsSource implements OracleSource {
  private client: LatestReportClient;
  private inFlight: Partial<Record<OracleMarket, Promise<OracleQuote>>> = {};
  private cached: Partial<Record<OracleMarket, OracleQuote>> = {};
  private stream?: ReportStream;
  private listeners = new Set<OracleListener>();
  private signals = new MarketSignalTracker();
  constructor(private options: ChainlinkSourceOptions) {
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
  private normalize(market: OracleMarket, report: Report) {
    const feedId = this.options.feedIds[market],
      decoded = decodeStreamsV3Envelope(report.fullReport, feedId, this.options.feedDecimals[market]);
    if (
      report.feedID.toLowerCase() !== feedId.toLowerCase() ||
      report.observationsTimestamp !== decoded.observedAt
    )
      throw new Error("Data Streams metadata mismatch");
    const mid = (decoded.bid + decoded.ask) / 2n,
      volatility = this.signals.observe(market, mid, decoded.observedAt * 1_000);
    return {
      snapshot: {
        market,
        bid: decoded.bid,
        ask: decoded.ask,
        observedAtMs: decoded.observedAt * 1_000,
        source: "chainlink-data-streams",
        volatilityBps: volatility.riskBps,
        volatility,
      },
      report: report.fullReport,
      validUntil: decoded.validUntil,
    };
  }
  async start() {
    if (this.stream || !this.client.createStream) return;
    this.stream = this.client.createStream(Object.values(this.options.feedIds));
    const byFeed = new Map(
      Object.entries(this.options.feedIds).map(([market, feed]) => [
        feed.toLowerCase(),
        market as OracleMarket,
      ]),
    );
    this.stream.on("report", (report) => {
      const market = byFeed.get(report.feedID.toLowerCase());
      if (!market) return;
      try {
        this.cached[market] = this.normalize(market, report);
        for (const listener of this.listeners) listener(market);
      } catch {}
    });
    await this.stream.connect();
  }
  subscribe(listener: OracleListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close() {
    const stream = this.stream;
    this.stream = undefined;
    if (stream) await stream.close();
  }
  status() {
    const now = Date.now();
    return {
      source: "chainlink-data-streams",
      transport: this.stream ? "websocket" : "rest",
      agesMs: {
        BTC: this.cached.BTC ? now - this.cached.BTC.snapshot.observedAtMs : null,
        ETH: this.cached.ETH ? now - this.cached.ETH.snapshot.observedAtMs : null,
      },
    };
  }
  async latest(market: OracleMarket) {
    const cached = this.cached[market];
    if (
      cached &&
      Date.now() - cached.snapshot.observedAtMs <= 1_500 &&
      cached.validUntil * 1_000 > Date.now()
    )
      return cached;
    const active = this.inFlight[market];
    if (active) return active;
    const request = (async () => {
      const quote = this.normalize(market, await this.client.getLatestReport(this.options.feedIds[market]));
      this.cached[market] = quote;
      return quote;
    })().finally(() => {
      delete this.inFlight[market];
    });
    this.inFlight[market] = request;
    return request;
  }
}

type HermesPrice = { id: string; price: { price: string; conf: string; expo: number; publish_time: number } };
type HermesResponse = { binary?: { encoding?: string; data?: string[] }; parsed?: HermesPrice[] };

export class PythHermesSource implements OracleSource {
  private cached: Partial<Record<OracleMarket, OracleQuote>> = {};
  private fetchedAtMs = 0;
  private inFlight?: Promise<void>;
  private streamAbort?: AbortController;
  private streamTask?: Promise<void>;
  private stopped = true;
  private listeners = new Set<OracleListener>();
  private signals = new MarketSignalTracker();
  private settlementFetchedAtMs = 0;
  constructor(private options: PythHermesSourceOptions) {
    const endpoint = options.endpoint ?? "https://pyth.dourolabs.app/hermes";
    if (!endpoint.startsWith("https://")) throw new Error("Pyth Hermes endpoint must use TLS");
    if (!options.apiKey) throw new Error("Pyth Hermes API key is required");
    for (const feed of Object.values(options.feedIds))
      if (!/^0x[0-9a-fA-F]{64}$/.test(feed)) throw new Error("invalid Pyth feed ID");
  }
  private scale(value: bigint, exponent: number, roundUp: boolean) {
    const scale = exponent + 6;
    if (scale < -18 || scale > 18) throw new Error("unsupported Pyth exponent");
    if (scale >= 0) return value * 10n ** BigInt(scale);
    const divisor = 10n ** BigInt(-scale);
    return roundUp ? (value + divisor - 1n) / divisor : value / divisor;
  }
  private accept(body: HermesResponse) {
    const raw = body.binary?.data;
    if (body.binary?.encoding !== "hex" || !raw?.length || !body.parsed?.length)
      throw new Error("Pyth Hermes response was incomplete");
    const updates = raw.map((value) => `0x${value.replace(/^0x/, "")}`),
      now = Math.floor(Date.now() / 1_000),
      changed: OracleMarket[] = [];
    for (const market of ["BTC", "ETH"] as const) {
      const feed = body.parsed.find(
        (item) =>
          item.id.toLowerCase().replace(/^0x/, "") ===
          this.options.feedIds[market].toLowerCase().replace(/^0x/, ""),
      );
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
        ask = this.scale(center + confidence, feed.price.expo, true),
        mid = (bid + ask) / 2n,
        volatility = this.signals.observe(market, mid, observedAt * 1_000),
        volatilityBps = volatility.riskBps;
      const validUntil = observedAt + 15,
        marketId = market === "BTC" ? 0 : 1,
        report = AbiCoder.defaultAbiCoder().encode(["uint8", "bytes[]"], [marketId, updates]);
      this.cached[market] = {
        snapshot: {
          market,
          bid,
          ask,
          observedAtMs: observedAt * 1_000,
          source: "pyth-core",
          volatilityBps,
          volatility,
        },
        report,
        validUntil,
      };
      changed.push(market);
    }
    this.fetchedAtMs = Date.now();
    return changed;
  }
  private async refresh() {
    const endpoint = (this.options.endpoint ?? "https://pyth.dourolabs.app/hermes").replace(/\/$/, "");
    const url = new URL(`${endpoint}/v2/updates/price/latest`);
    for (const feed of Object.values(this.options.feedIds)) url.searchParams.append("ids[]", feed);
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      headers: { authorization: `Bearer ${this.options.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 2_500),
    });
    if (!response.ok) throw new Error(`Pyth Hermes returned ${response.status}`);
    const changed = this.accept((await response.json()) as HermesResponse);
    if (changed.length !== 2) throw new Error("Pyth Hermes response was incomplete");
    this.settlementFetchedAtMs = Date.now();
  }
  private async stream(signal: AbortSignal) {
    const endpoint = (this.options.endpoint ?? "https://pyth.dourolabs.app/hermes").replace(/\/$/, "");
    const url = new URL(`${endpoint}/v2/updates/price/stream`);
    for (const feed of Object.values(this.options.feedIds)) url.searchParams.append("ids[]", feed);
    url.searchParams.set("parsed", "true");
    url.searchParams.set("encoding", "hex");
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      headers: { authorization: `Bearer ${this.options.apiKey}`, accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`Pyth Hermes stream returned ${response.status}`);
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data) continue;
        for (const market of this.accept(JSON.parse(data) as HermesResponse))
          for (const listener of this.listeners) listener(market);
      }
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
        }
        if (!this.stopped)
          await new Promise((resolve) => setTimeout(resolve, this.options.reconnectMs ?? 1_000));
      }
    })().finally(() => {
      this.streamTask = undefined;
    });
  }
  subscribe(listener: OracleListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close() {
    this.stopped = true;
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    await this.streamTask?.catch(() => {});
  }
  status() {
    const now = Date.now();
    return {
      source: "pyth-core",
      transport: this.streamTask ? "authenticated-sse" : "authenticated-rest",
      agesMs: {
        BTC: this.cached.BTC ? now - this.cached.BTC.snapshot.observedAtMs : null,
        ETH: this.cached.ETH ? now - this.cached.ETH.snapshot.observedAtMs : null,
      },
    };
  }
  async latest(market: OracleMarket) {
    const cached = this.cached[market],
      now = Date.now();
    if (cached && now - this.fetchedAtMs <= (this.options.cacheMs ?? 500) && cached.validUntil * 1_000 > now)
      return cached;
    if (!this.inFlight)
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = undefined;
      });
    await this.inFlight;
    const value = this.cached[market];
    if (!value) throw new Error(`Pyth ${market} market data unavailable`);
    return value;
  }
  async settlement(market: OracleMarket) {
    // SSE may carry only the feed that changed. Settlement needs an atomic REST
    // batch whose binary payload covers every parsed feed in the signed report.
    if (Date.now() - this.settlementFetchedAtMs > 100) {
      if (!this.inFlight)
        this.inFlight = this.refresh().finally(() => {
          this.inFlight = undefined;
        });
      await this.inFlight;
    }
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
export class SimulatedMarketDataSource implements OracleSource {
  private mids: Record<OracleMarket, number>;
  private cached: Partial<Record<OracleMarket, { snapshot: PriceSnapshot; receivedAtMs: number }>> = {};
  private listeners = new Set<OracleListener>();
  private signals = new MarketSignalTracker();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private options: SimulatedSourceOptions = {}) {
    this.mids = { BTC: options.prices?.BTC ?? 100_000, ETH: options.prices?.ETH ?? 4_000 };
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private publish(market: OracleMarket) {
    const halfSpread = (this.mids[market] * (this.options.spreadBps ?? 1)) / 20_000;
    const bid = parseUnits((this.mids[market] - halfSpread).toFixed(6), 6),
      ask = parseUnits((this.mids[market] + halfSpread).toFixed(6), 6);
    const receivedAtMs = Math.max(this.now(), (this.cached[market]?.receivedAtMs ?? 0) + 1);
    const volatility = this.signals.observe(market, (bid + ask) / 2n, receivedAtMs);
    this.cached[market] = {
      snapshot: {
        market,
        bid,
        ask,
        observedAtMs: receivedAtMs,
        source: "simulated",
        volatilityBps: volatility.riskBps,
        volatility,
      },
      receivedAtMs,
    };
    for (const listener of this.listeners) listener(market);
  }
  /** Moves both markets one random-walk step. */
  step() {
    const tickMs = this.options.tickMs ?? 250,
      random = this.options.random ?? Math.random;
    const sigma = ((this.options.volatilityBpsPerMinute ?? 20) / 10_000) * Math.sqrt(tickMs / 60_000);
    for (const market of ["BTC", "ETH"] as const) {
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
    this.publish("BTC");
    this.publish("ETH");
    if (!this.timer) {
      this.timer = setInterval(() => this.step(), this.options.tickMs ?? 250);
      this.timer.unref?.();
    }
  }
  subscribe(listener: OracleListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  status() {
    const now = this.now();
    return {
      source: "simulated",
      transport: "local",
      agesMs: {
        BTC: this.cached.BTC ? now - this.cached.BTC.receivedAtMs : null,
        ETH: this.cached.ETH ? now - this.cached.ETH.receivedAtMs : null,
      },
      prices: this.prices(),
    };
  }
  async latest(market: OracleMarket): Promise<OracleQuote> {
    if (!this.cached[market]) this.publish(market);
    const item = this.cached[market]!,
      observedAt = Math.floor(item.receivedAtMs / 1_000),
      validUntil = observedAt + 15,
      marketId = market === "BTC" ? 0 : 1;
    return {
      snapshot: item.snapshot,
      validUntil,
      report: AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)"],
        [[marketId, item.snapshot.bid, item.snapshot.ask, observedAt, validUntil]],
      ),
    };
  }
}
