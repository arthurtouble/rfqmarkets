// Reads the market registry from the clearing contract (ethers). Kept apart from markets.ts so the
// registry itself stays free of ethers for the web app.
import { BaseContract, decodeBytes32String, encodeBytes32String } from "ethers";
import { readViews, type ViewCall } from "./rpc.js";
import {
  MAX_MARKETS,
  type MarketRegistry,
  marketRegistry,
  type Market,
  type MarketDefinition,
} from "./markets.js";

export const encodeMarketSymbol = (symbol: Market) => encodeBytes32String(symbol);
export const decodeMarketSymbol = (value: string) => decodeBytes32String(value);

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
