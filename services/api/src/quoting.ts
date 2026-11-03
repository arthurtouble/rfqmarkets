import { toLimitWord, type ClearingLimitsStruct } from "../../../packages/shared/src/clearing-structs.js";
import { getAddress, keccak256, type JsonRpcProvider } from "ethers";
import type { FastifyInstance } from "fastify";
import { isPositionReduction } from "../../../packages/shared/src/exposure-admission.js";
import {
  hedgeAdmission,
  hedgeModeOf,
  type HedgeExecutionSignal,
  type HedgeRiskMode,
  type HedgeRiskSnapshot,
} from "../../../packages/shared/src/hedge-risk.js";
import {
  adaptiveSpread,
  BASE,
  constructQuote,
  launchPricing,
  marketMarginView,
  MIN_TRADE_ERROR,
  MIN_TRADE_NOTIONAL,
  parseUsdc,
  quoteRequestSchema,
  RATE,
  SPREAD_UNITS_PER_BPS,
  tradingFeeBps,
  type PriceSnapshot,
  type PricingParameters,
  type Quote,
  type QuoteRequest,
} from "../../../packages/shared/src/policy.js";
import { readViews, type ViewCall } from "../../../packages/shared/src/rpc.js";
import { quoteToWire } from "../../../packages/shared/src/wire.js";
import { decodeLimits, encodeLocalReport, type ChainMarketState, type ChainReader } from "./chain.js";
import type { ApiContext } from "./context.js";
import type { DevChain } from "./dev-chain.js";
import type { HttpGuards } from "./http.js";
import { abs, marketIndex, marketRegistry, unixSeconds, type Market } from "./markets.js";
import type { OracleQuote } from "./oracle.js";
import { publicError } from "./public-error.js";
import type { OracleReport, ProtocolVersions } from "./quote-store.js";
import { closeAllQuoteSchema, closeQuoteSchema } from "./schemas.js";
import { ShadowModelTelemetry } from "./shadow-model.js";

const YEAR_SECONDS = 365n * 24n * 60n * 60n;
/** Limits used when the leader runs without a chain (tests and offline previews). */
const DEFAULT_TRADE_LIMIT = 1_000_000n * 1_000_000n;
const DEFAULT_MARKET_LIMIT = 5_000_000n * 1_000_000n;
/** A cross-market price older than this is refreshed on chain before quoting against gross risk. */
const CROSS_MARKET_PRICE_MAX_AGE_SECONDS = 8;
/**
 * Withdrawals and isolated margin moves carry no oracle report, so the contract checks the stored
 * price of every market the paying account holds (MAX_ORACLE_AGE, 15 s) when the transaction lands.
 * Refreshing anything older than this leaves ~10 s for the simulation, the sender queue and inclusion.
 */
export const SIGNED_ACTION_PRICE_MAX_AGE_SECONDS = 5;
/** Local oracle reports and dev-chain proofs are valid for one minute. */
const LOCAL_REPORT_TTL_SECONDS = 60;
/** A firm quote must leave this much proof validity for wallet signing and inclusion. */
const ORACLE_INCLUSION_MARGIN_MS = 4_000;
const DEFAULT_HEDGE_RISK_MAX_AGE_MS = 3_000;
const MARKET_READ_CACHE_MS = 500;

/**
 * Hedge state that fails closed: every market is reduce-only until the hedger reports again (a
 * market missing from a snapshot is reduce-only, see `hedgeModeOf`).
 */
const UNAVAILABLE_HEDGE: HedgeRiskSnapshot = {
  observedAtMs: 0,
  healthy: false,
  indexedBlock: -1,
  markets: {},
};

