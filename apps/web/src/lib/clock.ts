// The server's clock as this client sees it. Prices, oracle reports and firm
// quotes carry server timestamps; comparing them with Date.now() would block
// trading (or loop re-quoting) whenever the device clock runs a few seconds
// off. The market stream stamps every snapshot with serverTimeMs, so the skew
// is measured from those and Date.now() is corrected by it.
//
// Pure apart from the shared `serverClock` instance, so clock.test.ts runs it under Node.

/** Snapshots kept for the estimate; old ones age out so a corrected device clock is picked up. */
const SKEW_SAMPLES = 30;

/**
 * Estimates server time minus local time. Each sample is `serverTimeMs - receivedAtMs`, which is the true
 * skew less the time the snapshot spent in transit, so the largest recent sample is the best estimate.
 */
export class ClockSkew {
  private samples: number[] = [];
  constructor(private readonly keep = SKEW_SAMPLES) {}

  /** Records a snapshot stamped `serverTimeMs` by the server and received at `receivedAtMs` on this device. */
  observe(serverTimeMs: number | undefined, receivedAtMs: number) {
    if (typeof serverTimeMs !== "number" || !Number.isFinite(serverTimeMs) || serverTimeMs <= 0) return;
    this.samples.push(serverTimeMs - receivedAtMs);
    if (this.samples.length > this.keep) this.samples.splice(0, this.samples.length - this.keep);
  }

  /** Server time minus local time, in ms; 0 until a snapshot has been seen. */
  get skewMs() {
    return this.samples.length ? Math.max(...this.samples) : 0;
  }

  /** The server's time now, by this device's clock corrected for the skew. */
  now(localNowMs = Date.now()) {
    return localNowMs + this.skewMs;
  }

  reset() {
    this.samples = [];
  }
}

/** The app's one estimate, fed by the market stream (data/market-feed.tsx). */
export const serverClock = new ClockSkew();

/**
 * A firm quote as this client holds it: judged by when it arrived (local clock) plus the time it had left by
 * the server's clock then, so later skew corrections or a wrong device clock never make it look expired early.
 */
export type HeldQuote<Q extends { expiresAtMs: number }> = Q & { localDeadlineMs: number };

export function holdQuote<Q extends { expiresAtMs: number }>(
  quote: Q,
  receivedAtMs = Date.now(),
  clock: Pick<ClockSkew, "now"> = serverClock,
): HeldQuote<Q> {
  const timeToLive = quote.expiresAtMs - clock.now(receivedAtMs);
  return { ...quote, localDeadlineMs: receivedAtMs + timeToLive };
}

/** The local-clock deadline of a quote: its held deadline, else its server expiry moved onto this clock. */
export const localDeadline = (
  quote: { expiresAtMs: number; localDeadlineMs?: number },
  clock: Pick<ClockSkew, "skewMs"> = serverClock,
) => quote.localDeadlineMs ?? quote.expiresAtMs - clock.skewMs;

/**
 * Spaces out automatic re-quotes: at least `minMs` apart, doubling after each failure (or each quote that
 * arrived already unusable) up to `maxMs`, and giving up after `maxAttempts` in a row until the person retries.
 */
export class RequoteBackoff {
  private failures = 0;
  private lastAt = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly minMs = 2_000,
    private readonly maxMs = 15_000,
    private readonly maxAttempts = 4,
  ) {}

  /** Ms to wait before the next automatic request may go, or null once automatic retries have given up. */
  delay(nowMs: number): number | null {
    if (this.failures >= this.maxAttempts) return null;
    const spacing = Math.min(this.maxMs, this.minMs * 2 ** this.failures);
    return Math.max(0, this.lastAt + spacing - nowMs);
  }

  /** Records that a request went out at `nowMs`. */
  sent(nowMs: number) {
    this.lastAt = nowMs;
  }

  /** The request failed, or its quote was unusable on arrival. */
  failed() {
    this.failures += 1;
  }

  /** A usable quote arrived. */
  succeeded() {
    this.failures = 0;
  }

  /** The person asked again: start over. */
  reset() {
    this.failures = 0;
    this.lastAt = Number.NEGATIVE_INFINITY;
  }

  get exhausted() {
    return this.failures >= this.maxAttempts;
  }
}
