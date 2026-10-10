import { BaseContract, decodeBytes32String, encodeBytes32String } from "ethers";
import { readViews, type ViewCall } from "./rpc.js";

/**
 * The market registry. Markets live on chain (`RFQClearing.addMarket`, up to 128); a market is
 * addressed by its symbol (e.g. "BTC") off chain and by its index (0 .. marketCount - 1) on chain.
 *
 * Every process keeps one registry (`marketRegistry`). It starts with the two launch markets so tests
 * and chain-less previews behave as before, and services replace it from chain at boot
 * (`syncMarketRegistry`) and refresh it periodically (`watchMarketRegistry`).
 */
export type Market = string;
export type MarketIndex = number;
/** `RFQTypes.MAX_MARKETS`. */
export const MAX_MARKETS = 128;

export interface MarketDefinition {
  index: MarketIndex;
  symbol: Market;
  /** `marketParams(i).impactK`. */
  impactK: bigint;
  /** `marketParams(i).shockBps`. */
  shockBps: bigint;
  /** `marketParams(i).marginScaleBps`. */
  marginScaleBps: number;
  /** `markets(i).enabled`: a disabled market accepts only position reductions. */
  enabled: boolean;
  /**
   * Base quote spread in bps: `marketSpread(i)`, else `defaultSpread()`, else `DEFAULT_BASE_SPREAD_BPS`.
   * Absent on contracts deployed before the risk operator (v1.2) and in fixtures.
   */
  baseSpreadBps?: number;
}

/** Base spread the services quote with when the chain sets none (`launchPricing.baseSpreadBps`). */
export const DEFAULT_BASE_SPREAD_BPS = 2;
/** `RFQTypes.MIN_BASE_SPREAD_BPS` and `MAX_BASE_SPREAD_BPS`. */
export const MIN_BASE_SPREAD_BPS = 2;
export const MAX_BASE_SPREAD_BPS = 50;

/** The base spread a market quotes with. */
export const baseSpreadOf = (market: Pick<MarketDefinition, "baseSpreadBps">) =>
  market.baseSpreadBps || DEFAULT_BASE_SPREAD_BPS;

/** The launch markets, as `deploy-local` and the production deploy register them. */
export const LAUNCH_MARKETS: readonly MarketDefinition[] = Object.freeze([
  { index: 0, symbol: "BTC", impactK: 10_000n, shockBps: 4_000n, marginScaleBps: 10_000, enabled: true },
  { index: 1, symbol: "ETH", impactK: 12_000n, shockBps: 5_000n, marginScaleBps: 10_000, enabled: true },
]);

const SYMBOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/;

/** True when `symbol` is a well-formed market symbol (letters, digits, `.`, `_` or `-`; at most 31 bytes, e.g. `kPEPE`). */
export const isMarketSymbol = (symbol: unknown): symbol is Market =>
  typeof symbol === "string" && SYMBOL_PATTERN.test(symbol);

export const encodeMarketSymbol = (symbol: Market) => encodeBytes32String(symbol);
export const decodeMarketSymbol = (value: string) => decodeBytes32String(value);

type Listener = (markets: readonly MarketDefinition[]) => void;

export class MarketRegistry {
  private list: MarketDefinition[] = [];
  private bySymbol = new Map<Market, MarketDefinition>();
  private listeners = new Set<Listener>();
  private refresher?: () => Promise<unknown>;
  private lastRequestedRefreshMs = 0;
  /** Wall time of the last successful chain load; 0 while it holds only the built-in defaults. */
  loadedAtMs = 0;

  constructor(initial: readonly MarketDefinition[] = LAUNCH_MARKETS) {
    this.replace(initial);
  }

