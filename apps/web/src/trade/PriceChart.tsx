import { useId } from "react";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Recent price line. Values are mids in dollars, oldest first. */
export function PriceChart({ values, height = 240 }: { values: number[]; height?: number }) {
  const gradient = useId();
  if (values.length < 2) return <div className="price-chart empty" style={{ height }}><span className="rfq-skel chart-skel" /><span className="footnote rfq-faint">Loading prices…</span></div>;
  const width = 800, pad = 8;
  const low = Math.min(...values), high = Math.max(...values), first = values[0], last = values.at(-1)!;
  const range = Math.max(high - low, Math.abs(last) * 0.0002, 0.01), mid = (high + low) / 2;
  const top = mid + range / 2, bottom = mid - range / 2;
  const x = (index: number) => index * (width - pad) / (values.length - 1);
  const y = (value: number) => pad + (top - value) * (height - pad * 2) / (top - bottom);
  const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  const trend = last > first ? "up" : last < first ? "down" : "flat";
  return <figure className={`price-chart ${trend}`} style={{ height }}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Recent price, ${trend}. High ${usd.format(high)}, low ${usd.format(low)}.`}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".22" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <path d={`M ${points.join(" L ")} L ${x(values.length - 1)},${height} L 0,${height} Z`} fill={`url(#${gradient})`} />
      <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
    <span className="chart-dot" style={{ top: `${(y(last) / height) * 100}%` }} aria-hidden="true" />
    <figcaption className="caption rfq-faint"><span>High {usd.format(high)}</span><span>Low {usd.format(low)}</span></figcaption>
  </figure>;
}
