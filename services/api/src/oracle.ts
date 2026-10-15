import { AbiCoder, parseUnits } from "ethers";
import type { PriceSnapshot } from "../../../packages/shared/src/policy.js";
import { readSseEvents } from "../../lib/src/sse.js";
import { encodeLocalReport } from "../../../packages/shared/src/oracle-report.js";
import { SignedOracleClient } from "../../../packages/shared/src/signed-oracle.js";
import { marketIndex, marketRegistry, marketSymbols } from "../../../packages/shared/src/markets.js";
import { MarketSignalTracker } from "./market-signals.js";

/** A registered market symbol (see `marketRegistry`). */
export type OracleMarket = string;
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
  /** Per registered market. */
  agesMs: Record<OracleMarket, number | null>;
  /** Upstream updates dropped because they could not be parsed or failed validation. */
  rejectedUpdates: number;
}

const marketId = (market: OracleMarket) => marketIndex(market);
/** Launch prices for the simulated source; other markets start at `DEFAULT_SIMULATED_PRICE`. */
const SIMULATED_PRICES: Record<string, number> = { BTC: 100_000, ETH: 4_000, SOL: 150 };
const DEFAULT_SIMULATED_PRICE = 100;
/** Lifetime of locally signed (mock-oracle) reports. */
const LOCAL_REPORT_TTL_SECONDS = 15;

/** Encodes the report format accepted by the local mock oracle adapter. */
function localQuote(snapshot: PriceSnapshot): OracleQuote {
  const observedAt = Math.floor(snapshot.observedAtMs / 1_000),
    validUntil = observedAt + LOCAL_REPORT_TTL_SECONDS;
  return {
    snapshot,
    validUntil,
    report: encodeLocalReport({
      market: marketId(snapshot.market as OracleMarket),
      bid: snapshot.bid,
      ask: snapshot.ask,
      observedAt,
      validUntil,
    }),
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
      agesMs: Object.fromEntries(marketSymbols().map((market) => [market, age(market)])),
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
        const product = typeof ticker.product_id === "string" ? ticker.product_id : "",
          market = product.endsWith("-USD") ? product.slice(0, -4) : undefined;
        if (!market || !marketRegistry.has(market) || !ticker.best_bid || !ticker.best_ask) continue;
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
      // Each registered market `X` is the Coinbase product `X-USD`. A market added later is served by the
      // REST fallback until the next reconnect subscribes it.

      socket.send(
        JSON.stringify({
          type: "subscribe",
          product_ids: marketSymbols().map((market) => `${market}-USD`),
          channel: "ticker",
        }),
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

export interface SignedOracleSourceOptions {
  /** Oracle node base URLs (three in production, each in its own region). */
  nodes: readonly string[];
  /** Authorized node signer addresses, as configured on the SignedPriceOracle adapter. */
  signers: readonly string[];
  threshold: number;
  maxDeviationBps: number;
  maxSkewSeconds: number;
  chainId: bigint | number;
  /** The SignedPriceOracle adapter address (the EIP-712 verifying contract). */
  adapter: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Prices from our own oracle nodes: each node streams signed batches, and the client combines a
 * majority into the report the SignedPriceOracle adapter verifies. A market without node consensus
 * has no quote, so trading on it stops instead of using a doubtful price.
 */
export class SignedOracleSource extends BaseOracleSource {
  private client: SignedOracleClient;
  private unsubscribe?: () => void;
  private lastObservedAt = 0;
  constructor(private options: SignedOracleSourceOptions) {
    super("signed-oracle");
    for (const node of options.nodes)
      if (!node.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(node))
        throw new Error("oracle nodes must use TLS");
    this.client = new SignedOracleClient({
      nodes: options.nodes,
      signers: options.signers,
      threshold: options.threshold,
      maxDeviationBps: options.maxDeviationBps,
      maxSkewSeconds: options.maxSkewSeconds,
      domain: { chainId: options.chainId, verifyingContract: options.adapter },
      fetchImpl: options.fetchImpl,
      now: options.now,
    });
  }
  protected now() {
    return (this.options.now ?? Date.now)();
  }
  protected transport() {
    const transports = this.client.status().map((node) => node.transport);
    return transports.includes("sse") ? "sse" : transports.includes("rest") ? "rest" : "down";
  }
  async start() {
    this.unsubscribe = this.client.subscribe(() => this.refresh());
    await this.client.start();
    this.refresh();
  }
  async close() {
    this.unsubscribe?.();
    await this.client.close();
  }
  nodeStatus() {
    return this.client.status();
  }
  /** Rebuilds the per-market quotes when the combined report moves forward. */
  private refresh() {
    const combined = this.client.latest();
    if (!combined || combined.observedAt <= this.lastObservedAt) return;
    this.lastObservedAt = combined.observedAt;
    for (const market of marketSymbols()) {
      const price = combined.prices.find((item) => item.market === marketId(market));
      if (!price) {
        delete this.cached[market];
        continue;
      }
      this.cached[market] = {
        snapshot: this.snapshot(market, price.bid, price.ask, combined.observedAt * 1_000),
        report: combined.report,
        validUntil: combined.validUntil,
      };
      this.emit(market);
    }
  }
  async latest(market: OracleMarket): Promise<OracleQuote> {
    this.refresh();
    let quote = this.cached[market];
    if (!quote || quote.validUntil * 1_000 <= this.now()) {
      await this.coalesce("poll", () => this.client.poll());
      this.refresh();
      quote = this.cached[market];
    }
    if (!quote || quote.validUntil * 1_000 <= this.now())
      throw new Error(`no oracle consensus for ${market}`);
    return quote;
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
  private mids: Record<OracleMarket, number> = {};
  private timer?: ReturnType<typeof setInterval>;
  constructor(private options: SimulatedSourceOptions = {}) {
    super("simulated");
    for (const market of marketSymbols()) this.mid(market);
  }
  /** A market's mid, starting a market the registry added since at its configured or default price. */
  private mid(market: OracleMarket) {
    return (this.mids[market] ??=
      this.options.prices?.[market] ?? SIMULATED_PRICES[market] ?? DEFAULT_SIMULATED_PRICE);
  }
  protected now() {
    return (this.options.now ?? Date.now)();
  }
  protected transport() {
    return "local";
  }
  private publish(market: OracleMarket) {
    const mid = this.mid(market),
      halfSpread = (mid * (this.options.spreadBps ?? 1)) / 20_000;
    const bid = parseUnits((mid - halfSpread).toFixed(6), 6),
      ask = parseUnits((mid + halfSpread).toFixed(6), 6);
    const observedAtMs = Math.max(this.now(), (this.cached[market]?.snapshot.observedAtMs ?? 0) + 1);
    this.cached[market] = localQuote(this.snapshot(market, bid, ask, observedAtMs));
    this.emit(market);
  }
  /** Moves every registered market one random-walk step. */
  step() {
    const tickMs = this.options.tickMs ?? 250,
      random = this.options.random ?? Math.random;
    const sigma = ((this.options.volatilityBpsPerMinute ?? 20) / 10_000) * Math.sqrt(tickMs / 60_000);
    for (const market of marketSymbols()) {
      const shock = (random() * 2 - 1) * Math.sqrt(3) * sigma;
      this.mids[market] = this.mid(market) * (1 + shock);
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
    for (const market of marketSymbols()) this.publish(market);
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