export type MarketView = {
  market: Market;
  /** The market's contract index (session `marketMask` bit, intent `market`). */
  index: number;
  bid: string;
  ask: string;
  mid: string;
  observedAtMs: number;
  source: string;
  volatilityBps: number;
  volatility: PriceSnapshot["volatility"];
  /** The quoted spread over the mid for a small trade (the adaptive total), in bps (0.1 bp steps). */
  baseSpreadBps: number;
  /** The trading fee every fill in this market pays, in bps of notional. */
  feeBps: number;
  aggregateBase: string;
  fundingApr: string;
  fundingIndex: string;
  projectedFundingIndex: string;
  fundingTime: number;
  lastPriceTime: number;
  enabled: boolean;
  maxTradeNotional: string;
  maxMarketNotional: string;
  riskMode: HedgeRiskMode;
  spread: Record<string, string | number>;
  operatingMaxTradeNotional: string;
  canBuy: boolean;
  canSell: boolean;
  /** The market's margin multiplier on the base tiers (10_000 = 1x, 2_500 = 0.25x). */
  marginScaleBps: number;
  /** Leverage the first tier's scaled initial margin allows (20 at 2_500). */
  maxLeverage: number;
  /** First-tier scaled initial and maintenance margin rates, in bps of notional. */
  initialMarginBps: number;
  maintenanceMarginBps: number;
};

export type MarketsSnapshot = {
  blockNumber: number;
  serverTimeMs: number;
  markets: Record<Market, MarketView>;
  pricing: {
    settled: Record<Market, string>;
    pending: ReturnType<ApiContext["pending"]["envelope"]>;
    baseSpreadBps: number;
    /** The fee of a market without its own base spread; each market's own is `markets[m].feeBps`. */
    feeBps: number;
    toleranceBps: number;
  };
};

export type QuoteOptions = {
  /** Store the quote so it can be prepared and approved; indicative quotes are not stored. */
  persist?: boolean;
  /** Quote an exact base quantity (close quotes and refreshed approvals) instead of a USDC amount. */
  exactBaseDelta?: bigint;
  /** Account whose position reduction may exceed the per-trade limit. */
  reductionAccount?: string;
  /** Reservation to leave out of the pending envelope (the approval being refreshed). */
  excludeReservation?: string;
};

export type CreatedQuote = {
  quote: Quote;
  versions: ProtocolVersions;
  oracleReport?: OracleReport;
  reservationRevision: number;
};

function quoteSpread(
  snapshot: PriceSnapshot,
  riskMode: HedgeRiskMode,
  toxicityScoreBps: number,
  execution?: HedgeExecutionSignal,
  volatilityScale = 1,
) {
  // No base component: the market's on-chain base spread and the platform's share are charged as the
  // trading fee (`tradingFeeBps`), so only the model's risk components move the price off the mid.
  return adaptiveSpread({
    volatilityBps: (snapshot.volatilityBps ?? 0) * volatilityScale,
    riskMode,
    toxicityScoreBps,
    hedgeCostBps: execution?.estimatedCostBps,
    hedgeLatencyMs: execution?.latencyMs,
    venueBasisBps: execution?.basisBps,
  });
}

/** Maker inventory notional at `mark`, or at the last on-chain mid when no mark is given. */
function marketNotional(state: ChainMarketState, mark?: bigint) {
  return (
    (BigInt(state.aggregateBase) * (mark ?? (BigInt(state.lastBid) + BigInt(state.lastAsk)) / 2n)) / BASE
  );
}

const midOf = (snapshot: PriceSnapshot) => (snapshot.bid + snapshot.ask) / 2n;

/** Firm and indicative pricing plus the cached public market snapshot. */
export class QuoteEngine {
  readonly shadowTelemetry = new ShadowModelTelemetry();
  private marketReadCache: { at: number; promise: Promise<MarketsSnapshot> } | undefined;
  private readonly refreshing = new Map<string, Promise<void>>();
  private marketStateCache:
    { at: number; count: number; promise: ReturnType<QuoteEngine["loadMarketState"]> } | undefined;

  constructor(
    private readonly ctx: ApiContext,
    private readonly chain: ChainReader,
    private readonly dev: DevChain,
  ) {}

  invalidateMarkets() {
    this.marketReadCache = undefined;
    this.marketStateCache = undefined;
  }

