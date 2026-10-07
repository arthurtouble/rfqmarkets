import { useId, useRef, useState, type PointerEvent } from "react";
import type { ChartPoint } from "../lib/candles.js";
import { chartTime } from "../lib/market-stats.js";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Price line for the Simple view. Points are mids in dollars, oldest first.
 * Hovering or dragging scrubs: `onScrub` gets the point under the pointer, or
 * null when the pointer leaves.
 */
export function PriceChart({ points, height = 240, state = "ready", onScrub }: {
  points: ChartPoint[]; height?: number; state?: "ready" | "loading" | "error"; onScrub?: (point: ChartPoint | null) => void;
}) {
  const gradient = useId();
  const frame = useRef<HTMLElement>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  if (points.length < 2) {
    const message = state === "error" ? "Price history is unavailable right now." : state === "loading" ? "Loading prices…" : "Not enough price history yet.";
    return <div className="price-chart empty" style={{ height }} role="status">
      {state === "loading" && <span className="rfq-skel chart-skel" />}<span className="footnote rfq-faint">{message}</span>
    </div>;
  }
  const width = 800, pad = 24;
  const values = points.map(point => point.value);
  let lowIndex = 0, highIndex = 0;
  values.forEach((value, index) => { if (value < values[lowIndex]) lowIndex = index; if (value > values[highIndex]) highIndex = index; });
  const low = values[lowIndex], high = values[highIndex], first = values[0], last = values.at(-1)!;
  const range = Math.max(high - low, Math.abs(last) * 0.0002, 0.01), mid = (high + low) / 2;
  const top = mid + range / 2, bottom = mid - range / 2;
  const x = (index: number) => index * width / (values.length - 1);
  const y = (value: number) => pad + (top - value) * (height - pad * 2) / (top - bottom);
  const path = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  const trend = last > first ? "up" : last < first ? "down" : "flat";
  const spanMs = points.at(-1)!.time - points[0].time;
  const at = scrub ?? values.length - 1;
  const left = (index: number) => `${(x(index) / width) * 100}%`;
  // Edge labels hang inward so they never leave the chart.
  const align = (index: number) => { const at = index / (values.length - 1); return at < 0.15 ? "is-start" : at > 0.85 ? "is-end" : ""; };

  const pick = (event: PointerEvent<HTMLElement>) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box?.width) return;
    const index = Math.round(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * (values.length - 1));
    setScrub(index); onScrub?.(points[index]);
  };
  const release = () => { setScrub(null); onScrub?.(null); };

  return <figure ref={frame} className={`price-chart ${trend}${scrub !== null ? " is-scrubbing" : ""}`} style={{ height }}
    onPointerMove={pick} onPointerDown={pick} onPointerLeave={release} onPointerCancel={release} onPointerUp={event => { if (event.pointerType !== "mouse") release(); }}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Price chart, ${trend}. High ${usd.format(high)}, low ${usd.format(low)}.`}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".2" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <path d={`M ${path.join(" L ")} L ${width},${height} L 0,${height} Z`} fill={`url(#${gradient})`} />
      <polyline points={path.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <line className="chart-baseline" x1="0" x2={width} y1={y(first)} y2={y(first)} vectorEffect="non-scaling-stroke" />
    </svg>
    <span className={`chart-extreme is-high ${align(highIndex)}`} style={{ left: left(highIndex), top: `${y(high) - 4}px` }}>{usd.format(high)}</span>
    <span className={`chart-extreme is-low ${align(lowIndex)}`} style={{ left: left(lowIndex), top: `${y(low) + 4}px` }}>{usd.format(low)}</span>
    {scrub !== null && <span className="chart-crosshair" style={{ left: left(scrub) }} aria-hidden="true" />}
    <span className={`chart-dot${scrub === null ? " is-live" : ""}`} style={{ left: left(at), top: `${y(values[at])}px` }} aria-hidden="true" />
    <figcaption className="chart-axis caption rfq-faint"><span>{chartTime(points[0].time, spanMs)}</span><span>{chartTime(points.at(-1)!.time, spanMs)}</span></figcaption>
  </figure>;
}
