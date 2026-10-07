// Portfolio chart data from the indexer's PnL history (GET /v1/portfolio/:address/history).
import type { PortfolioInterval, PortfolioPoint } from "./types.js";

export type PnlRange = "1d" | "1w" | "1m" | "all";
export const PNL_RANGES: Array<{ id: PnlRange; label: string }> = [
  { id: "1d", label: "24H" }, { id: "1w", label: "1W" }, { id: "1m", label: "1M" }, { id: "all", label: "All" },
];
const HOUR = 3_600_000, DAY = 24 * HOUR;
const RANGE_MS: Record<PnlRange, number | null> = { "1d": DAY, "1w": 7 * DAY, "1m": 30 * DAY, all: null };
/** The history bucket each range asks the indexer for. */
export const RANGE_INTERVAL: Record<PnlRange, PortfolioInterval> = { "1d": "event", "1w": "1h", "1m": "1d", all: "1d" };

export type PnlPoint = { timeMs: number; value: bigint };

/**
 * Realized net PnL (after fees and funding) over `range`, plus the live
 * unrealized PnL as the final point at `nowMs`. The series starts at the value
 * carried into the range, so a quiet day still draws a line.
 */
export function pnlSeries(points: readonly PortfolioPoint[], range: PnlRange, nowMs: number, unrealized = 0n): PnlPoint[] {
  const span = RANGE_MS[range];
  // "All" covers at least a day, so a new account's first trades do not fill the whole width.
  const first = Math.min(...points.map(point => point.timeMs), nowMs);
  const start = span === null ? Math.min(first, nowMs - DAY) : nowMs - span;
  const sorted = [...points].sort((a, b) => a.timeMs - b.timeMs);
  let carried = 0n;
  const series: PnlPoint[] = [];
  for (const point of sorted) {
    if (point.timeMs < start) carried = BigInt(point.netPnl);
    else series.push({ timeMs: point.timeMs, value: BigInt(point.netPnl) });
  }
  const last = series.at(-1)?.value ?? carried;
  return [{ timeMs: start, value: carried }, ...series, { timeMs: nowMs, value: last + unrealized }];
}

/** Change over the series: last minus first. */
export const seriesChange = (series: readonly PnlPoint[]) => (series.length ? series.at(-1)!.value - series[0].value : 0n);
