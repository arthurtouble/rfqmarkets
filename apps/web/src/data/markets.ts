// The live market registry and per-market leverage for the UI. Governance can
// add markets at any time; the API refreshes its registry from chain about
// once a minute, so /v1/config is re-read on the same cadence.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { API } from "../lib/env.js";
import { getJson } from "../lib/http.js";
import { leveragePresets } from "../lib/leverage.js";
import { marketInfos, symbolsByIndex, type MarketInfo } from "../lib/markets.js";
import { marketFromIndex, type ChainConfig, type Market, type MarketSnapshot } from "../lib/types.js";
import { allMarketsMask } from "../wallet/quick-session.js";
import { useTrader } from "../wallet/trader.js";
import { useMarketFeed } from "./market-feed.js";

export const marketKeys = {
  config: ["config"] as const,
  snapshot: ["markets", "snapshot"] as const,
};

const CONFIG_REFRESH_MS = 60_000;

/** GET /v1/config, seeded with the copy main.tsx loaded at boot. */
export function useApiConfig() {
  const { settlement } = useTrader();
  return useQuery({
    queryKey: marketKeys.config,
    queryFn: ({ signal }) => getJson<ChainConfig>(`${API}/v1/config`, signal),
    initialData: settlement ?? undefined,
    staleTime: CONFIG_REFRESH_MS,
    refetchInterval: CONFIG_REFRESH_MS,
  });
}

export type MarketList = {
  /** Every registered market in contract index order, with margin and leverage. */
  markets: MarketInfo[];
  symbols: Market[];
  get(symbol: Market): MarketInfo | undefined;
  /** Symbol at a contract index (activity rows carry the index). */
  marketFromIndex(index: number | null | undefined): Market | null;
  /** Session `marketMask` covering every market (number, or decimal string past 53 markets). */
  allMarketsMask: number | string;
  isLoading: boolean;
};

/**
 * The live market list. Works anywhere under TraderProvider; under
 * MarketFeedProvider it also reflects each stream tick (enabled flags, margin
 * scale). Without either source it reads GET /v1/markets once.
 */
export function useMarketList(): MarketList {
  const config = useApiConfig();
  const { snapshot } = useMarketFeed();
  const fallback = useQuery({
    queryKey: marketKeys.snapshot,
    queryFn: ({ signal }) => getJson<MarketSnapshot>(`${API}/v1/markets`, signal),
    enabled: !snapshot && !config.data?.marketList?.length,
    staleTime: CONFIG_REFRESH_MS,
  });
  const source = snapshot ?? fallback.data ?? null;
  return useMemo(() => {
    const markets = marketInfos(config.data, source);
    const bySymbol = new Map(markets.map(market => [market.symbol, market]));
    const indexed = symbolsByIndex(markets);
    return {
      markets,
      symbols: markets.map(market => market.symbol),
      get: symbol => bySymbol.get(symbol),
      marketFromIndex: index => marketFromIndex(index, indexed),
      allMarketsMask: allMarketsMask(Math.max(1, indexed.length)),
      isLoading: !config.data && !source,
    };
  }, [config.data, source]);
}

/** One market's margin and leverage presets, e.g. `[2, 5, 10, 20]` for a 20x market. */
export function useMarketLeverage(market: Market, steps?: readonly number[]) {
  const info = useMarketList().get(market);
  return useMemo(() => info && {
    maxLeverage: info.maxLeverage, initialMarginBps: info.initialMarginBps,
    maintenanceMarginBps: info.maintenanceMarginBps, marginScaleBps: info.marginScaleBps,
    presets: leveragePresets(info.maxLeverage, steps),
  }, [info, steps]);
}
