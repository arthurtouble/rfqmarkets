import type { Market } from "../../../packages/shared/src/pricing.js";

export type VolatilitySignal = {
  fastBps: number;
  mediumBps: number;
  slowBps: number;
  jumpBps: number;
  riskBps: number;
  sampleCount: number;
};
type State = VolatilitySignal & { mid: bigint; atMs: number };

/** Time-aware EWMA absolute-return estimator for irregular real-time ticks. */
export class MarketSignalTracker {
  private state: Partial<Record<Market, State>> = {};
  observe(market: Market, mid: bigint, atMs: number): VolatilitySignal {
    if (mid <= 0n || !Number.isFinite(atMs)) throw new Error("invalid market signal");
    const prior = this.state[market];
    if (!prior) {
      const value = { fastBps: 0, mediumBps: 0, slowBps: 0, jumpBps: 0, riskBps: 0, sampleCount: 1 };
      this.state[market] = { ...value, mid, atMs };
      return value;
    }
    if (atMs <= prior.atMs) return this.latest(market)!;
    const elapsed = Math.min(60_000, atMs - prior.atMs),
      move =
        Number(((mid > prior.mid ? mid - prior.mid : prior.mid - mid) * 10_000_000n) / prior.mid) / 1_000;
    const ewma = (previous: number, horizonMs: number) =>
      previous * Math.exp(-elapsed / horizonMs) + move * (1 - Math.exp(-elapsed / horizonMs));
    const fastBps = ewma(prior.fastBps, 1_000),
      mediumBps = ewma(prior.mediumBps, 10_000),
      slowBps = ewma(prior.slowBps, 60_000),
      jumpBps = Math.max(move, prior.jumpBps * Math.exp(-elapsed / 5_000));
    const value = {
      fastBps,
      mediumBps,
      slowBps,
      jumpBps,
      riskBps: Math.max(jumpBps, fastBps * 2, mediumBps * 3, slowBps * 4),
      sampleCount: prior.sampleCount + 1,
    };
    this.state[market] = { ...value, mid, atMs };
    return value;
  }
  latest(market: Market) {
    const value = this.state[market];
    return (
      value && {
        fastBps: value.fastBps,
        mediumBps: value.mediumBps,
        slowBps: value.slowBps,
        jumpBps: value.jumpBps,
        riskBps: value.riskBps,
        sampleCount: value.sampleCount,
      }
    );
  }
}
