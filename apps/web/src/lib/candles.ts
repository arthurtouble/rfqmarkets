// OHLC candles of the market mid from GET /v1/candles (market gateway), with
// the last bucket kept live from the market stream between refetches.
import type { Candle, CandleInterval } from "./types.js";

export const CANDLE_INTERVALS: Record<CandleInterval, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};
export const DEFAULT_CANDLE_LIMIT = 300;
export const MAX_CANDLE_LIMIT = 1_000;

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Folds a live mid observed at `timeMs` into ascending `candles`: it extends
 * the current bucket, opens a new one at the previous close, or is ignored when
 * older than the last bucket. Returns a new array (the input is not changed)
 * trimmed to `limit`.
 */
export function mergeLiveCandle(candles: readonly Candle[], interval: CandleInterval, timeMs: number, midMicro: bigint, limit = MAX_CANDLE_LIMIT): Candle[] {
  if (midMicro <= 0n || !Number.isFinite(timeMs)) return [...candles];
  const size = CANDLE_INTERVALS[interval], start = Math.floor(timeMs / size) * size, last = candles.at(-1);
  if (last && start < last.time) return [...candles];
  const price = midMicro.toString();
  if (last && start === last.time) {
    const updated: Candle = {
      ...last, high: max(BigInt(last.high), midMicro).toString(), low: min(BigInt(last.low), midMicro).toString(),
      close: price, samples: last.samples + 1,
    };
    return [...candles.slice(0, -1), updated];
  }
  const open = last?.close ?? price;
  const next: Candle = {
    time: start, open, high: max(BigInt(open), midMicro).toString(), low: min(BigInt(open), midMicro).toString(), close: price, samples: 1,
  };
  return [...candles, next].slice(-limit);
}

/** Display numbers (USDC) for chart libraries; `time` stays in unix ms. */
export const candleToNumbers = (candle: Candle) => ({
  time: candle.time, open: Number(candle.open) / 1e6, high: Number(candle.high) / 1e6,
  low: Number(candle.low) / 1e6, close: Number(candle.close) / 1e6,
});