  /**
   * The chain half of the market snapshot: block, market states, limits and margin scales, in one
   * aggregated read. The snapshot is rebuilt on every price update, so `marketStateMaxAgeMs` lets it
   * reuse these reads (prices still update every time); quotes never use them.
   */
  private marketState(now: number) {
    const maxAge = this.ctx.options.marketStateMaxAgeMs ?? 0;
    const count = marketRegistry.count;
    if (
      this.marketStateCache &&
      this.marketStateCache.count === count &&
      now - this.marketStateCache.at < maxAge
    )
      return this.marketStateCache.promise;
    const promise = this.loadMarketState();
    this.marketStateCache = { at: now, count, promise };
    promise.catch(() => {
      if (this.marketStateCache?.promise === promise) this.marketStateCache = undefined;
    });
    return promise;
  }

  private async loadMarketState() {
    const clearing = this.ctx.readClearing,
      registered = marketRegistry.all();
    if (!clearing) return undefined;
    const provider = clearing.runner!.provider! as JsonRpcProvider,
      // Not getBlockNumber(): ethers serves that from a short cache, and account reads at this block
      // must include a trade that has just settled.
      blockNumber = Number(BigInt(await provider.send("eth_blockNumber", []))),
      block = await provider.getBlock(blockNumber),
      values = await readViews(
        clearing,
        registered.flatMap(({ index }): ViewCall[] => [
          ["markets", index],
          ["marketLimits", index],
          ["marketParams", index],
        ]),
        blockNumber,
      );
    const at = (index: number, field: number) => values[index * 3 + field];
    return {
      blockNumber,
      block,
      chainMarkets: registered.map((_, index) => at(index, 0) as ChainMarketState),
      limitWords: registered.map((_, index) => toLimitWord(at(index, 1) as ClearingLimitsStruct)),
      marginScales: Object.fromEntries(
        registered.map(({ symbol }, index) => [
          symbol,
          Number((at(index, 2) as { marginScaleBps: unknown }).marginScaleBps),
        ]),
      ) as Record<Market, number>,
    };
  }

  /** The latest price for `market`; throws when there is none (e.g. no oracle price yet). */
  private priceOf(market: Market) {
    const snapshot = this.ctx.prices[market];
    if (!snapshot) throw new Error(`no price for ${market}`);
    return snapshot;
  }

  /** The latest hedger snapshot; a missing or stale snapshot fails closed to reduce-only. */
  async hedgeRisk(): Promise<HedgeRiskSnapshot | undefined> {
    const { hedgeRiskSource, hedgeRiskMaxAgeMs } = this.ctx.options;
    if (!hedgeRiskSource) return undefined;
    try {
      const value = await hedgeRiskSource.latest();
      if (
        !value.observedAtMs ||
        Date.now() - value.observedAtMs > (hedgeRiskMaxAgeMs ?? DEFAULT_HEDGE_RISK_MAX_AGE_MS)
      )
        throw new Error("stale hedge health");
      return value;
    } catch {
      return UNAVAILABLE_HEDGE;
    }
  }

  /** A settlement-grade oracle observation (authenticated proof when the source offers one). */
  async settlementOracle(market: Market): Promise<OracleQuote> {
    const source = this.ctx.options.oracleSource;
    if (!source) throw new Error("oracle unavailable");
    return source.settlement ? source.settlement(market) : source.latest(market);
  }

  /** Refresh the quoted market's price; without an oracle the configured price is re-stamped. */
  private async refreshPrice(market: Market) {
    const { prices, options } = this.ctx;
    if (!options.oracleSource) {
      const configured = prices[market];
      if (!configured) throw new Error(`no price configured for ${market}`);
      configured.observedAtMs = Date.now();
      return undefined;
    }
    const observation = await this.settlementOracle(market);
    prices[market] = observation.snapshot;
    return observation;
  }

  async readMarkets(): Promise<MarketsSnapshot> {
    const now = Date.now();
    if (this.marketReadCache && now - this.marketReadCache.at < MARKET_READ_CACHE_MS)
      return this.marketReadCache.promise;
    const promise = this.loadMarkets(now);
    this.marketReadCache = { at: now, promise };
    try {
      return await promise;
    } catch (error) {
      this.marketReadCache = undefined;
      throw error;
    }
  }

