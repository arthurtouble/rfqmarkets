// A live tick line for one market: the last 15 minutes of 1m candles as a
// starting point, then every mid the market stream delivers.
import { useEffect, useState } from "react";
import { candlePath, type ChartPoint } from "../lib/candles.js";
import type { Market } from "../lib/types.js";
import { TICK_WINDOW_MS, appendTick } from "../lib/updown.js";
import { useCandles } from "./candles.js";
import { useMarketFeed } from "./market-feed.js";

const SEED_CANDLES = Math.ceil(TICK_WINDOW_MS / 60_000);
type Line = { market: Market; seeded: boolean; points: ChartPoint[] };

/** Points (dollars, oldest first) for the tick chart, and whether its history is still loading. */
export function useTicks(market: Market): { points: ChartPoint[]; loading: boolean; error: boolean } {
  const seed = useCandles(market, "1m", SEED_CANDLES);
  const { snapshot } = useMarketFeed();
  const live = snapshot?.markets[market];
  const [line, setLine] = useState<Line>({ market, seeded: false, points: [] });
  const candles = seed.data?.market === market ? seed.data.candles : null;
  // The candles seed the line once per market; ticks that arrived first stay after them. Refetches are ignored.
  useEffect(() => {
    setLine((current) => {
      const base = current.market === market ? current : { market, seeded: false, points: [] };
      if (base.seeded || !candles) return base;
      const firstTick = base.points[0]?.time ?? Infinity;
      const history = candlePath(candles, 60_000, Date.now()).filter((point) => point.time < firstTick);
      return { market, seeded: true, points: [...history, ...base.points] };
    });
  }, [market, candles]);
  useEffect(() => {
    if (!live) return;
    const tick = { time: live.observedAtMs, value: Number(live.mid) / 1e6 };
    setLine((current) =>
      current.market === market
        ? { ...current, points: appendTick(current.points, tick) }
        : { market, seeded: false, points: [tick] },
    );
  }, [market, live?.mid, live?.observedAtMs]); // eslint-disable-line react-hooks/exhaustive-deps
  const points = line.market === market ? line.points : [];
  return { points, loading: seed.isPending && points.length < 2, error: seed.isError && points.length < 2 };
}