  get count() {
    return this.list.length;
  }
  /** Bit mask of every registered market (`(1 << count) - 1`). */
  get mask() {
    return (1n << BigInt(this.count)) - 1n;
  }
  all(): readonly MarketDefinition[] {
    return this.list;
  }
  symbols(): Market[] {
    return this.list.map((market) => market.symbol);
  }
  has(symbol: unknown): symbol is Market {
    return typeof symbol === "string" && this.bySymbol.has(symbol);
  }
  hasIndex(index: number | bigint) {
    const value = Number(index);
    return Number.isInteger(value) && value >= 0 && value < this.list.length;
  }
  get(symbol: Market): MarketDefinition {
    const market = this.bySymbol.get(symbol);
    if (!market) throw new Error(`unknown market ${symbol}`);
    return market;
  }
  at(index: number | bigint): MarketDefinition {
    if (!this.hasIndex(index)) throw new Error(`unknown market index ${index}`);
    return this.list[Number(index)];
  }
  index(symbol: Market): MarketIndex {
    return this.get(symbol).index;
  }
  symbol(index: number | bigint): Market {
    return this.at(index).symbol;
  }
  /** A `{ [symbol]: value }` record over every registered market. */
  record<T>(value: (market: Market, index: MarketIndex) => T): Record<Market, T> {
    return Object.fromEntries(this.list.map((market) => [market.symbol, value(market.symbol, market.index)]));
  }

  /**
   * Replace the market list. Indexes must be 0 .. n-1 in order and symbols unique. Markets are never
   * removed on chain, so a shorter list than the current one is accepted only for tests (`force`).
   */
  replace(markets: readonly MarketDefinition[], { force = true } = {}) {
    if (markets.length > MAX_MARKETS) throw new Error("too many markets");
    const seen = new Set<Market>();
    markets.forEach((market, index) => {
      if (market.index !== index)
        throw new Error(`market ${market.symbol} has index ${market.index}, expected ${index}`);
      if (!isMarketSymbol(market.symbol))
        throw new Error(`invalid market symbol ${JSON.stringify(market.symbol)}`);
      if (seen.has(market.symbol)) throw new Error(`duplicate market ${market.symbol}`);
      seen.add(market.symbol);
    });
    if (!force) {
      if (markets.length < this.list.length) throw new Error("market registry cannot shrink");
      for (const [index, market] of this.list.entries())
        if (markets[index].symbol !== market.symbol) throw new Error(`market ${index} changed symbol`);
    }
    const changed =
      markets.length !== this.list.length ||
      markets.some((market, index) => !sameMarket(market, this.list[index]));
    this.list = markets.map((market) => Object.freeze({ ...market }));
    this.bySymbol = new Map(this.list.map((market) => [market.symbol, market]));
    if (changed) for (const listener of this.listeners) listener(this.list);
    return changed;
  }

