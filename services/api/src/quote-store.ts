import type { TradeIntent } from "../../../packages/shared/src/eip712.js";
import type { Quote } from "../../../packages/shared/src/policy.js";
import { ExpiryIndex } from "./bounded-state.js";

export type ProtocolVersions = {
  leaderEpoch: bigint;
  signerSetVersion: bigint;
  policyVersion: bigint;
  blockNumber: number;
  blockTimestamp: number;
};

export type OracleReport = { report: string; validUntil: number };

/** Firm quotes stay addressable for a grace period after expiry so late retries get a clean answer. */
const QUOTE_RETENTION_MS = 60_000;

/** In-memory firm-quote state, keyed by quote ID and pruned by expiry. */
export class QuoteStore {
  readonly quotes = new Map<string, Quote>();
  readonly reports = new Map<string, OracleReport>();
  readonly versions = new Map<string, ProtocolVersions>();
  /** The (account, nonce) a quote was first prepared for; later prepares must match. */
  readonly bindings = new Map<string, { account: string; nonce: string }>();
  readonly preparedIntents = new Map<string, TradeIntent>();
  /** Close quotes must settle reduce-only regardless of what the client asks for. */
  readonly forcedReduceOnly = new Set<string>();
  private readonly expiries = new ExpiryIndex();

  get size() {
    return this.quotes.size;
  }

  add(quote: Quote, versions?: ProtocolVersions) {
    this.quotes.set(quote.quoteId, quote);
    if (versions) this.versions.set(quote.quoteId, versions);
    this.expiries.schedule(quote.quoteId, quote.expiresAtMs + QUOTE_RETENTION_MS);
  }

  bind(quoteId: string, intent: TradeIntent, nonce = intent.nonce.toString()) {
    this.bindings.set(quoteId, { account: intent.account, nonce });
    this.preparedIntents.set(quoteId, intent);
  }

  prune(now = Date.now()) {
    for (const id of this.expiries.takeExpired(now)) {
      this.quotes.delete(id);
      this.reports.delete(id);
      this.versions.delete(id);
      this.bindings.delete(id);
      this.preparedIntents.delete(id);
      this.forcedReduceOnly.delete(id);
    }
  }
}
