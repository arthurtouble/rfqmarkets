import {
  priceBatchToWire,
  signPriceBatch,
  type OracleDomainInput,
  type PriceBatchWire,
  type SignedPrice,
  type SignedPriceBatch,
  type TypedDataSigner,
} from "../../../packages/shared/src/signed-oracle.js";
import {
  aggregateMarket,
  DEFAULT_AGGREGATION,
  DEFAULT_STABLE,
  marketQuotes,
  stableQuotes,
  stableRate,
  type AggregationConfig,
  type AggregationResult,
  type QuoteLookup,
  type StableConfig,
  type StableRates,
} from "./aggregate.js";
import type { CandleStore } from "./candles.js";
import { formatPrice } from "./decimal.js";
import { ADAPTERS } from "./exchanges/index.js";
import { ExchangeFeed, type FeedOptions } from "./feed.js";
import type { MarketSource, OracleMarketDefinition } from "./markets.js";
import {
  EXCHANGES,
  STABLE_INSTRUMENTS,
  resolveSymbol,
  type ExchangeName,
  type SymbolInstruments,
} from "./symbols.js";

export interface MarketOutcome {
  market: number;
  symbol: string;
  sources: string[];
  included: boolean;
  reason?: Extract<AggregationResult, { ok: false }>["reason"];
  bid?: bigint;
  ask?: bigint;
}

export interface SignedBatchRecord {
  batch: SignedPriceBatch;
  wire: PriceBatchWire;
  outcomes: MarketOutcome[];
}

export interface OracleNodeOptions {
  signer: TypedDataSigner & { address: string };
  domain: OracleDomainInput;
  marketSource: MarketSource;
  candles: CandleStore;
  exchanges?: readonly ExchangeName[];
  aggregation?: Partial<AggregationConfig>;
  stable?: Partial<StableConfig>;
  tickMs?: number;
  /** How often the market list is re-read from the MarketSource. */
  marketRefreshMs?: number;
  feedOptions?: FeedOptions;
  /** Injected feeds (tests); by default one ExchangeFeed per venue. */
  feedFactory?: (exchange: ExchangeName, tickers: string[]) => ExchangeFeed;
  now?: () => number;
  logError?: (message: string) => void;
}

/**
 * The oracle node: streams venue quotes, aggregates each market every tick and signs one
 * PriceBatch per second for the markets that pass the filters.
 */
