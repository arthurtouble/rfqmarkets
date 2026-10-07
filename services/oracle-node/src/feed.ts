import type { ExchangeAdapter, QuoteUpdate } from "./exchanges/types.js";

export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
};

export interface FeedOptions {
  socketFactory?: (url: string) => SocketLike;
  fetchImpl?: typeof fetch;
  /** First reconnect delay; doubles per failed attempt up to maxReconnectMs. */
  reconnectMs?: number;
  maxReconnectMs?: number;
  /** Application-level ping period for venues that have one. */
  pingMs?: number;
  /** A connection with no message for this long is recycled. */
  silenceMs?: number;
  /** How often stale tickers are refreshed over REST. */
  restPollMs?: number;
  /** A ticker older than this is refreshed over REST. */
  staleMs?: number;
  restTimeoutMs?: number;
  /**
   * Absolute cap on how long connection liveness may vouch for a websocket quote. Past it the quote
   * ages by its receive time, so a ticker the venue stopped updating (while the connection keeps
   * talking about others) is refreshed over REST or falls out of the aggregate. Default 30 s.
   */
  maxLiveQuoteAgeMs?: number;
  /** Cap on per-ticker REST requests in one poll (batch endpoints need one request). */
  maxRestRequests?: number;
  now?: () => number;
}

export interface FeedQuote {
  bid: bigint;
  ask: bigint;
  receivedAtMs: number;
  /** When the quote was last known to be current (see ExchangeAdapter.bboComplete). */
  asOfMs: number;
  transport: "websocket" | "rest";
}

export const DEFAULT_MAX_LIVE_QUOTE_AGE_MS = 30_000;

interface StoredQuote {
  bid: bigint;
  ask: bigint;
  receivedAtMs: number;
  /** Connection serial the quote arrived on; 0 for REST. */
  connection: number;
}

/**
 * One venue connection: websocket with reconnect/backoff, periodic pings, a silence watchdog and a
 * REST fallback for tickers the stream has not refreshed recently. Any venue may be down; the
 * aggregator simply sees fewer fresh sources.
 */
