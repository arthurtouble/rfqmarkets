// Price header and chart for one market. Simple view: a price line over a
// chosen range (1H to 1M) that can be scrubbed. Advanced view: candlesticks at
// a chosen interval with the 24h high and low.
import { Suspense, lazy, useState } from "react";
import { useLiveCandles } from "../data/candles.js";
import { useMarketPrice } from "../data/market-feed.js";
import { useMarketStats } from "../data/market-stats.js";
import { CANDLE_INTERVALS, linePoints } from "../lib/candles.js";
import { usdc } from "../lib/format.js";
import { CANDLE_PICKER, CHART_RANGES, CHART_RANGE_IDS, DEFAULT_CANDLE_INTERVAL, DEFAULT_CHART_RANGE, chartTime, dayRange, type ChartRange } from "../lib/market-stats.js";
import type { CandleInterval, Market } from "../lib/types.js";
import { Segmented, marketName } from "../ui/primitives.js";
import { useAdvanced } from "../ui/prefs.js";
import { PriceHeader } from "./MarketHeader.js";
import { PriceChart } from "./PriceChart.js";
import type { ChartPoint } from "../lib/candles.js";

const CandleChart = lazy(() => import("./CandleChart.js"));

const RANGE_KEY = "rfq.chartRange", INTERVAL_KEY = "rfq.candleInterval";
function useStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => { try { const stored = localStorage.getItem(key) as T; return allowed.includes(stored) ? stored : fallback; } catch { return fallback; } });
  return [value, (next: T) => { try { localStorage.setItem(key, next); } catch { /* private mode */ } setValue(next); }] as const;
}

/** The price header and chart; `height` is the chart's own height. */
export function MarketChart({ market, height }: { market: Market; height: number }) {
  return useAdvanced() ? <CandleView market={market} height={height} /> : <LineView market={market} height={height} />;
}

function LineView({ market, height }: { market: Market; height: number }) {
  const [range, setRange] = useStoredChoice<ChartRange>(RANGE_KEY, CHART_RANGE_IDS, DEFAULT_CHART_RANGE);
  const [scrub, setScrub] = useState<ChartPoint | null>(null);
  const { interval, limit, label } = CHART_RANGES[range];
  const series = useLiveCandles(market, interval, limit);
  const spanMs = limit * CANDLE_INTERVALS[interval];
  const points = linePoints(series.candles, CANDLE_INTERVALS[interval], Date.now());
  return <div className="market-chart">
    <PriceHeader market={market} reference={series.candles[0]?.open} period={label}
      scrub={scrub && { value: scrub.value, label: chartTime(scrub.time, spanMs) }} />
    <PriceChart key={`${market}:${range}`} points={points} height={height} onScrub={setScrub}
      state={series.isError && !points.length ? "error" : series.isPending ? "loading" : "ready"} />
    <Segmented className="chart-ranges" label="Chart range" value={range} onChange={next => { setScrub(null); setRange(next); }}
      options={CHART_RANGE_IDS.map(id => ({ id, label: id }))} />
  </div>;
}

function CandleView({ market, height }: { market: Market; height: number }) {
  const [interval, setCandleInterval] = useStoredChoice<CandleInterval>(INTERVAL_KEY, CANDLE_PICKER, DEFAULT_CANDLE_INTERVAL);
  const series = useLiveCandles(market, interval);
  const stats = useMarketStats().data?.markets[market];
  const { live } = useMarketPrice(market);
  const day = dayRange(stats, live?.mid);
  return <div className="market-chart">
    <PriceHeader market={market} reference={stats?.open} period="24h" extra={
      <dl className="day-stats footnote">
        <div><dt>24h high</dt><dd>{usdc(day?.high)}</dd></div>
        <div><dt>24h low</dt><dd>{usdc(day?.low)}</dd></div>
      </dl>} />
    <div className="candle-frame">
      <Segmented className="chart-intervals" label="Candle interval" value={interval} onChange={setCandleInterval}
        options={CANDLE_PICKER.map(id => ({ id, label: id }))} />
      {series.candles.length
        ? <Suspense fallback={<div className="price-chart empty" style={{ height }}><span className="rfq-skel chart-skel" /></div>}>
            <CandleChart candles={series.candles} height={height} intervalMs={CANDLE_INTERVALS[interval]} label={`${marketName(market)} ${interval} candles`} />
          </Suspense>
        : <div className="price-chart empty" style={{ height }} role="status">
            {series.isPending && <span className="rfq-skel chart-skel" />}
            <span className="footnote rfq-faint">{series.isError ? "Price history is unavailable right now." : series.isPending ? "Loading candles…" : "Not enough price history yet."}</span>
          </div>}
    </div>
  </div>;
}
