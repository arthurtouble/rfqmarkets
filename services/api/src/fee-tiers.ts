import { getAddress } from "ethers";
import { FEE_TIERS, feeTierWindow } from "../../../packages/shared/src/fee-tiers.js";

/** Where an account's fee discount comes from. Any failure must resolve to 0 (the full fee). */
export interface FeeTierSource {
  discountBps(account: string): Promise<number>;
}

const FAILURE_RETRY_MS = 60_000;
const MAX_CACHED_ACCOUNTS = 10_000;

/**
 * Reads tiers from the indexer's `/v1/fees/:address`. Tiers only change at UTC midnight, so each account is
 * read once a day. Only the tier number is trusted: its discount comes from the local schedule, so a wrong
 * or hostile response can at most pick another published tier.
 */
export class HttpFeeTierSource implements FeeTierSource {
  private readonly cache = new Map<string, { discountBps: number; validUntilMs: number }>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 1_000,
    private readonly now = Date.now,
  ) {}

  async discountBps(account: string) {
    const key = getAddress(account),
      nowMs = this.now(),
      cached = this.cache.get(key);
    if (cached && cached.validUntilMs > nowMs) return cached.discountBps;
    let discountBps = 0,
      validUntilMs = nowMs + FAILURE_RETRY_MS;
    try {
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/v1/fees/${key}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.ok) {
        const body = (await response.json()) as { tier?: unknown; windowEndMs?: unknown };
        const tier = FEE_TIERS.find((candidate) => candidate.tier === body.tier);
        // The response must be for today's window; a stale indexer keeps the full fee.
        if (tier && body.windowEndMs === feeTierWindow(nowMs).endMs) {
          discountBps = tier.discountBps;
          validUntilMs = feeTierWindow(nowMs).endMs + 86_400_000;
        }
      }
    } catch {}
    if (this.cache.size >= MAX_CACHED_ACCOUNTS) this.cache.clear();
    this.cache.set(key, { discountBps, validUntilMs });
    return discountBps;
  }
}
