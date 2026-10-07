import type { PriceBatchWire } from "../../../packages/shared/src/signed-oracle.js";

/**
 * Recent signed batches in memory, ascending by observedAt, so a collector (the Cloudflare Durable
 * Object that owns this node) can pull everything it missed since its last sync. Bounded by age and
 * by count; durable history lives with the collector, not here.
 */
export class BatchHistory {
  private batches: PriceBatchWire[] = [];
  private head = 0;
  constructor(
    readonly retentionSeconds = 15 * 60,
    readonly maxBatches = 2 * 15 * 60,
  ) {}

  get size() {
    return this.batches.length - this.head;
  }

  push(batch: PriceBatchWire) {
    const last = this.batches.at(-1);
    if (this.size && last && batch.observedAt <= last.observedAt) return; // strictly ascending
    this.batches.push(batch);
    const oldest = batch.observedAt - this.retentionSeconds;
    while (this.size > this.maxBatches || (this.size && this.batches[this.head].observedAt <= oldest))
      this.head++;
    // Compact occasionally instead of shifting on every push.
    if (this.head > 1_024 && this.head * 2 > this.batches.length) {
      this.batches = this.batches.slice(this.head);
      this.head = 0;
    }
  }

  /** Up to `limit` batches with observedAt > `after`, ascending. */
  after(after: number, limit: number): PriceBatchWire[] {
    let low = this.head,
      high = this.batches.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.batches[middle].observedAt <= after) low = middle + 1;
      else high = middle;
    }
    return this.batches.slice(low, low + Math.max(0, limit));
  }

  oldest() {
    return this.size ? this.batches[this.head].observedAt : null;
  }
}
