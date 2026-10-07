type Bucket = { tokens: number; updatedAtMs: number; lastSeenMs: number };

/** A bounded, in-process token bucket for cheap origin-side abuse control.
 * The edge remains responsible for distributed DDoS filtering. */
export class QuoteAdmission {
  private readonly clients = new Map<string, Bucket>();
  private global: Bucket;
  constructor(
    private readonly ratePerSecond = 40,
    private readonly burst = 100,
    private readonly maxClients = 10_000,
    private readonly globalRatePerSecond = 2_000,
    private readonly globalBurst = 4_000,
    now = Date.now(),
  ) {
    this.global = { tokens: globalBurst, updatedAtMs: now, lastSeenMs: now };
  }
  private take(bucket: Bucket, rate: number, capacity: number, now: number) {
    bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.updatedAtMs) * rate) / 1_000);
    bucket.updatedAtMs = now;
    bucket.lastSeenMs = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
  /** Checks the client's own bucket first so one throttled client cannot drain the shared
   * global bucket; the global token is charged only when the client itself is admitted. */
  allow(client: string, now = Date.now()) {
    let bucket = this.clients.get(client);
    if (!bucket) {
      if (this.clients.size >= this.maxClients) {
        const oldest = this.clients.keys().next().value;
        if (oldest !== undefined) this.clients.delete(oldest);
      }
      bucket = { tokens: this.burst, updatedAtMs: now, lastSeenMs: now };
      this.clients.set(client, bucket);
    } else {
      // Refresh insertion order so eviction approximates LRU without another index.
      this.clients.delete(client);
      this.clients.set(client, bucket);
    }
    if (!this.take(bucket, this.ratePerSecond, this.burst, now)) return false;
    if (this.take(this.global, this.globalRatePerSecond, this.globalBurst, now)) return true;
    // Refund the client token: the request was refused for global load, not the client's rate.
    bucket.tokens = Math.min(this.burst, bucket.tokens + 1);
    return false;
  }
  get clientCount() {
    return this.clients.size;
  }
}