export class OracleNode {
  private feeds = new Map<ExchangeName, ExchangeFeed>();
  private markets: Array<OracleMarketDefinition & { resolved: SymbolInstruments }> = [];
  private latestRecord?: SignedBatchRecord;
  private lastOutcomes: MarketOutcome[] = [];
  private rates: StableRates = {};
  private listeners = new Set<(record: SignedBatchRecord) => void>();
  private tickTimer?: ReturnType<typeof setTimeout>;
  private marketTimer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopped = true;
  private signFailures = 0;
  private aggregation: AggregationConfig;
  private stable: StableConfig;
  private exchanges: readonly ExchangeName[];
  constructor(private options: OracleNodeOptions) {
    this.aggregation = { ...DEFAULT_AGGREGATION, ...options.aggregation };
    this.stable = { ...DEFAULT_STABLE, maxAgeMs: this.aggregation.maxAgeMs, ...options.stable };
    this.exchanges = options.exchanges ?? EXCHANGES;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  get signerAddress() {
    return this.options.signer.address;
  }
  get domain() {
    return this.options.domain;
  }

  /** Loads the market list and (re)subscribes each venue to the tickers it needs. */
  async refreshMarkets() {
    const definitions = await this.options.marketSource.markets();
    const markets: typeof this.markets = [];
    for (const definition of definitions)
      try {
        markets.push({
          ...definition,
          resolved: resolveSymbol(definition.symbol, undefined, this.exchanges),
        });
      } catch (error) {
        this.options.logError?.(
          `oracle market ${definition.id}:${definition.symbol} skipped: ${(error as Error).message}`,
        );
      }
    this.markets = markets.sort((a, b) => a.id - b.id);
    const tickers = new Map<ExchangeName, Set<string>>(
      this.exchanges.map((exchange) => [exchange, new Set()]),
    );
    const stables = new Set<"USDT" | "USDC">();
    for (const market of this.markets)
      for (const instrument of market.resolved.instruments) {
        tickers.get(instrument.exchange)?.add(instrument.ticker);
        if (instrument.quote !== "USD") stables.add(instrument.quote);
      }
    for (const stable of stables)
      for (const instrument of STABLE_INSTRUMENTS[stable])
        tickers.get(instrument.exchange)?.add(instrument.ticker);
    for (const [exchange, set] of tickers) {
      const list = [...set],
        feed = this.feeds.get(exchange);
      if (feed) feed.setTickers(list);
      else if (list.length) {
        const created = this.options.feedFactory
          ? this.options.feedFactory(exchange, list)
          : new ExchangeFeed(ADAPTERS[exchange], list, {
              now: this.options.now,
              ...this.options.feedOptions,
            });
        this.feeds.set(exchange, created);
        if (!this.stopped) created.start();
      }
    }
  }

  private lookup: QuoteLookup = (exchange, ticker) => this.feeds.get(exchange)?.quote(ticker);

  /** Aggregates every market at `nowMs` without signing. */
  evaluate(nowMs = this.now()) {
    this.rates = {};
    for (const stable of ["USDT", "USDC"] as const) {
      const rate = stableRate(stableQuotes(STABLE_INSTRUMENTS[stable], this.lookup), nowMs, this.stable);
      if (rate !== undefined) this.rates[stable] = rate;
    }
    return this.markets.map((market) => {
      const result = aggregateMarket(
        marketQuotes(market.resolved, this.lookup, this.rates, this.stable.usdcParBps),
        nowMs,
        this.aggregation,
      );
      return { market, result };
    });
  }

  /** One aggregation + signing round. Returns the new record, or undefined when nothing was signed. */
  async tick(): Promise<SignedBatchRecord | undefined> {
    if (this.ticking) return undefined;
    this.ticking = true;
    try {
      const nowMs = this.now(),
        observedAt = Math.floor(nowMs / 1_000);
      const evaluated = this.evaluate(nowMs);
      this.lastOutcomes = evaluated.map(({ market, result }) => ({
        market: market.id,
        symbol: market.symbol,
        sources: result.sources,
        included: result.ok,
        ...(result.ok ? { bid: result.bid, ask: result.ask } : { reason: result.reason }),
      }));
      // At most one batch per second: observedAt strictly increases per signer.
      if (this.latestRecord && observedAt <= this.latestRecord.batch.observedAt) return undefined;
      const prices: SignedPrice[] = [];
      for (const { market, result } of evaluated)
        if (result.ok) {
          prices.push({ market: market.id, bid: result.bid, ask: result.ask });
          try {
            await this.options.candles.record(market.id, nowMs, (result.bid + result.ask) / 2n);
          } catch (error) {
            this.options.logError?.(`candle store failed: ${(error as Error).message}`);
          }
        }
      if (!prices.length) return undefined;
      let batch: SignedPriceBatch;
      try {
        batch = await signPriceBatch(this.options.signer, this.options.domain, { observedAt, prices });
      } catch {
        // Never surface signer internals.
        this.signFailures++;
        this.options.logError?.("oracle batch signing failed");
        return undefined;
      }
      const included = this.lastOutcomes.filter((outcome) => outcome.included);
      const record: SignedBatchRecord = {
        batch,
        outcomes: this.lastOutcomes,
        wire: priceBatchToWire(batch, this.options.signer.address, {
          symbols: new Map(included.map((outcome) => [outcome.market, outcome.symbol])),
          sources: new Map(included.map((outcome) => [outcome.market, outcome.sources.length])),
          domain: this.options.domain,
        }),
      };
      this.latestRecord = record;
      for (const listener of this.listeners)
        try {
          listener(record);
        } catch {
          // A failing subscriber must not stop signing.
        }
      return record;
    } finally {
      this.ticking = false;
    }
  }

  latest() {
    return this.latestRecord;
  }
  symbolOf(market: number) {
    return this.markets.find((definition) => definition.id === market)?.symbol;
  }
  subscribe(listener: (record: SignedBatchRecord) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  health() {
    const nowMs = this.now(),
      tickMs = this.options.tickMs ?? 1_000,
      latest = this.latestRecord;
    const lastBatchAgeMs = latest ? nowMs - latest.batch.observedAt * 1_000 : null;
    return {
      ok: lastBatchAgeMs !== null && lastBatchAgeMs <= Math.max(3 * tickMs, 3_000),
      signer: this.options.signer.address,
      chainId: BigInt(this.options.domain.chainId).toString(),
      verifyingContract: this.options.domain.verifyingContract,
      lastBatchAgeMs,
      lastObservedAt: latest?.batch.observedAt ?? null,
      signFailures: this.signFailures,
      sourcesConnected: [...this.feeds.values()].filter((feed) => feed.connected).length,
      sources: Object.fromEntries(
        [...this.feeds.entries()].map(([exchange, feed]) => [
          exchange,
          feed.status(this.aggregation.maxAgeMs),
        ]),
      ),
      stableRates: {
        USDT: this.rates.USDT === undefined ? null : formatPrice(this.rates.USDT),
        USDC: this.rates.USDC === undefined ? null : formatPrice(this.rates.USDC),
      },
      markets: this.lastOutcomes.map((outcome) => ({
        market: outcome.market,
        symbol: outcome.symbol,
        sources: outcome.sources.length,
        sourceNames: outcome.sources,
        included: outcome.included,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      })),
    };
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this.refreshMarkets();
    for (const feed of this.feeds.values()) feed.start();
    const tickMs = this.options.tickMs ?? 1_000;
    // Tick shortly after each period boundary so observedAt advances by one each round.
    const schedule = () => {
      if (this.stopped) return;
      const nowMs = this.now();
      this.tickTimer = setTimeout(
        () => {
          void this.tick().finally(schedule);
        },
        tickMs - (nowMs % tickMs) + 20,
      );
      this.tickTimer.unref?.();
    };
    schedule();
    this.marketTimer = setInterval(() => {
      this.refreshMarkets().catch((error) =>
        this.options.logError?.(`market refresh failed: ${(error as Error).message}`),
      );
    }, this.options.marketRefreshMs ?? 60_000);
    this.marketTimer.unref?.();
  }

  async close() {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.marketTimer) clearInterval(this.marketTimer);
    for (const feed of this.feeds.values()) feed.close();
    this.listeners.clear();
  }
}