  private async loadMarkets(now: number): Promise<MarketsSnapshot> {
    const { ctx } = this,
      { prices, settled, provider, clearing, options } = ctx;
    const registered = marketRegistry.all();
    // A market whose price is unavailable (e.g. one the oracle does not price yet) is left out of the
    // snapshot; the snapshot fails only when no market has a price.
    const unpriced = new Set<Market>();
    if (options.oracleSource) {
      const observations = await Promise.allSettled(
        registered.map(({ symbol }) => options.oracleSource!.latest(symbol)),
      );
      for (const [index, observation] of observations.entries())
        if (observation.status === "fulfilled")
          prices[observation.value.snapshot.market] = observation.value.snapshot;
        else unpriced.add(registered[index].symbol);
      if (unpriced.size === registered.length) {
        const failure = observations.find((item) => item.status === "rejected");
        throw failure?.reason ?? new Error("market data unavailable");
      }
    } else for (const { symbol } of registered) if (!prices[symbol]) unpriced.add(symbol);
    const operationalRead = this.hedgeRisk();
    const state = provider && clearing ? await this.marketState(now) : undefined,
      blockNumber = state?.blockNumber ?? 0,
      block = state?.block ?? null,
      chainMarkets: Array<ChainMarketState | null> = state?.chainMarkets ?? registered.map(() => null),
      limitWords: Array<unknown> = state?.limitWords ?? registered.map(() => null);
    const operational = await operationalRead,
      marginScales = state?.marginScales ?? (await this.chain.marginScales());
    const markets = {} as Record<Market, MarketView>;
    for (const { index, symbol: name } of registered) {
      const snapshot = prices[name];
      if (!snapshot || unpriced.has(name)) continue;
      const chain = chainMarkets[index],
        limits =
          limitWords[index] === null
            ? { maxTradeNotional: DEFAULT_TRADE_LIMIT, maxMarketNotional: DEFAULT_MARKET_LIMIT }
            : decodeLimits(limitWords[index]),
        mid = midOf(snapshot),
        aggregateBase = chain ? BigInt(chain.aggregateBase) : 0n;
      const inventoryMark =
        chain && BigInt(chain.lastBid) + BigInt(chain.lastAsk) > 0n
          ? (BigInt(chain.lastBid) + BigInt(chain.lastAsk)) / 2n
          : mid;
      settled[name] = (aggregateBase * inventoryMark) / BASE;
      // Funding accrues at the skew's share of the market limit, clamped to +/-100% APR.
      let fundingApr = (((aggregateBase * mid) / BASE) * RATE) / limits.maxMarketNotional;
      if (fundingApr > RATE) fundingApr = RATE;
      if (fundingApr < -RATE) fundingApr = -RATE;
      const storedIndex = chain ? BigInt(chain.fundingIndex) : 0n,
        fundingTime = chain ? Number(chain.fundingTime) : unixSeconds(now),
        elapsed = BigInt(Math.max(0, (block?.timestamp ?? unixSeconds(now)) - fundingTime)),
        projectedFundingIndex = storedIndex + (mid * fundingApr * elapsed) / (RATE * YEAR_SECONDS);
      const venue = operational?.markets[name],
        mode = hedgeModeOf(operational, name),
        admission = hedgeAdmission(mode, settled[name] ?? 0n, 0n, limits.maxTradeNotional),
        spread = quoteSpread(snapshot, mode, ctx.flowRisk.score(name, snapshot, now), venue?.execution);
      markets[name] = {
        market: name,
        index,
        bid: snapshot.bid.toString(),
        ask: snapshot.ask.toString(),
        mid: mid.toString(),
        observedAtMs: snapshot.observedAtMs,
        source: snapshot.source ?? "configured",
        volatilityBps: snapshot.volatilityBps ?? 0,
        volatility: snapshot.volatility,
        baseSpreadBps: Number(spread.totalBps) / Number(SPREAD_UNITS_PER_BPS),
        feeBps: Number(tradingFeeBps(name)),
        aggregateBase: aggregateBase.toString(),
        fundingApr: fundingApr.toString(),
        fundingIndex: storedIndex.toString(),
        projectedFundingIndex: projectedFundingIndex.toString(),
        fundingTime,
        lastPriceTime: chain ? Number(chain.lastPriceTime) : 0,
        enabled: chain ? Boolean(chain.enabled) : true,
        maxTradeNotional: limits.maxTradeNotional.toString(),
        maxMarketNotional: limits.maxMarketNotional.toString(),
        riskMode: mode,
        spread: Object.fromEntries(
          Object.entries(spread).map(([key, value]) => [
            key,
            typeof value === "bigint" ? value.toString() : value,
          ]),
        ),
        operatingMaxTradeNotional: admission.maxTradeNotional.toString(),
        canBuy: admission.canBuy,
        canSell: admission.canSell,
        ...marketMarginView(marginScales[name] ?? marketRegistry.get(name).marginScaleBps),
      };
    }
    ctx.prune(now);
    return {
      blockNumber,
      serverTimeMs: now,
      markets,
      pricing: {
        settled: marketRegistry.record((market) => (settled[market] ?? 0n).toString()),
        pending: ctx.pending.envelope(),
        baseSpreadBps: Number(launchPricing.baseSpreadBps),
        feeBps: Number(launchPricing.feeBps),
        toleranceBps: Number(launchPricing.toleranceBps),
      },
    };
  }

