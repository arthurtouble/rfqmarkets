/** OHLC candles of the signed mid (USDC micro-units), keyed by market id. */
export interface Candle {
  /** Bucket open time, unix milliseconds. */
  start: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  samples: number;
}

/**
 * Stores one-minute candles. The in-memory store is the default; a persistent implementation can be
 * plugged in behind the same interface.
 */
export interface CandleStore {
  record(market: number, timeMs: number, price: bigint): void | Promise<void>;
  /** One-minute candles with start in [fromMs, toMs], ascending. */
  range(market: number, fromMs: number, toMs: number): Candle[] | Promise<Candle[]>;
}

export const CANDLE_BUCKET_MS = 60_000;
export const CANDLE_INTERVALS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/** Ring buffer of one-minute candles per market; default retention 24 hours. */
export class MemoryCandleStore implements CandleStore {
  private rings = new Map<number, { candles: Array<Candle | undefined>; latest: number }>();
  private slots: number;
  constructor(retentionMs = 24 * 3_600_000) {
    this.slots = Math.max(1, Math.ceil(retentionMs / CANDLE_BUCKET_MS));
  }
  record(market: number, timeMs: number, price: bigint) {
    const start = Math.floor(timeMs / CANDLE_BUCKET_MS) * CANDLE_BUCKET_MS,
      index = (start / CANDLE_BUCKET_MS) % this.slots;
    let ring = this.rings.get(market);
    if (!ring) {
      ring = { candles: new Array(this.slots), latest: start };
      this.rings.set(market, ring);
    }
    if (start <= ring.latest - this.slots * CANDLE_BUCKET_MS) return; // outside retention
    if (start > ring.latest) ring.latest = start;
    const candle = ring.candles[index];
    if (candle && candle.start === start) {
      if (price > candle.high) candle.high = price;
      if (price < candle.low) candle.low = price;
      candle.close = price;
      candle.samples++;
    } else if (!candle || candle.start < start)
      ring.candles[index] = { start, open: price, high: price, low: price, close: price, samples: 1 };
  }
  range(market: number, fromMs: number, toMs: number) {
    const ring = this.rings.get(market);
    if (!ring || toMs < fromMs) return [];
    // Only the `slots` buckets ending at the newest recorded one can still be held.
    const begin = Math.max(
        Math.ceil(fromMs / CANDLE_BUCKET_MS) * CANDLE_BUCKET_MS,
        ring.latest - (this.slots - 1) * CANDLE_BUCKET_MS,
      ),
      end = Math.min(toMs, ring.latest),
      candles: Candle[] = [];
    for (let start = begin; start <= end; start += CANDLE_BUCKET_MS) {
      const candle = ring.candles[(start / CANDLE_BUCKET_MS) % this.slots];
      if (candle && candle.start === start) candles.push({ ...candle });
    }
    return candles;
  }
}

/** Merges ascending one-minute candles into `intervalMs` buckets aligned to the epoch. */
export function resampleCandles(candles: readonly Candle[], intervalMs: number): Candle[] {
  if (intervalMs === CANDLE_BUCKET_MS) return candles.map((candle) => ({ ...candle }));
  const merged: Candle[] = [];
  for (const candle of candles) {
    const start = Math.floor(candle.start / intervalMs) * intervalMs,
      last = merged.at(-1);
    if (last && last.start === start) {
      if (candle.high > last.high) last.high = candle.high;
      if (candle.low < last.low) last.low = candle.low;
      last.close = candle.close;
      last.samples += candle.samples;
    } else merged.push({ ...candle, start });
  }
  return merged;
}

export function candleToWire(candle: Candle) {
  return {
    time: Math.floor(candle.start / 1_000),
    open: candle.open.toString(),
    high: candle.high.toString(),
    low: candle.low.toString(),
    close: candle.close.toString(),
    samples: candle.samples,
  };
}
