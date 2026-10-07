// Rolling 24h stats for every market (GET /v1/markets/stats on the market
// gateway). One request covers the whole list; the gateway recomputes it at
// most every five seconds, so a 30 second refresh is plenty.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { MARKET_STREAM } from "../lib/env.js";
import { getJson } from "../lib/http.js";
import type { MarketStatsResponse } from "../lib/market-stats.js";

export const statsKeys = { all: ["markets", "stats"] as const };

const STATS_REFRESH_MS = 30_000;

export function useMarketStats() {
  return useQuery({
    queryKey: statsKeys.all,
    queryFn: ({ signal }) => getJson<MarketStatsResponse>(`${MARKET_STREAM}/v1/markets/stats`, signal),
    staleTime: STATS_REFRESH_MS,
    refetchInterval: STATS_REFRESH_MS,
    placeholderData: keepPreviousData,
  });
}