  /**
   * Read the block-pinned quote snapshot. When another market carries live or reserved gross risk
   * and its on-chain price is stale, refresh it on chain first so cross-margin checks stay valid.
   *
   * A market the settlement report already prices (`covered`) is skipped: the trade's own report
   * refreshes it in the same transaction. A failed refresh is logged, not thrown: a reduction is
   * allowed against another market's stale price, and anything else fails its simulation with a
   * retriable error instead of failing the quote.
   */
  private async readFreshQuoteSnapshot(
    market: Market | null,
    options: { maxAgeSeconds?: number; covered?: Promise<OracleQuote | undefined> } = {},
  ) {
    const { ctx } = this,
      selected = market === null ? -1 : marketIndex(market),
      maxAge = options.maxAgeSeconds ?? CROSS_MARKET_PRICE_MAX_AGE_SECONDS;
    let snapshot = await this.chain.readQuoteSnapshot();
    if (!snapshot.block || snapshot.paused || snapshot.resolutionRequired)
      throw new Error("market is paused");
    const reserved = ctx.grossReservations.bounds(undefined, snapshot.markets.length),
      // The RPC's latest block can trail real time by a block or two; the transaction that relies on
      // this price lands later still, so age is measured from whichever clock is ahead.
      now = Math.max(snapshot.block.timestamp, unixSeconds());
    const stale: number[] = [];
    for (const [otherIndex, otherState] of snapshot.markets.entries()) {
      const otherBook = snapshot.books[otherIndex] as { longBase: bigint; shortBase: bigint } | undefined;
      if (otherIndex === selected || !otherBook) continue;
      const gross =
        BigInt(otherBook.longBase) +
        BigInt(otherBook.shortBase) +
        reserved[otherIndex].longBase +
        reserved[otherIndex].shortBase;
      if (ctx.sender && gross !== 0n && now - Number(otherState.lastPriceTime) > maxAge)
        stale.push(otherIndex);
    }
    if (stale.length && options.covered) {
      const covering = await options.covered.catch(() => undefined);
      const priced = new Set(covering?.markets ?? []);
      for (let i = stale.length - 1; i >= 0; i--) if (priced.has(stale[i])) stale.splice(i, 1);
    }
    if (stale.length) {
      try {
        await this.refreshOnChainPrices(stale, snapshot.block.timestamp, snapshot.blockNumber);
      } catch (error) {
        console.warn("on-chain price refresh failed:", error instanceof Error ? error.message : error);
      }
      this.chain.invalidateQuoteSnapshot();
      snapshot = await this.chain.readQuoteSnapshot();
      if (!snapshot.block || snapshot.paused || snapshot.resolutionRequired)
        throw new Error("market is paused");
    }
    return snapshot as typeof snapshot & { block: NonNullable<typeof snapshot.block> };
  }

