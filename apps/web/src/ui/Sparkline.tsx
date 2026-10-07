/** A small trend line for lists: values oldest first, coloured by direction. */
export function Sparkline({ values, width = 72, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <span className="sparkline is-empty" style={{ width, height }} aria-hidden="true" />;
  const low = Math.min(...values), high = Math.max(...values), span = high - low || 1, pad = 2;
  const points = values.map((value, index) =>
    `${(index * width / (values.length - 1)).toFixed(1)},${(pad + (high - value) * (height - pad * 2) / span).toFixed(1)}`);
  const first = values[0], last = values.at(-1)!;
  const trend = last > first ? "up" : last < first ? "down" : "flat";
  return <svg className={`sparkline ${trend}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
  </svg>;
}
