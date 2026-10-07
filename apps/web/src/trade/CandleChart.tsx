// Candlestick chart for the Advanced view (TradingView Lightweight Charts).
// Loaded on demand, so the Simple view never downloads the library. Colours
// come from the design tokens and follow the theme.
import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, TickMarkType, createChart, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from "lightweight-charts";
import { candleToNumbers } from "../lib/candles.js";
import type { Candle } from "../lib/types.js";

const price = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toSeconds = (ms: number) => Math.floor(ms / 1_000) as UTCTimestamp;
const local = (time: Time) => new Date((time as number) * 1_000);

function tickLabel(time: Time, type: TickMarkType) {
  const date = local(time);
  switch (type) {
    case TickMarkType.Year: return String(date.getFullYear());
    case TickMarkType.Month: return date.toLocaleDateString([], { month: "short" });
    case TickMarkType.DayOfMonth: return date.toLocaleDateString([], { month: "short", day: "numeric" });
    default: return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}

function palette(element: HTMLElement) {
  const style = getComputedStyle(element), token = (name: string) => style.getPropertyValue(name).trim();
  return { text: token("--text-secondary"), line: token("--line"), long: token("--long"), short: token("--short"), font: token("--font-sans") };
}

function themed(element: HTMLElement) {
  const colors = palette(element);
  return {
    chart: {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: colors.text, fontFamily: colors.font, fontSize: 11, attributionLogo: true },
      grid: { vertLines: { visible: false }, horzLines: { color: colors.line } },
      rightPriceScale: { borderColor: colors.line },
      timeScale: { borderColor: colors.line },
    },
    series: { upColor: colors.long, downColor: colors.short, borderUpColor: colors.long, borderDownColor: colors.short, wickUpColor: colors.long, wickDownColor: colors.short },
  };
}

export default function CandleChart({ candles, height, intervalMs, label }: { candles: Candle[]; height: number; intervalMs: number; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const look = themed(element);
    const api = createChart(element, {
      autoSize: true,
      ...look.chart,
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: (value: number) => price.format(value), timeFormatter: (time: Time) => local(time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) },
      timeScale: { ...look.chart.timeScale, timeVisible: true, secondsVisible: false, rightOffset: 4, tickMarkFormatter: tickLabel },
      handleScroll: { vertTouchDrag: false },
    });
    chart.current = api;
    series.current = api.addSeries(CandlestickSeries, { ...look.series, priceLineVisible: true, lastValueVisible: true });
    // The theme can flip from the system setting or the app's own switch.
    const recolor = () => { const next = themed(element); api.applyOptions(next.chart); series.current?.applyOptions(next.series); };
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", recolor);
    const observer = new MutationObserver(recolor);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { media.removeEventListener("change", recolor); observer.disconnect(); api.remove(); chart.current = null; series.current = null; };
  }, []);

  // A new interval is a new series: refit the view to it.
  useEffect(() => { fitted.current = false; }, [intervalMs]);

  useEffect(() => {
    if (!series.current) return;
    series.current.setData(candles.map(candle => { const { open, high, low, close } = candleToNumbers(candle); return { time: toSeconds(candle.time), open, high, low, close }; }));
    if (!fitted.current && candles.length) { chart.current?.timeScale().fitContent(); fitted.current = true; }
  }, [candles]);

  return <div ref={host} className="candle-chart" style={{ height }} role="img" aria-label={label} />;
}
