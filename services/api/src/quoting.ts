import { getAddress, keccak256 } from "ethers";
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
  parseUsdc,
  quoteRequestSchema,
  RATE,
  type PriceSnapshot,
  type PricingParameters,
  type Quote,
  type QuoteRequest,
} from "../../../packages/shared/src/policy.js";
import { baseSpreadOf } from "../../../packages/shared/src/markets.js";
import { quoteToWire } from "../../../packages/shared/src/wire.js";
import { discountedFee } from "../../../packages/shared/src/fee-tiers.js";
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
  baseSpreadBps: number;
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
    feeBps: number;
    toleranceBps: number;
  };
};

export type QuoteOptions = {
  /** Store the quote so it can be prepared and approved; indicative quotes are not stored. */
  persist?: boolean;
  /** Quote an exact base quantity (close quotes and refreshed approvals) instead of a USDC amount. */
  exactBaseDelta?: bigint;
  /** Account whose position reduction may exceed the per-trade limit; its fee tier also applies. */
  reductionAccount?: string;
  /** Reservation to leave out of the pending envelope (the approval being refreshed). */
  excludeReservation?: string;
};

export type CreatedQuote = {
  quote: Quote;
  /** Share of the base fee waived for the account's volume tier, in bps. */
  feeDiscountBps: number;
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
  return adaptiveSpread({
    // The base component is the market's on-chain spread, set by governance or the risk operator.
    baseBps: marketRegistry.has(snapshot.market)
      ? baseSpreadOf(marketRegistry.get(snapshot.market))
      : undefined,
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

  constructor(
    private readonly ctx: ApiContext,
    private readonly chain: ChainReader,
    private readonly dev: DevChain,
  ) {}

  invalidateMarkets() {
    this.marketReadCache = undefined;
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
    const blockNumber = provider ? await this.chain.blockNumber() : 0;
    const block = provider ? await provider.getBlock(blockNumber) : null;
    const blockTag = { blockTag: blockNumber };
    const [chainMarkets, limitWords]: [Array<ChainMarketState | null>, Array<unknown>] = clearing
      ? await Promise.all([
          Promise.all(registered.map(({ index }) => clearing.markets(index, blockTag))),
          Promise.all(registered.map(({ index }) => clearing.marketLimitWord(index, blockTag))),
        ])
      : [registered.map(() => null), registered.map(() => null)];
    const operational = await this.hedgeRisk(),
      marginScales = await this.chain.marginScales(provider ? blockNumber : undefined);
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
        baseSpreadBps: Number(spread.totalBps),
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
   */
  private async readFreshQuoteSnapshot(market: Market | null) {
    const { ctx } = this,
      clearing = ctx.clearing!,
      selected = market === null ? -1 : marketIndex(market);
    let snapshot = await this.chain.readQuoteSnapshot();
    if (!snapshot.block || snapshot.paused || snapshot.resolutionRequired)
      throw new Error("market is paused");
    const blockTag = { blockTag: snapshot.blockNumber },
      reserved = ctx.grossReservations.bounds(undefined, snapshot.markets.length);
    const books = await Promise.all(
      snapshot.markets.map((_, index) =>
        index === selected ? null : clearing.exposureState(index, blockTag),
      ),
    );
    let refreshed = false;
    for (const [otherIndex, otherState] of snapshot.markets.entries()) {
      const otherBook = books[otherIndex];
      if (otherIndex === selected || !otherBook) continue;
      if (!otherBook.ready) throw new Error("exposure migration required");
      const gross =
        BigInt(otherBook.longBase) +
        BigInt(otherBook.shortBase) +
        reserved[otherIndex].longBase +
        reserved[otherIndex].shortBase;
      if (
        ctx.sender &&
        gross !== 0n &&
        snapshot.block.timestamp - Number(otherState.lastPriceTime) > CROSS_MARKET_PRICE_MAX_AGE_SECONDS
      ) {
        await this.refreshOnChainPrice(
          marketRegistry.symbol(otherIndex),
          snapshot.block.timestamp,
          snapshot.blockNumber,
        );
        refreshed = true;
      }
    }
    if (refreshed) {
      this.chain.invalidateQuoteSnapshot();
      snapshot = await this.chain.readQuoteSnapshot();
      if (!snapshot.block || snapshot.paused || snapshot.resolutionRequired)
        throw new Error("market is paused");
    }
    return snapshot as typeof snapshot & { block: NonNullable<typeof snapshot.block> };
  }

  /**
   * Refresh the on-chain price of every market with open interest whose price is stale, so an
   * account with positions passes the contract's freshness check outside a trade (withdrawals).
   */
  async refreshOpenMarketPrices() {
    if (this.ctx.devFund) await this.dev.advanceTime();
    await this.readFreshQuoteSnapshot(null);
  }

  /** Push a fresh price for `otherMarket` on chain (`refreshOracle`), sponsored by the leader. */
  private async refreshOnChainPrice(otherMarket: Market, blockTimestamp: number, blockNumber: number) {
    const { ctx } = this,
      clearing = ctx.clearing!,
      sender = ctx.sender!,
      otherIndex = marketIndex(otherMarket),
      blockTag = { blockTag: blockNumber };
    {
      let report: string,
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
        const adapter = await this.chain.oracleAdapter(blockNumber);
        value = BigInt(await adapter.updateFee(report, blockTag));
      }
      await sender.submit(`oracle:${otherMarket}:${keccak256(report)}`, {
        to: ctx.domain.verifyingContract,
        data: clearing.interface.encodeFunctionData("refreshOracle", [report]),
        value,
        gasLimit: 750_000n,
      });
    }
  }

  async createQuote(request: QuoteRequest, options: QuoteOptions = {}): Promise<CreatedQuote> {
    const { ctx } = this,
      { prices, settled, clearing, provider } = ctx,
      { persist = true, exactBaseDelta, reductionAccount, excludeReservation } = options;
    ctx.prune();
    const reservationRevision = ctx.pending.revision;
    if (persist && ctx.quotes.size >= ctx.maxActiveQuotes) throw new Error("firm quote capacity reached");
    let oracleQuote: OracleQuote | undefined,
      versions: ProtocolVersions,
      maxTradeNotional = DEFAULT_TRADE_LIMIT;
    if (clearing && provider) {
      if (ctx.devFund) await this.dev.advanceTime();
      const snapshot = await this.readFreshQuoteSnapshot(request.market);
      oracleQuote = await this.refreshPrice(request.market);
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
      versions = await this.chain.readProtocolVersions();
      oracleQuote = await this.refreshPrice(request.market);
    }
    const snapshot = this.priceOf(request.market),
      operational = await this.hedgeRisk(),
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
      baseSpreadBps: spread.totalBps,
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
    const feeAccount = reductionAccount ?? request.account,
      feeDiscountBps =
        feeAccount && ctx.options.feeTierSource
          ? await ctx.options.feeTierSource.discountBps(feeAccount).catch(() => 0)
          : 0;
    quote.fee = discountedFee(quote.fee, feeDiscountBps);
    let oracleReport: OracleReport | undefined;
    if (oracleQuote) {
      // The local chain cannot verify external proofs, so dev mode re-signs the price as a local report.
      const localTimestamp = ctx.devFund ? versions.blockTimestamp : undefined;
      oracleReport =
        localTimestamp === undefined
          ? { report: oracleQuote.report, validUntil: oracleQuote.validUntil }
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
    return { quote, versions, oracleReport, reservationRevision, feeDiscountBps };
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
      try {
        const created = await this.createQuote(parsed.data);
        return { ...quoteToWire(created.quote), feeDiscountBps: created.feeDiscountBps };
      } catch (error) {
        return reply
          .code(ctx.options.oracleSource || ctx.options.hedgeRiskSource ? 503 : 409)
          .send({ error: publicError(error, "quote rejected") });
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
          quotes = [];
        for (const [index, market] of markets.entries()) {
          if (sizes[index] === 0n) continue;
          const quote = await this.closeQuote(account, market, sizes[index], parsed.data.fraction);
          if (quote) quotes.push(quoteToWire(quote));
        }
        return { account, quotes };
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