  /** Called after every change to the market list (a new market or new risk parameters). */
  onChange(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Installed by `watchMarketRegistry`; `requestRefresh` uses it. */
  setRefresher(refresher: (() => Promise<unknown>) | undefined) {
    this.refresher = refresher;
  }

  /**
   * Ask for an early refresh, e.g. when a request names a symbol the registry does not know yet (a
   * market governance just added). Rate limited; never throws.
   */
  requestRefresh(minIntervalMs = 5_000, now = Date.now()) {
    if (!this.refresher || now - this.lastRequestedRefreshMs < minIntervalMs) return;
    this.lastRequestedRefreshMs = now;
    this.refresher().catch(() => {});
  }

  /**
   * Make sure the registry covers `chainCount` markets (a block-pinned `marketCount()` read) before
   * risk is computed over every market. Refreshes once if it lags; throws (fail closed) if it still
   * does, so no check silently leaves out a market that has exposure.
   */
  async ensureCount(chainCount: number | bigint) {
    const count = Number(chainCount);
    if (count <= this.list.length) return;
    if (this.refresher) await this.refresher().catch(() => {});
    if (count > this.list.length) throw new Error("market registry is behind the chain");
  }

  /** Reset to the launch markets (tests). */
  reset(markets: readonly MarketDefinition[] = LAUNCH_MARKETS) {
    this.replace(markets);
    this.loadedAtMs = 0;
  }
}

function sameMarket(left: MarketDefinition, right: MarketDefinition | undefined) {
  return (
    right !== undefined &&
    left.symbol === right.symbol &&
    left.impactK === right.impactK &&
    left.shockBps === right.shockBps &&
    left.marginScaleBps === right.marginScaleBps &&
    left.enabled === right.enabled &&
    left.baseSpreadBps === right.baseSpreadBps
  );
}

/** The process-wide registry every service reads. */
export const marketRegistry = new MarketRegistry();

export const marketIndex = (market: Market): MarketIndex => marketRegistry.index(market);
export const marketName = (index: number | bigint): Market => marketRegistry.symbol(index);
export const marketSymbols = (): Market[] => marketRegistry.symbols();
export const isKnownMarket = (market: unknown): market is Market => {
  if (marketRegistry.has(market)) return true;
  // A symbol we do not know may be a market governance just added: refresh early.
  if (isMarketSymbol(market)) marketRegistry.requestRefresh();
  return false;
};

/** The clearing reads the registry needs (`clearingStateAbi` has them). */
export interface MarketRegistryReader {
  marketCount(overrides?: object): Promise<unknown>;
  marketParams(
    index: number,
    overrides?: object,
  ): Promise<{ symbol: string; impactK: unknown; shockBps: unknown; marginScaleBps: unknown }>;
  markets(index: number, overrides?: object): Promise<{ enabled: unknown }>;
  /** v1.2 spread views; readers without them (older contracts, fixtures) quote the default spread. */
  defaultSpread?(overrides?: object): Promise<unknown>;
  marketSpread?(index: number, overrides?: object): Promise<unknown>;
}

/** Ethers errors for a view the contract does not have (empty return data) or rejects. */
const isMissingView = (error: unknown) => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "BAD_DATA" || code === "CALL_EXCEPTION";
};

/**
 * Read `defaultSpread()`. Undefined when the contract predates it; any other failure (a network error)
 * propagates so a sync never silently drops an operator-set spread to the narrower default.
 */
async function readDefaultSpread(clearing: MarketRegistryReader, overrides: object) {
  if (typeof clearing.defaultSpread !== "function" || typeof clearing.marketSpread !== "function") return;
  try {
    return Number(await clearing.defaultSpread(overrides));
  } catch (error) {
    if (isMissingView(error)) return;
    throw error;
  }
}

/** Read every registered market from the clearing contract. */
export async function readMarketsFromChain(
  reader: MarketRegistryReader | BaseContract,
  blockTag?: number | string,
): Promise<MarketDefinition[]> {
  // An ethers contract built with `clearingStateAbi` has these views.
  const clearing = reader as MarketRegistryReader;
  const overrides = blockTag === undefined ? {} : { blockTag };
  const count = Number(await clearing.marketCount(overrides));
  if (!Number.isInteger(count) || count < 0 || count > MAX_MARKETS) throw new Error("invalid market count");
  const defaultSpread = await readDefaultSpread(clearing, overrides);
  if (reader instanceof BaseContract && reader.runner?.provider) {
    // One aggregated eth_call for every market instead of three per market.
    const withSpread = defaultSpread !== undefined,
      perMarket = withSpread ? 3 : 2,
      values = await readViews(
        reader,
        Array.from({ length: count }, (_, index): ViewCall[] => [
          ["marketParams", index],
          ["markets", index],
          ...(withSpread ? [["marketSpread", index] as ViewCall] : []),
        ]).flat(),
        blockTag,
      );
    return Array.from({ length: count }, (_, index) => {
      const [params, state, ownSpread] = values.slice(index * perMarket, (index + 1) * perMarket) as [
        Awaited<ReturnType<MarketRegistryReader["marketParams"]>>,
        { enabled: unknown },
        unknown,
      ];
      return marketDefinition(index, params, state, ownSpread, defaultSpread);
    });
  }
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const [params, state, ownSpread] = await Promise.all([
        clearing.marketParams(index, overrides),
        clearing.markets(index, overrides),
        defaultSpread === undefined ? undefined : clearing.marketSpread!(index, overrides),
      ]);
      return marketDefinition(index, params, state, ownSpread, defaultSpread);
    }),
  );
}