  /**
   * Refresh the on-chain price of every market with open interest whose price is not recent, so an
   * account with positions passes the contract's freshness check outside a trade (withdrawals,
   * isolated margin moves). Those actions carry no oracle report of their own and must land within
   * MAX_ORACLE_AGE (15 s) of the stored price, so this refreshes well before that runs out.
   */
  async refreshOpenMarketPrices(maxAgeSeconds = SIGNED_ACTION_PRICE_MAX_AGE_SECONDS) {
    if (this.ctx.devFund) await this.dev.advanceTime();
    await this.readFreshQuoteSnapshot(null, { maxAgeSeconds });
  }

  /**
   * Push fresh prices for `markets` on chain (`refreshOracle`), sponsored by the leader. A report that
   * prices several of them refreshes them all in one transaction. Concurrent callers share one push.
   */
  private refreshOnChainPrices(markets: number[], blockTimestamp: number, blockNumber: number) {
    const key = [...markets].sort((a, b) => a - b).join(",");
    const active = this.refreshing.get(key);
    if (active) return active;
    const run = (async () => {
      const pending = new Set(markets);
      for (const otherIndex of markets) {
        if (!pending.has(otherIndex)) continue;
        const priced = await this.refreshOnChainPrice(
          marketRegistry.symbol(otherIndex),
          blockTimestamp,
          blockNumber,
        );
        for (const index of priced) pending.delete(index);
        pending.delete(otherIndex);
      }
    })().finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, run);
    return run;
  }

  /** Push a fresh price for `otherMarket` on chain; returns the market indexes the pushed report priced. */
  private async refreshOnChainPrice(
    otherMarket: Market,
    blockTimestamp: number,
    blockNumber: number,
  ): Promise<readonly number[]> {
    const { ctx } = this,
      clearing = ctx.clearing!,
      sender = ctx.sender!,
      otherIndex = marketIndex(otherMarket),
      blockTag = { blockTag: blockNumber };
    let report: string,
      priced: readonly number[] = [otherIndex],
      value = 0n;
    if (ctx.devFund) {
      const price = ctx.prices[otherMarket];
      if (!price) throw new Error(`no price for ${otherMarket}`);
      report = encodeLocalReport(
        otherIndex,
        price.bid,
        price.ask,
        blockTimestamp,
        blockTimestamp + LOCAL_REPORT_TTL_SECONDS,
      );
    } else {
      const observation = await this.settlementOracle(otherMarket);
      ctx.prices[otherMarket] = observation.snapshot;
      report = observation.report;
      priced = observation.markets ?? priced;
      const adapter = await this.chain.oracleAdapter(blockNumber);
      value = BigInt(await adapter.updateFee(report, blockTag));
    }
    await sender.submit(`oracle:${otherMarket}:${keccak256(report)}`, {
      to: ctx.domain.verifyingContract,
      data: clearing.interface.encodeFunctionData("refreshOracle", [report]),
      value,
      gasLimit: 750_000n,
    });
    return priced;
  }

  async createQuote(request: QuoteRequest, options: QuoteOptions = {}): Promise<CreatedQuote> {
    const { ctx } = this,
      { prices, settled, clearing, provider } = ctx,
      { persist = true, exactBaseDelta, reductionAccount, excludeReservation } = options;
    ctx.prune();
    const reservationRevision = ctx.pending.revision;
    if (persist && ctx.quotes.size >= ctx.maxActiveQuotes) throw new Error("firm quote capacity reached");
    // The hedger snapshot is independent of the chain reads below, so fetch it alongside them.
    const operationalRead = this.hedgeRisk();
    let oracleQuote: OracleQuote | undefined,
      versions: ProtocolVersions,
      maxTradeNotional = DEFAULT_TRADE_LIMIT;
    if (clearing && provider) {
      if (ctx.devFund) await this.dev.advanceTime();
      // The signed price does not depend on the chain snapshot, so fetch both at once.
      const observing = this.refreshPrice(request.market);
      const [snapshot, observed] = await Promise.all([
        this.readFreshQuoteSnapshot(request.market, { covered: observing }),
        observing,
      ]);
      oracleQuote = observed;
      const quoteMid = midOf(this.priceOf(request.market)),
        selected = marketIndex(request.market);
      for (const [index, state] of snapshot.markets.entries())
        settled[marketRegistry.symbol(index)] = marketNotional(
          state,
          index === selected ? quoteMid : undefined,
        );
      versions = {
        leaderEpoch: BigInt(snapshot.leaderEpoch),
        signerSetVersion: BigInt(snapshot.signerSetVersion),
        policyVersion: BigInt(snapshot.policyVersion),
        blockNumber: snapshot.blockNumber,
        blockTimestamp: snapshot.block.timestamp,
      };
      maxTradeNotional = decodeLimits(snapshot.limitWords[marketIndex(request.market)]).maxTradeNotional;
      if (exactBaseDelta !== undefined && reductionAccount) {
        // Closing an existing position is always allowed up to its size, even above the trade limit.
        const position = await clearing.positionOf(reductionAccount, marketIndex(request.market), {
          blockTag: snapshot.blockNumber,
        });
        if (isPositionReduction(BigInt(position.size), exactBaseDelta)) {
          const reductionNotional = (abs(exactBaseDelta) * quoteMid) / BASE;
          if (reductionNotional > maxTradeNotional) maxTradeNotional = reductionNotional;
        }
      }
    } else {
      [versions, oracleQuote] = await Promise.all([
        this.chain.readProtocolVersions(),
        this.refreshPrice(request.market),
      ]);
    }
    const snapshot = this.priceOf(request.market),
      operational = await operationalRead,
      mode = hedgeModeOf(operational, request.market),
      delta =
        exactBaseDelta === undefined
          ? request.side === "buy"
            ? parseUsdc(request.amount)
            : -parseUsdc(request.amount)
          : (exactBaseDelta * midOf(snapshot)) / BASE,
      admission = hedgeAdmission(mode, settled[request.market] ?? 0n, delta, maxTradeNotional);
    if (!admission.allowed) throw new Error("hedging unavailable: only exposure-reducing trades are allowed");
    const toxicity = ctx.flowRisk.score(request.market, snapshot),
      execution = operational?.markets[request.market]?.execution,
      spread = quoteSpread(snapshot, mode, toxicity, execution),
      shadow = quoteSpread(snapshot, mode, toxicity, execution, 1.25);
    this.shadowTelemetry.observe(Number(spread.totalBps), Number(shadow.totalBps));
    const pricing: PricingParameters = {
      ...launchPricing,
      maxNotional: admission.maxTradeNotional,
      feeBps: tradingFeeBps(request.market),
      spread,
    };
    const quote = constructQuote(
      request,
      { ...snapshot },
      settled,
      ctx.pending.exposure(excludeReservation),
      Date.now(),
      crypto.randomUUID(),
      pricing,
      exactBaseDelta,
    );
    let oracleReport: OracleReport | undefined;
    if (oracleQuote) {
      // The local chain cannot verify external proofs, so dev mode re-signs the price as a local report.
      const localTimestamp = ctx.devFund ? versions.blockTimestamp : undefined;
      oracleReport =
        localTimestamp === undefined
          ? { report: oracleQuote.report, validUntil: oracleQuote.validUntil, markets: oracleQuote.markets }
          : {
              report: encodeLocalReport(
                marketIndex(request.market),
                quote.snapshot.bid,
                quote.snapshot.ask,
                localTimestamp,
                localTimestamp + LOCAL_REPORT_TTL_SECONDS,
              ),
              validUntil: localTimestamp + LOCAL_REPORT_TTL_SECONDS,
            };
      quote.expiresAtMs = Math.min(
        quote.expiresAtMs,
        oracleReport.validUntil * 1_000 - ORACLE_INCLUSION_MARGIN_MS,
      );
      if (quote.expiresAtMs <= Date.now()) throw new Error("oracle report lacks inclusion time");
      if (persist) ctx.quotes.reports.set(quote.quoteId, oracleReport);
    }
    if (persist) ctx.quotes.add(quote, versions);
    return { quote, versions, oracleReport, reservationRevision };
  }

  register(app: FastifyInstance, guards: HttpGuards) {
    const { ctx } = this;
    app.get("/v1/markets", async (_request, reply) => {
      try {
        return await this.readMarkets();
      } catch (error) {
        return reply.code(503).send({ error: publicError(error, "market data unavailable") });
      }
    });

    app.post("/v1/quote", async (request, reply) => {
      if (!guards.admitQuoteWork(request, reply)) return;
      const parsed = quoteRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid quote request" });
      if (parseUsdc(parsed.data.amount) < MIN_TRADE_NOTIONAL)
        return reply.code(409).send({ error: MIN_TRADE_ERROR });
      try {
        const created = await this.createQuote(parsed.data);
        return quoteToWire(created.quote);
      } catch (error) {
        const message = publicError(error, "quote rejected");
        // A size over the market's limit is the request's own problem: asking again will not help.
        const final = message === "amount exceeds market limit";
        return reply
          .code(!final && (ctx.options.oracleSource || ctx.options.hedgeRiskSource) ? 503 : 409)
          .send({ error: message });
      }
    });

    app.post("/v1/close/quote", async (request, reply) => {
      if (!guards.admitQuoteWork(request, reply)) return;
      const parsed = closeQuoteSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid close quote request" });
      if (!ctx.clearing) return reply.code(503).send({ error: "chain unavailable" });
      try {
        const account = getAddress(parsed.data.account),
          position = await ctx.clearing.positionOf(account, marketIndex(parsed.data.market)),
          size = BigInt(position.size);
        if (size === 0n) return reply.code(409).send({ error: "position is already closed" });
        const quote = await this.closeQuote(account, parsed.data.market, size, parsed.data.fraction);
        if (!quote) return reply.code(409).send({ error: "close fraction rounds to zero" });
        return quoteToWire(quote);
      } catch (error) {
        return reply.code(503).send({ error: publicError(error, "close quote rejected") });
      }
    });

    // One reduce-only close quote per open position. Each is prepared and signed separately (a
    // session key can sign them without a wallet prompt).
    app.post("/v1/close/all/quote", async (request, reply) => {
      if (!guards.admitQuoteWork(request, reply)) return;
      const parsed = closeAllQuoteSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid close-all quote request" });
      if (!ctx.clearing) return reply.code(503).send({ error: "chain unavailable" });
      try {
        const account = getAddress(parsed.data.account),
          blockTag = { blockTag: await this.chain.blockNumber() },
          markets = marketRegistry.symbols(),
          sizes = await Promise.all(
            markets.map(async (market) =>
              BigInt((await ctx.clearing!.positionOf(account, marketIndex(market), blockTag)).size),
            ),
          ),
          quotes = [],
          unavailable: { market: Market; error: string }[] = [];
        // One market that cannot be priced (its oracle is out, say) must not block closing the others: it is
        // listed as unavailable, and the client retries it on its own.
        for (const [index, market] of markets.entries()) {
          if (sizes[index] === 0n) continue;
          try {
            const quote = await this.closeQuote(account, market, sizes[index], parsed.data.fraction);
            if (quote) quotes.push(quoteToWire(quote));
          } catch (error) {
            unavailable.push({ market, error: publicError(error, "close quote rejected") });
          }
        }
        return { account, quotes, unavailable };
      } catch (error) {
        return reply.code(503).send({ error: publicError(error, "close quote rejected") });
      }
    });
  }

  /**
   * A firm reduce-only quote closing `fraction` bps of the position (rounded toward zero), or
   * undefined when that rounds to nothing. Reductions may exceed the per-trade limit.
   */
  private async closeQuote(account: string, market: Market, size: bigint, fraction = 10_000) {
    const closing = (size * BigInt(fraction)) / 10_000n;
    if (closing === 0n) return undefined;
    const { quote } = await this.createQuote(
      { market, side: size > 0n ? "sell" : "buy", amount: "1" },
      { exactBaseDelta: -closing, reductionAccount: account },
    );
    this.ctx.quotes.forcedReduceOnly.add(quote.quoteId);
    return quote;
  }
}
