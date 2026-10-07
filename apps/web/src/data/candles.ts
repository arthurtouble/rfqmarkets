// Chart candles: GET /v1/candles on the market gateway, with the last bucket
// kept live from the shared market stream between refetches.
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CANDLE_INTERVALS, DEFAULT_CANDLE_LIMIT, MAX_CANDLE_LIMIT, mergeLiveCandle } from "../lib/candles.js";
import { MARKET_STREAM } from "../lib/env.js";
import { getJson } from "../lib/http.js";
import type { Candle, CandleInterval, CandleSeries, Market } from "../lib/types.js";
import { useMarketFeed } from "./market-feed.js";

export const candleKeys = {
  series: (market: Market, interval: CandleInterval, limit: number) => ["candles", market, interval, limit] as const,
};

/** Refetch cadence: the live merge covers the gap, so this only reconciles with the gateway. */
const refetchMs = (interval: CandleInterval) => Math.min(60_000, Math.max(15_000, CANDLE_INTERVALS[interval] / 4));

/** GET /v1/candles?market&interval&limit (limit 1..1000, default 300). */
export function useCandles(market: Market, interval: CandleInterval = "1m", limit = DEFAULT_CANDLE_LIMIT) {
  const bounded = Math.min(MAX_CANDLE_LIMIT, Math.max(1, Math.floor(limit)));
  return useQuery({
    queryKey: candleKeys.series(market, interval, bounded),
    queryFn: ({ signal }) => getJson<CandleSeries>(`${MARKET_STREAM}/v1/candles?market=${encodeURIComponent(market)}&interval=${interval}&limit=${bounded}`, signal),
    staleTime: refetchMs(interval),
    refetchInterval: refetchMs(interval),
    placeholderData: keepPreviousData,
  });
}

/**
 * Candles whose last bucket follows the live mid from the market stream (must
 * be under MarketFeedProvider). `candles` are ascending, prices USDC 1e6
 * strings; `lib/candles.ts` `candleToNumbers` converts for a chart library.
 */
export function useLiveCandles(market: Market, interval: CandleInterval = "1m", limit = DEFAULT_CANDLE_LIMIT) {
  const query = useCandles(market, interval, limit);
  const { snapshot } = useMarketFeed();
  const live = snapshot?.markets[market];
  const base = query.data?.market === market && query.data.interval === interval ? query.data.candles : null;
  // Each fetch resets the series; each stream tick folds into it, so highs and lows between fetches stick.
  const [candles, setCandles] = useState<Candle[]>([]);
  useEffect(() => setCandles(base ?? []), [base]);
  useEffect(() => {
    if (!live) return;
    setCandles(current => (current.length ? mergeLiveCandle(current, interval, live.observedAtMs, BigInt(live.mid), limit) : current));
  }, [live?.mid, live?.observedAtMs, interval, limit]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...query, candles };
}
