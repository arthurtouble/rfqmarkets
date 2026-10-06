export class ShadowModelTelemetry {
  private count = 0;
  private liveTotal = 0;
  private candidateTotal = 0;
  private wider = 0;
  private maxDelta = 0;
  observe(live: number, candidate: number) {
    if (!Number.isFinite(live) || !Number.isFinite(candidate)) return;
    this.count++;
    this.liveTotal += live;
    this.candidateTotal += candidate;
    if (candidate > live) this.wider++;
    this.maxDelta = Math.max(this.maxDelta, Math.abs(candidate - live));
  }
  snapshot() {
    return {
      modelVersion: "adaptive-shadow-v2",
      count: this.count,
      meanLiveBps: this.count ? this.liveTotal / this.count : 0,
      meanCandidateBps: this.count ? this.candidateTotal / this.count : 0,
      widerRate: this.count ? this.wider / this.count : 0,
      maxAbsoluteDeltaBps: this.maxDelta,
    };
  }
}
