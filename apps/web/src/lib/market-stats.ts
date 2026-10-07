// Market discovery helpers: 24h stats from the market gateway, search, chart
// ranges and the price state each market shows (live, delayed, paused, none).
import type { CandleInterval, Market, MarketState } from "./types.js";

/** One market's rolling 24h summary from GET /v1/markets/stats. Prices are USDC 1e6 strings. */
export type DayStats = {
  /** Start of the first bucket, unix ms; later than 24h ago while history is still filling. */
  since: number;
  open: string; high: string; low: string; last: string;
  /** last − open, signed. */
  change: string;
  /** Hourly closes, oldest first, for a sparkline. */
  spark: string[];
};
export type MarketStatsResponse = { serverTimeMs: number; windowMs: number; markets: Record<Market, DayStats> };

/** Price change against a reference, as numbers for display. Null without both prices. */
export function priceChange(fromMicro?: string | bigint | null, toMicro?: string | bigint | null) {
  if (fromMicro === undefined || fromMicro === null || toMicro === undefined || toMicro === null) return null;
  const from = BigInt(fromMicro), to = BigInt(toMicro);
  if (from <= 0n || to <= 0n) return null;
  const delta = Number(to - from) / 1e6;
  return { delta, ratio: Number(to - from) / Number(from) };
}

/** The 24h change, measured to the live mid when there is one so it moves with the price. */
export const dayChange = (stats: DayStats | undefined, liveMid?: string) => stats ? priceChange(stats.open, liveMid ?? stats.last) : null;

/** The 24h high and low, widened by the live mid. */
export function dayRange(stats: DayStats | undefined, liveMid?: string) {
  if (!stats) return null;
  let high = BigInt(stats.high), low = BigInt(stats.low);
  if (liveMid) { const mid = BigInt(liveMid); if (mid > high) high = mid; if (mid < low) low = mid; }
  return { high, low };
}

/**
 * Filters markets by symbol or name, case-insensitive. Symbol prefix matches
 * come first, then name prefix, then anything containing the query; order is
 * otherwise kept.
 */
export function searchMarkets<T extends Market>(markets: readonly T[], query: string, name: (market: T) => string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...markets];
  const rank = (market: T) => {
    const symbol = market.toLowerCase(), label = name(market).toLowerCase();
    if (symbol.startsWith(needle)) return 0;
    if (label.startsWith(needle)) return 1;
    if (symbol.includes(needle) || label.includes(needle)) return 2;
    return -1;
  };
  return markets.map((market, order) => ({ market, order, score: rank(market) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map(item => item.market);
}

/** How old a price may be before the UI calls it delayed. The oracle signs about once a second. */
export const STALE_PRICE_MS = 15_000;

export type PriceStatus =
  /** Priced and current. */
  | "live"
  /** The stream is reconnecting or the last price is older than STALE_PRICE_MS. */
  | "delayed"
  /** Governance paused the market: closing only. */
  | "paused"
  /** Registered but the oracle does not price it (yet), or the stream has not delivered it. */
  | "unavailable";

/**
 * The state a market's price is in. `receivedAtMs` is when this client last
 * got a snapshot; `serverTimeMs` is the snapshot's own clock, so a price the
 * server kept serving after the oracle stopped also counts as delayed.
 */
export function priceStatus(live: MarketState | undefined, options: { streamLive: boolean; nowMs: number; receivedAtMs: number | null; serverTimeMs?: number }): PriceStatus {
  if (!live) return "unavailable";
  if (!live.enabled) return "paused";
  if (!options.streamLive) return "delayed";
  if (options.receivedAtMs !== null && options.nowMs - options.receivedAtMs > STALE_PRICE_MS) return "delayed";
  if (options.serverTimeMs && options.serverTimeMs - live.observedAtMs > STALE_PRICE_MS) return "delayed";
  return "live";
}

/** Simple-view chart ranges: each is a candle interval and how many buckets cover it. */
export const CHART_RANGES = {
  "1H": { interval: "1m", limit: 60, label: "Past hour" },
  "1D": { interval: "5m", limit: 288, label: "Past day" },
  "1W": { interval: "1h", limit: 168, label: "Past week" },
  "1M": { interval: "4h", limit: 180, label: "Past month" },
} as const satisfies Record<string, { interval: CandleInterval; limit: number; label: string }>;
export type ChartRange = keyof typeof CHART_RANGES;
export const CHART_RANGE_IDS = Object.keys(CHART_RANGES) as ChartRange[];
export const DEFAULT_CHART_RANGE: ChartRange = "1D";
/** Advanced-view candle intervals, in the order the picker shows them. */
export const CANDLE_PICKER: readonly CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
export const DEFAULT_CANDLE_INTERVAL: CandleInterval = "15m";

/** Time label for a chart point: clock time within a day, date beyond. */
export function chartTime(ms: number, spanMs: number) {
  const date = new Date(ms);
  if (spanMs <= 86_400_000) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
