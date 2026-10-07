import { useId } from "react";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Session price line. Values are mids in dollars, oldest first. */
export function PriceChart({ values }: { values: number[] }) {
  const gradient = useId();
  if (values.length < 2) return <div className="price-chart empty"><span>Waiting for prices…</span></div>;
  const width = 800, height = 240, pad = 14;
  const low = Math.min(...values), high = Math.max(...values), first = values[0], last = values.at(-1)!;
  const range = Math.max(high - low, Math.abs(last) * 0.0002, 0.01), mid = (high + low) / 2;
  const top = mid + range / 2, bottom = mid - range / 2;
  const x = (index: number) => pad + index * (width - pad * 2) / (values.length - 1);
  const y = (value: number) => pad + (top - value) * (height - pad * 2) / (top - bottom);
  const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  const moveBps = first ? (last / first - 1) * 10_000 : 0;
  const trend = Math.abs(moveBps) < 0.25 ? "flat" : moveBps > 0 ? "up" : "down";
  return <figure className={`price-chart ${trend}`}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Session price ${trend}, ${moveBps.toFixed(1)} basis points`}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".2" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <path d={`M ${points.join(" L ")} L ${x(values.length - 1)},${height - pad} L ${pad},${height - pad} Z`} fill={`url(#${gradient})`} />
      <line className="last-line" x1={pad} x2={width - pad} y1={y(last)} y2={y(last)} vectorEffect="non-scaling-stroke" />
      <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
    <figcaption>
      <span>High {usd.format(high)}</span><span>Low {usd.format(low)}</span>
      <span className={trend}>{moveBps >= 0 ? "+" : ""}{moveBps.toFixed(1)} bps session</span>
    </figcaption>
  </figure>;
}