export class ExchangeFeed {
  private quotes = new Map<string, StoredQuote>();
  private socket?: SocketLike;
  private connection = 0;
  private openConnection = 0;
  private lastMessageAtMs = 0;
  private parser: (raw: string) => QuoteUpdate[];
  private failures = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private lastPingMs = 0;
  private restInFlight = false;
  private restBackoffUntilMs = 0;
  private restFailures = 0;
  private consecutiveRestFailures = 0;
  private restSuccesses = 0;
  private rejected = 0;
  private updates = 0;
  private reconnects = 0;
  private stopped = true;
  private tickers: string[];
  constructor(
    readonly adapter: ExchangeAdapter,
    tickers: readonly string[],
    private options: FeedOptions = {},
  ) {
    this.tickers = [...new Set(tickers)];
    this.parser = adapter.createParser();
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  get name() {
    return this.adapter.name;
  }
  get connected() {
    return (
      this.socket !== undefined && this.socket.readyState === 1 && this.openConnection === this.connection
    );
  }

  /** Replaces the subscribed tickers; reconnects when they changed. */
  setTickers(tickers: readonly string[]) {
    const next = [...new Set(tickers)];
    if (next.length === this.tickers.length && next.every((ticker) => this.tickers.includes(ticker))) return;
    this.tickers = next;
    for (const ticker of this.quotes.keys()) if (!next.includes(ticker)) this.quotes.delete(ticker);
    if (!this.stopped) this.recycle();
  }

  quote(ticker: string): FeedQuote | undefined {
    const stored = this.quotes.get(ticker);
    if (!stored) return undefined;
    const live =
      this.adapter.bboComplete &&
      stored.connection !== 0 &&
      stored.connection === this.openConnection &&
      this.connected &&
      this.now() - stored.receivedAtMs <= (this.options.maxLiveQuoteAgeMs ?? DEFAULT_MAX_LIVE_QUOTE_AGE_MS);
    return {
      bid: stored.bid,
      ask: stored.ask,
      receivedAtMs: stored.receivedAtMs,
      asOfMs: live ? Math.max(stored.receivedAtMs, this.lastMessageAtMs) : stored.receivedAtMs,
      transport: stored.connection === 0 ? "rest" : "websocket",
    };
  }

  private store(updates: QuoteUpdate[], connection: number, nowMs: number) {
    for (const update of updates) {
      if (!this.tickers.includes(update.ticker)) continue;
      if (update.cleared) {
        // Crossed or one-sided book: drop the last quote instead of serving it as current.
        this.quotes.delete(update.ticker);
        this.updates++;
        continue;
      }
      this.quotes.set(update.ticker, { bid: update.bid, ask: update.ask, receivedAtMs: nowMs, connection });
      this.updates++;
    }
  }

  /** Feeds one raw websocket message (exposed for tests). */
  handleMessage(raw: string, connection = this.connection) {
    if (connection !== this.connection) return;
    const nowMs = this.now();
    this.lastMessageAtMs = nowMs;
    this.failures = 0;
    try {
      this.store(this.parser(raw), connection, nowMs);
    } catch {
      this.rejected++;
    }
  }

  /** Marks the current connection open (exposed for tests). */
  handleOpen(connection = this.connection) {
    if (connection !== this.connection) return;
    this.openConnection = connection;
    this.lastMessageAtMs = this.now();
  }

  private connect() {
    if (this.stopped || this.socket || !this.tickers.length) return;
    const connection = ++this.connection;
    this.parser = this.adapter.createParser();
    let socket: SocketLike;
    try {
      socket = (this.options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike))(
        this.adapter.websocketUrl(this.tickers),
      );
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.handleOpen(connection);
      try {
        for (const message of this.adapter.subscribeMessages(this.tickers)) socket.send(message);
      } catch {
        this.recycle();
      }
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      const data = event.data;
      this.handleMessage(
        typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"),
        connection,
      );
    });
    const closed = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.openConnection = 0;
      this.scheduleReconnect();
    };
    socket.addEventListener("close", closed);
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        // ignored: closed() below handles the bookkeeping
      }
      closed();
    });
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const base = this.options.reconnectMs ?? 1_000,
      delay = Math.min(base * 2 ** Math.min(this.failures, 10), this.options.maxReconnectMs ?? 30_000);
    this.failures++;
    this.reconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private recycle() {
    const socket = this.socket;
    this.socket = undefined;
    this.openConnection = 0;
    try {
      socket?.close();
    } catch {
      // ignored
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connect();
  }

  /** Periodic housekeeping: pings, the silence watchdog and the REST fallback. */
  async maintain() {
    const nowMs = this.now();
    if (this.connected) {
      if (nowMs - this.lastMessageAtMs > (this.options.silenceMs ?? 10_000)) {
        this.recycle();
      } else if (this.adapter.pingMessage && nowMs - this.lastPingMs >= (this.options.pingMs ?? 1_000)) {
        this.lastPingMs = nowMs;
        try {
          this.socket!.send(this.adapter.pingMessage);
        } catch {
          this.recycle();
        }
      }
    }
    await this.pollRest(nowMs);
  }

  /** Refreshes stale tickers over REST (exposed for tests). */
  async pollRest(nowMs = this.now()) {
    if (this.restInFlight || nowMs < this.restBackoffUntilMs) return;
    const staleMs = this.options.staleMs ?? 1_500;
    const stale = this.tickers
      .map((ticker) => ({ ticker, asOf: this.quote(ticker)?.asOfMs ?? 0 }))
      .filter((entry) => nowMs - entry.asOf > staleMs)
      .sort((a, b) => a.asOf - b.asOf)
      .map((entry) => entry.ticker);
    if (!stale.length) return;
    const requests = this.adapter.restRequests(stale).slice(0, this.options.maxRestRequests ?? 4);
    this.restInFlight = true;
    let failed = false;
    try {
      await Promise.all(
        requests.map(async (request) => {
          try {
            const response = await (this.options.fetchImpl ?? fetch)(request.url, {
              headers: { accept: "application/json" },
              signal: AbortSignal.timeout(this.options.restTimeoutMs ?? 2_000),
            });
            if (!response.ok) throw new Error(`${this.name} REST returned ${response.status}`);
            const body = await response.json();
            this.store(request.parse(body), 0, this.now());
            this.restSuccesses++;
          } catch {
            failed = true;
            this.restFailures++;
          }
        }),
      );
    } finally {
      this.restInFlight = false;
    }
    // Back off a venue whose REST keeps failing (for example a geo-blocked one).
    if (failed) {
      this.consecutiveRestFailures = Math.min(this.consecutiveRestFailures + 1, 5);
      this.restBackoffUntilMs =
        this.now() + (this.options.restPollMs ?? 1_000) * 2 ** this.consecutiveRestFailures;
    } else {
      this.consecutiveRestFailures = 0;
      this.restBackoffUntilMs = 0;
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.timer = setInterval(
      () => void this.maintain(),
      Math.min(this.options.restPollMs ?? 1_000, this.options.pingMs ?? 1_000),
    );
    this.timer.unref?.();
  }

  close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.timer = this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.openConnection = 0;
    try {
      socket?.close();
    } catch {
      // ignored
    }
  }

  status(staleMs = 2_000) {
    const nowMs = this.now();
    return {
      connected: this.connected,
      lastMessageAgeMs: this.lastMessageAtMs ? nowMs - this.lastMessageAtMs : null,
      tickers: this.tickers.length,
      freshTickers: this.tickers.filter((ticker) => {
        const quote = this.quote(ticker);
        return quote !== undefined && nowMs - quote.asOfMs <= staleMs;
      }).length,
      updates: this.updates,
      rejected: this.rejected,
      reconnects: this.reconnects,
      restSuccesses: this.restSuccesses,
      restFailures: this.restFailures,
    };
  }
}
