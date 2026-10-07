import { MAX_MARKETS, isMarketSymbol } from "../../../packages/shared/src/markets.js";

/** A market symbol as the relayed stream names it (any registered market, not a fixed list). */
export type HistoryMarket = string;
export type HistoryPoint = { observedAtMs: number; mid: string; bid: string; ask: string };

/** Bounded, disposable chart context. It is never an accounting or pricing ledger. */
export class MarketHistory {
  private points = new Map<HistoryMarket, HistoryPoint[]>();
  constructor(
    private readonly capacity = 1_800,
    private readonly sampleIntervalMs = 1_000,
  ) {
    if (!Number.isInteger(capacity) || capacity < 2) throw new Error("history capacity must be at least 2");
    if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 0)
      throw new Error("history sample interval must be nonnegative");
  }
  record(frame: string) {
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      return;
    }
    if (!value || typeof value !== "object") return;
    const markets = (value as { markets?: unknown }).markets;
    if (!markets || typeof markets !== "object") return;
    for (const [market, raw] of Object.entries(markets as Record<string, unknown>)) {
      if (!isMarketSymbol(market) || !raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>,
        observedAtMs = Number(item.observedAtMs),
        mid = String(item.mid ?? ""),
        bid = String(item.bid ?? ""),
        ask = String(item.ask ?? "");
      if (
        !Number.isFinite(observedAtMs) ||
        observedAtMs <= 0 ||
        !/^\d+$/.test(mid) ||
        !/^\d+$/.test(bid) ||
        !/^\d+$/.test(ask)
      )
        continue;
      let list = this.points.get(market);
      if (!list) {
        // Bounded like the contract's market count, so a malformed upstream cannot grow memory.
        if (this.points.size >= MAX_MARKETS) continue;
        list = [];
        this.points.set(market, list);
      }
      const last = list.at(-1);
      if (last && observedAtMs - last.observedAtMs < this.sampleIntervalMs) continue;
      list.push({ observedAtMs, mid, bid, ask });
      if (list.length > this.capacity) list.splice(0, list.length - this.capacity);
    }
  }
  /** Whether the stream has carried `market`. */
  has(market: HistoryMarket) {
    return this.points.has(market);
  }
  get(market: HistoryMarket, limit = this.capacity) {
    const bounded = Math.max(
      2,
      Math.min(this.capacity, Number.isFinite(limit) ? Math.floor(limit) : this.capacity),
    );
    return (this.points.get(market) ?? []).slice(-bounded);
  }
  status() {
    return {
      capacity: this.capacity,
      sampleIntervalMs: this.sampleIntervalMs,
      points: Object.fromEntries([...this.points].map(([market, list]) => [market, list.length])),
    };
  }
}