function marketDefinition(
  index: number,
  params: Awaited<ReturnType<MarketRegistryReader["marketParams"]>>,
  state: { enabled: unknown },
  ownSpread: unknown,
  defaultSpread: number | undefined,
): MarketDefinition {
  const spread = Number(ownSpread ?? 0) || defaultSpread || 0;
  return {
    index,
    symbol: decodeMarketSymbol(params.symbol),
    impactK: BigInt(params.impactK as bigint),
    shockBps: BigInt(params.shockBps as bigint),
    marginScaleBps: Number(params.marginScaleBps),
    enabled: Boolean(state.enabled),
    ...(spread ? { baseSpreadBps: spread } : {}),
  };
}

/** Load the registry from chain once. Markets are append-only, so a shrinking read is rejected. */
export async function syncMarketRegistry(
  clearing: MarketRegistryReader | BaseContract,
  registry: MarketRegistry = marketRegistry,
) {
  const markets = await readMarketsFromChain(clearing);
  const changed = registry.replace(markets, { force: registry.loadedAtMs === 0 });
  registry.loadedAtMs = Date.now();
  return { markets, changed };
}

export const DEFAULT_MARKET_REFRESH_MS = 60_000;
const INITIAL_LOAD_WAIT_MS = 5_000;

export interface MarketRegistryWatch {
  /** Re-read the registry now (coalesced with a refresh already running). */
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * Load the registry from chain, then refresh it every `intervalMs` (60 s by default; set
 * `RFQ_MARKET_REFRESH_MS` to change it in services) and whenever a caller asks for an early refresh.
 * The first load must succeed; later failures keep the last good list and are reported to `onError`.
 */
export async function watchMarketRegistry(
  clearing: MarketRegistryReader | BaseContract,
  options: {
    registry?: MarketRegistry;
    intervalMs?: number;
    onChange?: (markets: readonly MarketDefinition[]) => void;
    onError?: (error: unknown) => void;
    /**
     * Throw when the first load fails (default). With false the registry keeps its current list and
     * retries on the interval; risk checks over every market then fail closed (`ensureCount`) while
     * it lags the chain.
     */
    requireInitial?: boolean;
  } = {},
): Promise<MarketRegistryWatch> {
  const registry = options.registry ?? marketRegistry,
    intervalMs = options.intervalMs ?? DEFAULT_MARKET_REFRESH_MS;
  let running: Promise<void> | undefined;
  const refresh = () =>
    (running ??= (async () => {
      try {
        const { markets, changed } = await syncMarketRegistry(clearing, registry);
        if (changed) options.onChange?.(markets);
      } finally {
        running = undefined;
      }
    })());
  if (options.requireInitial === false)
    // Don't hold a service's start-up on a slow or throttled RPC: the load carries on in the background.
    await Promise.race([
      refresh().catch((error) => options.onError?.(error)),
      new Promise((done) => setTimeout(done, INITIAL_LOAD_WAIT_MS).unref?.()),
    ]);
  else await refresh();
  registry.setRefresher(refresh);
  const timer = setInterval(() => refresh().catch((error) => options.onError?.(error)), intervalMs);
  timer.unref?.();
  return {
    refresh,
    stop() {
      clearInterval(timer);
      registry.setRefresher(undefined);
    },
  };
}

/** Refresh interval for services, from `RFQ_MARKET_REFRESH_MS`. */
export function marketRefreshIntervalMs(env: Record<string, string | undefined> = process.env) {
  const value = Number(env.RFQ_MARKET_REFRESH_MS ?? DEFAULT_MARKET_REFRESH_MS);
  if (!Number.isInteger(value) || value < 1_000) throw new Error("RFQ_MARKET_REFRESH_MS must be >= 1000");
  return value;
}
