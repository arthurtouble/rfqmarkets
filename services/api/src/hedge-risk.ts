import type { HedgeRiskSnapshot, HedgeRiskSource } from "../../../packages/shared/src/hedge-risk.js";

export class HttpHedgeRiskSource implements HedgeRiskSource {
  private cached?: { at: number; value: HedgeRiskSnapshot };
  private inFlight?: Promise<HedgeRiskSnapshot>;
  constructor(
    private url: string,
    private token: string,
    private fetchImpl: typeof fetch = fetch,
    private cacheMs = 200,
  ) {}
  async latest() {
    const now = Date.now();
    if (this.cached && now - this.cached.at < this.cacheMs) return this.cached.value;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const response = await this.fetchImpl(this.url, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(500),
      });
      if (!response.ok) throw new Error(`hedge risk ${response.status}`);
      const value = (await response.json()) as HedgeRiskSnapshot;
      this.cached = { at: Date.now(), value };
      return value;
    })().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
}
