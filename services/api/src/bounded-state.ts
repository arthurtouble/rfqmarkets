import { MAX_MARKETS } from "../../../packages/shared/src/markets.js";
import { marketRegistry, type Market } from "./markets.js";
import { ExpiryIndex } from "../../../packages/shared/src/expiry-index.js";
export { ExpiryIndex } from "../../../packages/shared/src/expiry-index.js";

type PendingItem = { market: Market; delta: bigint; expiresAtMs: number };

/** Constant-time reservation totals used by the pricing path. */
export class PendingExposureBook {
  revision = 0;
  private items = new Map<string, PendingItem>();
  private expiries = new ExpiryIndex();
  /** Pending low (sells) and high (buys) totals per market, in first-reservation order. */
  private totals = new Map<Market, { low: bigint; high: bigint }>();
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
    // In market index order (unregistered symbols last), so the envelope is stable.
    const order = (market: Market) =>
      marketRegistry.has(market) ? marketRegistry.index(market) : MAX_MARKETS;
    const markets = [...this.totals.entries()].sort(([left], [right]) => order(left) - order(right));
    for (const [market, value] of markets) {
      const low = value.low - (excluded?.market === market && excluded.delta < 0n ? excluded.delta : 0n),
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
    let totals = this.totals.get(item.market);
    if (!totals) this.totals.set(item.market, (totals = { low: 0n, high: 0n }));
    if (item.delta < 0n) totals.low += item.delta * multiplier;
    else totals.high += item.delta * multiplier;
  }
}
