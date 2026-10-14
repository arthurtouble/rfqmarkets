// Price header and candle chart for one market in Pro: candlesticks at a
// chosen interval with the 24h high and low. Home draws its own tick line.
import { Suspense, lazy, useState } from "react";
import { useLiveCandles } from "../data/candles.js";
import { useMarketPrice } from "../data/market-feed.js";
import { useMarketStats } from "../data/market-stats.js";
import { CANDLE_INTERVALS } from "../lib/candles.js";
import { usdc } from "../lib/format.js";
import { CANDLE_PICKER, DEFAULT_CANDLE_INTERVAL, dayRange } from "../lib/market-stats.js";
import type { CandleInterval, Market } from "../lib/types.js";
import { store, storedChoice } from "../lib/storage.js";
import { Segmented, marketName } from "../ui/primitives.js";
import { PriceHeader } from "./MarketHeader.js";

const CandleChart = lazy(() => import("./CandleChart.js"));

const INTERVAL_KEY = "rfq.candleInterval";
function useStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => storedChoice(key, allowed, fallback));
  return [
    value,
    (next: T) => {
      store(key, next);
      setValue(next);
    },
  ] as const;
}

/** The price header and candle chart; `height` is the chart's own height. */
export function MarketChart({ market, height }: { market: Market; height: number }) {
  const [interval, setCandleInterval] = useStoredChoice<CandleInterval>(
    INTERVAL_KEY,
    CANDLE_PICKER,
    DEFAULT_CANDLE_INTERVAL,
  );
  const series = useLiveCandles(market, interval);
  const stats = useMarketStats().data?.markets[market];
  const { live } = useMarketPrice(market);
  const day = dayRange(stats, live?.mid);
  return (
    <div className="market-chart">
      <PriceHeader
        market={market}
        reference={stats?.open}
        period="24h"
        extra={
          <dl className="day-stats footnote">
            <div>
              <dt>24h high</dt>
              <dd>{usdc(day?.high)}</dd>
            </div>
            <div>
              <dt>24h low</dt>
              <dd>{usdc(day?.low)}</dd>
            </div>
          </dl>
        }
      />
      <div className="candle-frame">
        <Segmented
          className="chart-intervals"
          label="Candle interval"
          value={interval}
          onChange={setCandleInterval}
          options={CANDLE_PICKER.map((id) => ({ id, label: id }))}
        />
        {series.candles.length ? (
          <Suspense
            fallback={
              <div className="price-chart empty" style={{ height }}>
                <span className="rfq-skel chart-skel" />
              </div>
            }
          >
            <CandleChart
              candles={series.candles}
              height={height}
              intervalMs={CANDLE_INTERVALS[interval]}
              label={`${marketName(market)} ${interval} candles`}
            />
          </Suspense>
        ) : (
          <div className="price-chart empty" style={{ height }} role="status">
            {series.isPending && <span className="rfq-skel chart-skel" />}
            <span className="footnote rfq-faint">
              {series.isError
                ? "Price history is unavailable right now."
                : series.isPending
                  ? "Loading candles…"
                  : "Not enough price history yet."}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
