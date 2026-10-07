import type { Market, PriceSnapshot } from "../../../packages/shared/src/pricing.js";

export type FlowFill = {
  market: Market;
  side: "buy" | "sell";
  price: bigint;
  notional: bigint;
  atMs: number;
};

/** Market-wide post-trade markout estimator. Quote requests never enter this state. */
export class FlowRiskTracker {
  private fills = new Map<Market, Array<Omit<FlowFill, "market">>>();
  constructor(
    private readonly capacity = 256,
    private readonly halfLifeMs = 30_000,
    initial: FlowFill[] = [],
  ) {
    for (const fill of initial) this.record(fill.market, fill);
  }
  record(market: Market, fill: Omit<FlowFill, "market">) {
    let items = this.fills.get(market);
    if (!items) this.fills.set(market, (items = []));
    items.push(fill);
    if (items.length > this.capacity) items.splice(0, items.length - this.capacity);
  }
  score(market: Market, snapshot: PriceSnapshot, nowMs = Date.now()) {
    const mid = (snapshot.bid + snapshot.ask) / 2n;
    if (mid <= 0n) return 10_000;
    let weighted = 0,
      total = 0;
    for (const fill of this.fills.get(market) ?? []) {
      const age = nowMs - fill.atMs;
      if (age < 250 || age > this.halfLifeMs * 8) continue;
      const move = fill.side === "buy" ? mid - fill.price : fill.price - mid;
      const adverseBps = move > 0n ? Number((move * 10_000n) / fill.price) : 0;
      const recency = Math.pow(0.5, age / this.halfLifeMs);
      const sizeWeight = Math.min(4, Math.max(0.25, Number(fill.notional) / 100_000_000_000));
      const weight = recency * sizeWeight;
      weighted += Math.min(1, adverseBps / 10) * weight;
      total += weight;
    }
    return total ? Math.round(Math.min(1, weighted / total) * 10_000) : 0;
  }
  size(market: Market) {
    return this.fills.get(market)?.length ?? 0;
  }
  entries() {
    return [...this.fills].flatMap(([market, fills]) => fills.map((fill) => ({ market, ...fill })));
  }
}
