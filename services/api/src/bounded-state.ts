import type { Market } from "./markets.js";
import { ExpiryIndex } from "../../../packages/shared/src/expiry-index.js";
export { ExpiryIndex } from "../../../packages/shared/src/expiry-index.js";

type PendingItem = { market: Market; delta: bigint; expiresAtMs: number };

/** Constant-time reservation totals used by the pricing path. */
export class PendingExposureBook {
  revision = 0;
  private items = new Map<string, PendingItem>();
  private expiries = new ExpiryIndex();
  private totals: Record<Market, { low: bigint; high: bigint }> = {
    BTC: { low: 0n, high: 0n },
    ETH: { low: 0n, high: 0n },
  };
  get size() {
    return this.items.size;
  }
  has(id: string) {
    return this.items.has(id);
  }
  add(id: string, item: PendingItem) {
    this.delete(id);
    this.items.set(id, item);
    this.adjust(item, 1n);
    this.expiries.schedule(id, item.expiresAtMs);
    this.revision++;
  }
  delete(id: string) {
    const item = this.items.get(id);
    if (!item) return false;
    this.items.delete(id);
    this.expiries.cancel(id);
    this.adjust(item, -1n);
    this.revision++;
    return true;
  }
  prune(now = Date.now(), limit = 512) {
    for (const id of this.expiries.takeExpired(now, limit)) {
      const item = this.items.get(id);
      if (item) {
        this.items.delete(id);
        this.adjust(item, -1n);
        this.revision++;
      }
    }
  }
  exposure(excludeId?: string) {
    const excluded = excludeId ? this.items.get(excludeId) : undefined,
      result: Array<{ market: Market; delta: bigint }> = [];
    for (const market of ["BTC", "ETH"] as const) {
      const value = this.totals[market],
        low = value.low - (excluded?.market === market && excluded.delta < 0n ? excluded.delta : 0n),
        high = value.high - (excluded?.market === market && excluded.delta > 0n ? excluded.delta : 0n);
      if (low) result.push({ market, delta: low });
      if (high) result.push({ market, delta: high });
    }
    return result;
  }
  envelope() {
    return this.exposure().map((item) => ({ ...item, delta: item.delta.toString() }));
  }
  private adjust(item: PendingItem, multiplier: bigint) {
    if (item.delta < 0n) this.totals[item.market].low += item.delta * multiplier;
    else this.totals[item.market].high += item.delta * multiplier;
  }
}
