import type { HistoryMarket } from "./history.js";

/** OHLC of the market mid in USDC micro-units; `start` is the bucket open, unix milliseconds. */
export interface Candle {
  start: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  samples: number;
}

export const MINUTE_MS = 60_000;
export const CANDLE_INTERVALS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
} as const;
export type CandleInterval = keyof typeof CANDLE_INTERVALS;
const MARKET_IDS: Record<HistoryMarket, number> = { BTC: 0, ETH: 1 };
const DIGITS = /^\d{1,30}$/;

/**
 * One-minute candles of the mid built from the market stream the gateway already relays. Bounded by
 * `retentionMs` (default seven days) per market. Chart context only, never an accounting record.
 */
export class CandleBook {
  private minutes: Record<HistoryMarket, Candle[]> = { BTC: [], ETH: [] };
  private readonly slots: number;
  constructor(retentionMs = 7 * 86_400_000) {
    if (!Number.isInteger(retentionMs) || retentionMs < MINUTE_MS)
      throw new Error("candle retention must be at least one minute");
    this.slots = Math.ceil(retentionMs / MINUTE_MS);
  }
  /** Records one market-stream frame ({ markets: { BTC: { observedAtMs, mid } } }); ignores anything malformed. */
  record(frame: string) {
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      return;
    }
    const markets = (value as { markets?: unknown } | null)?.markets;
    if (!markets || typeof markets !== "object") return;
    for (const market of ["BTC", "ETH"] as const) {
      const item = (markets as Record<string, { observedAtMs?: unknown; mid?: unknown } | undefined>)[market];
      if (!item || typeof item !== "object") continue;
      const observedAtMs = Number(item.observedAtMs),
        mid = String(item.mid ?? "");
      if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= 0 || !DIGITS.test(mid)) continue;
      this.add(market, observedAtMs, BigInt(mid));
    }
  }
  add(market: HistoryMarket, timeMs: number, price: bigint) {
    const list = this.minutes[market],
      start = Math.floor(timeMs / MINUTE_MS) * MINUTE_MS,
      last = list.at(-1);
    if (last && start < last.start) return; // late observation for a closed minute
    if (last && last.start === start) {
      if (price > last.high) last.high = price;
      if (price < last.low) last.low = price;
      last.close = price;
      last.samples++;
      return;
    }
    list.push({ start, open: price, high: price, low: price, close: price, samples: 1 });
    const oldest = start - (this.slots - 1) * MINUTE_MS;
    let drop = 0;
    while (drop < list.length && list[drop].start < oldest) drop++;
    if (drop) list.splice(0, drop);
  }
  /** One-minute candles with start in [fromMs, toMs], ascending. */
  range(market: HistoryMarket, fromMs: number, toMs: number) {
    return this.minutes[market]
      .filter((candle) => candle.start >= fromMs && candle.start <= toMs)
      .map((candle) => ({ ...candle }));
  }
  earliest(market: HistoryMarket) {
    return this.minutes[market][0]?.start ?? null;
  }
  status() {
    return {
      retentionMinutes: this.slots,
      minutes: { BTC: this.minutes.BTC.length, ETH: this.minutes.ETH.length },
    };
  }
}

/** Merges ascending candles into epoch-aligned `intervalMs` buckets. */
export function resampleCandles(candles: readonly Candle[], intervalMs: number) {
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

export const candleToWire = (candle: Candle) => ({
  time: candle.start,
  open: candle.open.toString(),
  high: candle.high.toString(),
  low: candle.low.toString(),
  close: candle.close.toString(),
  samples: candle.samples,
});

export interface CandleBackfillOptions {
  /** Oracle-node candle endpoints (`/v1/candles` on a node, `/v1/history/candles` on a Cloudflare node worker). */
  urls: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** How long a fetched (or failed) backfill window is reused. */
  ttlMs?: number;
  now?: () => number;
}

/** Parses an oracle-node candle response (unix-second times); returns null when anything is malformed. */
export function parseOracleCandles(body: unknown, intervalMs: number): Candle[] | null {
  const candles = (body as { candles?: unknown } | null)?.candles;
  if (!Array.isArray(candles)) return null;
  const parsed: Candle[] = [];
  for (const raw of candles) {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item !== "object") return null;
    const time = Number(item.time),
      samples = Number(item.samples ?? 0),
      prices = [item.open, item.high, item.low, item.close].map(String);
    if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(samples) || samples < 0) return null;
    if (!prices.every((price) => DIGITS.test(price))) return null;
    const start = time * 1_000;
    if (start % intervalMs !== 0 || (parsed.length && start <= parsed.at(-1)!.start)) return null;
    const [open, high, low, close] = prices.map(BigInt);
    if (high < low || open > high || open < low || close > high || close < low) return null;
    parsed.push({ start, open, high, low, close, samples });
  }
  return parsed;
}

/**
 * Older candles from the oracle nodes' persistent history, for windows the gateway's in-memory book does not
 * cover (it starts empty on every restart). The first node that answers wins; results and failures are
 * cached per market and interval for `ttlMs`, so chart traffic never fans out to the nodes.
 */
export class CandleBackfill {
  private cache = new Map<string, { atMs: number; fromMs: number; candles: Candle[] | null }>();
  private inflight = new Map<string, Promise<Candle[] | null>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly options: CandleBackfillOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }
  async get(market: HistoryMarket, interval: CandleInterval, fromMs: number) {
    const key = `${market}:${interval}`,
      cached = this.cache.get(key);
    if (cached && this.now() - cached.atMs < (this.options.ttlMs ?? 60_000) && cached.fromMs <= fromMs)
      return cached.candles;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetch(market, interval, fromMs)
        .then((candles) => {
          this.cache.set(key, { atMs: this.now(), fromMs, candles });
          return candles;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }
  private async fetch(market: HistoryMarket, interval: CandleInterval, fromMs: number) {
    const intervalMs = CANDLE_INTERVALS[interval],
      query = `market=${MARKET_IDS[market]}&interval=${interval}&from=${Math.floor(fromMs / 1_000)}&to=${Math.floor(this.now() / 1_000)}`;
    for (const url of this.options.urls) {
      try {
        const response = await this.fetchImpl(`${url}?${query}`, {
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 2_000),
          headers: { accept: "application/json" },
        });
        if (!response.ok) continue;
        const candles = parseOracleCandles(await response.json(), intervalMs);
        if (candles) return candles;
      } catch {
        // try the next node
      }
    }
    return null;
  }
}
