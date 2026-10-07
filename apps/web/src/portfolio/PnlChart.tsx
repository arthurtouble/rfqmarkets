import { useId } from "react";
import { scaled, signedUsdc } from "../lib/format.js";
import type { PnlPoint } from "../lib/portfolio.js";

/** PnL over time, drawn to scale in time, with a dashed zero line. */
export function PnlChart({ series, height = 180 }: { series: PnlPoint[]; height?: number }) {
  const gradient = useId();
  const width = 800, pad = 8;
  const times = series.map(item => item.timeMs), values = series.map(item => scaled(item.value, 6));
  const first = Math.min(...times), last = Math.max(...times);
  const low = Math.min(0, ...values), high = Math.max(0, ...values), span = Math.max(high - low, 1);
  const x = (time: number) => (last === first ? 0 : (time - first) * width / (last - first));
  const y = (value: number) => pad + (high - value) * (height - pad * 2) / span;
  // Realized PnL moves in steps: hold each value until the next event.
  const points = series.flatMap((item, index) => {
    const here = `${x(item.timeMs).toFixed(1)},${y(values[index]).toFixed(1)}`;
    return index === 0 ? [here] : [`${x(item.timeMs).toFixed(1)},${y(values[index - 1]).toFixed(1)}`, here];
  });
  const end = series.at(-1)?.value ?? 0n;
  const tone = end > 0n ? "up" : end < 0n ? "down" : "flat";
  return <figure className={`pnl-chart ${tone}`} style={{ height }}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`PnL over the period, now ${signedUsdc(end)}`}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".18" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <line className="pnl-chart__zero" x1="0" x2={width} y1={y(0)} y2={y(0)} vectorEffect="non-scaling-stroke" />
      <path d={`M ${points.join(" L ")} L ${width},${y(0)} L 0,${y(0)} Z`} fill={`url(#${gradient})`} />
      <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  </figure>;
}
