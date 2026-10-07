import { AbiCoder, TypedDataEncoder, getAddress, verifyTypedData, type BytesLike } from "ethers";
import { readSseEvents } from "./sse-events.js";

/**
 * RFQ Markets signed price oracle: the EIP-712 batch format signed by each oracle node and the
 * client-side aggregation that turns node batches into the report accepted by SignedPriceOracle.
 *
 * Prices are USDC micro-units (6 decimals) per one market unit.
 */

export const ORACLE_DOMAIN_NAME = "RFQ Markets Oracle";
export const ORACLE_DOMAIN_VERSION = "1";
/** Seconds a report stays valid after its oldest batch was observed. */
export const SIGNED_REPORT_TTL_SECONDS = 15;

export const priceBatchTypes: Record<string, Array<{ name: string; type: string }>> = {
  PriceBatch: [
    { name: "observedAt", type: "uint64" },
    { name: "prices", type: "Price[]" },
  ],
  Price: [
    { name: "market", type: "uint8" },
    { name: "bid", type: "uint256" },
    { name: "ask", type: "uint256" },
  ],
};

/** ABI type of the on-chain report: `abi.encode(SignedPriceBatch[])`. */
export const SIGNED_REPORT_ABI_TYPE =
  "tuple(uint64 observedAt,tuple(uint8 market,uint256 bid,uint256 ask)[] prices,bytes signature)[]";

export interface OracleDomainInput {
  chainId: bigint | number;
  verifyingContract: string;
}
export interface SignedPrice {
  market: number;
  bid: bigint;
  ask: bigint;
}
export interface PriceBatch {
  /** Unix seconds. */
  observedAt: number;
  /** Strictly ascending by market. */
  prices: SignedPrice[];
}
export interface SignedPriceBatch extends PriceBatch {
  /** 65-byte ECDSA signature over the EIP-712 digest, 0x-prefixed. */
  signature: string;
}
export interface TypedDataSigner {
  signTypedData(
    domain: ReturnType<typeof oracleDomain>,
    types: typeof priceBatchTypes,
    value: Record<string, unknown>,
  ): Promise<string>;
}

export function oracleDomain(domain: OracleDomainInput) {
  return {
    name: ORACLE_DOMAIN_NAME,
    version: ORACLE_DOMAIN_VERSION,
    chainId: BigInt(domain.chainId),
    verifyingContract: getAddress(domain.verifyingContract),
  };
}

const UINT64_MAX = (1n << 64n) - 1n;

/** Throws unless the batch satisfies the invariants the contract enforces. */
export function validatePriceBatch(batch: PriceBatch) {
  if (
    !Number.isSafeInteger(batch.observedAt) ||
    batch.observedAt <= 0 ||
    BigInt(batch.observedAt) > UINT64_MAX
  )
    throw new Error("invalid observedAt");
  let previous = -1;
  for (const price of batch.prices) {
    if (!Number.isInteger(price.market) || price.market < 0 || price.market > 255)
      throw new Error("invalid market");
    if (price.market <= previous) throw new Error("prices must be strictly ascending by market");
    previous = price.market;
    if (price.bid <= 0n || price.ask < price.bid)
      throw new Error(`invalid bid/ask for market ${price.market}`);
  }
}

/** The EIP-712 typed-data triple for a batch; `TypedDataEncoder.hash(...)` of it is the signed digest. */
export function priceBatchTypedData(domain: OracleDomainInput, batch: PriceBatch) {
  validatePriceBatch(batch);
  return {
    domain: oracleDomain(domain),
    types: priceBatchTypes,
    value: {
      observedAt: BigInt(batch.observedAt),
      prices: batch.prices.map((price) => ({ market: price.market, bid: price.bid, ask: price.ask })),
    },
  };
}

export function priceBatchDigest(domain: OracleDomainInput, batch: PriceBatch) {
  const typed = priceBatchTypedData(domain, batch);
  return TypedDataEncoder.hash(typed.domain, typed.types, typed.value);
}

export async function signPriceBatch(
  wallet: TypedDataSigner,
  domain: OracleDomainInput,
  batch: PriceBatch,
): Promise<SignedPriceBatch> {
  const typed = priceBatchTypedData(domain, batch);
  const signature = await wallet.signTypedData(typed.domain, typed.types, typed.value);
  return { observedAt: batch.observedAt, prices: batch.prices.map((price) => ({ ...price })), signature };
}

/** Recovers the checksummed signer of a batch; throws on a malformed batch or signature. */
export function recoverBatchSigner(domain: OracleDomainInput, batch: SignedPriceBatch) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(batch.signature)) throw new Error("signature must be 65 bytes");
  const typed = priceBatchTypedData(domain, batch);
  return getAddress(verifyTypedData(typed.domain, typed.types, typed.value, batch.signature));
}

export function encodeSignedReport(batches: readonly SignedPriceBatch[]): string {
  return AbiCoder.defaultAbiCoder().encode(
    [SIGNED_REPORT_ABI_TYPE],
    [
      batches.map((batch) => [
        batch.observedAt,
        batch.prices.map((price) => [price.market, price.bid, price.ask]),
        batch.signature,
      ]),
    ],
  );
}

export function decodeSignedReport(report: BytesLike): SignedPriceBatch[] {
  const [batches] = AbiCoder.defaultAbiCoder().decode([SIGNED_REPORT_ABI_TYPE], report);
  return (
    batches as Array<{
      observedAt: bigint;
      prices: Array<{ market: bigint; bid: bigint; ask: bigint }>;
      signature: string;
    }>
  ).map((batch) => ({
    observedAt: Number(batch.observedAt),
    prices: batch.prices.map((price) => ({
      market: Number(price.market),
      bid: BigInt(price.bid),
      ask: BigInt(price.ask),
    })),
    signature: batch.signature,
  }));
}

export interface CombineOptions {
  domain: OracleDomainInput;
  /** Authorized signer addresses. */
  signers: readonly string[];
  /** Minimum number of distinct signer batches per market (2 of 3 in production). */
  threshold: number;
  /** Maximum spread between the highest and lowest batch mid for a market, in bps of the lowest. */
  maxDeviationBps: number;
  /** Maximum difference between the oldest and newest chosen batch observedAt. */
  maxSkewSeconds: number;
  reportTtlSeconds?: number;
}
export interface ConsensusPrice {
  market: number;
  bid: bigint;
  ask: bigint;
  /** Number of chosen batches carrying this market. */
  signers: number;
}
export interface CombinedReport {
  /** Batches to encode, ascending by signer address. */
  batches: SignedPriceBatch[];
  signers: string[];
  prices: ConsensusPrice[];
  /** The oldest chosen observedAt. */
  observedAt: number;
  /** observedAt + report TTL (15 s). */
  validUntil: number;
}

/** Floor of the median; for an even count the two middle values are averaged. */
function median(values: bigint[], roundUp: boolean) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    middle = sorted.length >> 1;
  if (sorted.length % 2) return sorted[middle];
  const sum = sorted[middle - 1] + sorted[middle];
  return roundUp ? (sum + 1n) / 2n : sum / 2n;
}

/**
 * Combines node batches into a report. This mirrors the SignedPriceOracle verification rules:
 *
 * 1. Only batches with a valid signature from an authorized signer count; one batch per signer
 *    (the newest one this client holds). Batches are ordered strictly ascending by signer.
 * 2. All chosen batches lie within `maxSkewSeconds` of each other (the largest such window,
 *    preferring the newest when sizes tie), and there are at least `threshold` of them.
 * 3. Per market, the batches carrying it must number at least `threshold`, and their mids
 *    (floor((bid + ask) / 2)) must satisfy `(maxMid - minMid) * 10_000 <= minMid * maxDeviationBps`.
 *    A market failing either rule is left out of the consensus.
 * 4. The consensus bid is the median of those batches' bids and the ask the median of their asks.
 *    With an even count the two middle values are averaged, rounding the bid down and the ask up.
 * 5. validUntil = min(observedAt) + reportTtlSeconds.
 *
 * Returns undefined when no market reaches consensus.
 */
export function combineBatches(
  batches: readonly SignedPriceBatch[],
  options: CombineOptions,
): CombinedReport | undefined {
  if (!Number.isInteger(options.threshold) || options.threshold < 1) throw new Error("invalid threshold");
  const authorized = new Set(options.signers.map((signer) => getAddress(signer)));
  const newest = new Map<string, SignedPriceBatch>();
  for (const batch of batches) {
    let signer: string;
    try {
      signer = recoverBatchSigner(options.domain, batch);
    } catch {
      continue;
    }
    if (!authorized.has(signer)) continue;
    const held = newest.get(signer);
    if (!held || batch.observedAt > held.observedAt) newest.set(signer, batch);
  }
  const candidates = [...newest.entries()].sort(([, a], [, b]) => b.observedAt - a.observedAt);
  let window: Array<[string, SignedPriceBatch]> = [];
  for (let top = 0; top < candidates.length; top++) {
    const chosen = candidates.filter(
      ([, batch], index) =>
        index >= top && candidates[top][1].observedAt - batch.observedAt <= options.maxSkewSeconds,
    );
    if (chosen.length > window.length) window = chosen;
  }
  if (window.length < options.threshold) return undefined;
  window.sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1));

  const markets = new Set<number>();
  for (const [, batch] of window) for (const price of batch.prices) markets.add(price.market);
  const prices: ConsensusPrice[] = [];
  for (const market of [...markets].sort((a, b) => a - b)) {
    const quotes = window.flatMap(([, batch]) => batch.prices.filter((price) => price.market === market));
    if (quotes.length < options.threshold) continue;
    const mids = quotes.map((price) => (price.bid + price.ask) / 2n);
    let low = mids[0],
      high = mids[0];
    for (const mid of mids) {
      if (mid < low) low = mid;
      if (mid > high) high = mid;
    }
    if ((high - low) * 10_000n > low * BigInt(options.maxDeviationBps)) continue;
    prices.push({
      market,
      bid: median(
        quotes.map((price) => price.bid),
        false,
      ),
      ask: median(
        quotes.map((price) => price.ask),
        true,
      ),
      signers: quotes.length,
    });
  }
  if (!prices.length) return undefined;
  const observedAt = Math.min(...window.map(([, batch]) => batch.observedAt));
  return {
    batches: window.map(([, batch]) => batch),
    signers: window.map(([signer]) => signer),
    prices,
    observedAt,
    validUntil: observedAt + (options.reportTtlSeconds ?? SIGNED_REPORT_TTL_SECONDS),
  };
}

/** JSON shape served by oracle nodes at /v1/batch/latest and /v1/batch/stream. */
export interface PriceBatchWire {
  observedAt: number;
  prices: Array<{ market: number; symbol?: string; bid: string; ask: string; sources?: number }>;
  signature: string;
  signer: string;
  chainId?: string;
  verifyingContract?: string;
}

export function priceBatchToWire(
  batch: SignedPriceBatch,
  signer: string,
  extra: {
    symbols?: ReadonlyMap<number, string>;
    sources?: ReadonlyMap<number, number>;
    domain?: OracleDomainInput;
  } = {},
): PriceBatchWire {
  return {
    observedAt: batch.observedAt,
    prices: batch.prices.map((price) => ({
      market: price.market,
      ...(extra.symbols?.has(price.market) ? { symbol: extra.symbols.get(price.market) } : {}),
      bid: price.bid.toString(),
      ask: price.ask.toString(),
      ...(extra.sources?.has(price.market) ? { sources: extra.sources.get(price.market) } : {}),
    })),
    signature: batch.signature,
    signer,
    ...(extra.domain
      ? {
          chainId: BigInt(extra.domain.chainId).toString(),
          verifyingContract: getAddress(extra.domain.verifyingContract),
        }
      : {}),
  };
}

/** Parses a node batch; the signature is not checked here (combineBatches recovers it). */
export function priceBatchFromWire(value: unknown): SignedPriceBatch {
  const wire = value as PriceBatchWire;
  if (!wire || typeof wire !== "object" || !Array.isArray(wire.prices) || typeof wire.signature !== "string")
    throw new Error("malformed price batch");
  const integer = (text: unknown) => {
    if (typeof text !== "string" || !/^\d{1,78}$/.test(text)) throw new Error("malformed price");
    return BigInt(text);
  };
  const batch: SignedPriceBatch = {
    observedAt: Number(wire.observedAt),
    prices: wire.prices.map((price) => ({
      market: Number(price.market),
      bid: integer(price.bid),
      ask: integer(price.ask),
    })),
    signature: wire.signature,
  };
  validatePriceBatch(batch);
  return batch;
}

export interface SignedOracleClientOptions extends Omit<CombineOptions, "domain"> {
  domain: OracleDomainInput;
  /** Node base URLs, e.g. https://oracle-1.example.com */
  nodes: readonly string[];
  fetchImpl?: typeof fetch;
  /** Delay before reconnecting a failed stream; a REST poll of /v1/batch/latest runs meanwhile. */
  reconnectMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}
export interface SignedOracleSnapshot {
  report: string;
  prices: ConsensusPrice[];
  signers: string[];
  observedAt: number;
  validUntil: number;
}
export interface SignedOracleNodeStatus {
  node: string;
  transport: "sse" | "rest" | "down";
  observedAt: number | null;
  rejected: number;
}

/**
 * Subscribes to every node's batch stream (falling back to REST polling while a stream is down)
 * and combines the newest batch of each node into an on-chain report.
 */
export class SignedOracleClient {
  private batches = new Map<string, SignedPriceBatch>();
  private nodes: Map<string, SignedOracleNodeStatus>;
  private abort?: AbortController;
  private tasks: Promise<void>[] = [];
  private listeners = new Set<() => void>();
  constructor(private options: SignedOracleClientOptions) {
    if (!options.nodes.length) throw new Error("at least one oracle node is required");
    this.nodes = new Map(
      options.nodes.map((node) => [node, { node, transport: "down", observedAt: null, rejected: 0 }]),
    );
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private fetch(url: string, init: RequestInit) {
    return (this.options.fetchImpl ?? fetch)(url, init);
  }
  /** Accepts a batch from a node; batches from unknown signers or with bad signatures are dropped. */
  accept(node: string, value: unknown) {
    const status = this.nodes.get(node);
    if (!status) return false;
    try {
      const batch = priceBatchFromWire(value),
        signer = recoverBatchSigner(this.options.domain, batch);
      if (!this.options.signers.some((allowed) => getAddress(allowed) === signer))
        throw new Error("unknown signer");
      const held = this.batches.get(node);
      if (held && held.observedAt >= batch.observedAt) return false;
      this.batches.set(node, batch);
      status.observedAt = batch.observedAt;
    } catch {
      status.rejected++;
      return false;
    }
    for (const listener of this.listeners)
      try {
        listener();
      } catch {
        // A failing listener must not stop the stream.
      }
    return true;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** The combined report, or undefined when there is no consensus or it has expired. */
  latest(): SignedOracleSnapshot | undefined {
    const combined = combineBatches([...this.batches.values()], this.options);
    if (!combined || combined.validUntil * 1_000 <= this.now()) return undefined;
    return {
      report: encodeSignedReport(combined.batches),
      prices: combined.prices,
      signers: combined.signers,
      observedAt: combined.observedAt,
      validUntil: combined.validUntil,
    };
  }
  status() {
    return [...this.nodes.values()].map((status) => ({ ...status }));
  }
  /** Fetches /v1/batch/latest from every node once. */
  async poll() {
    await Promise.all(this.options.nodes.map((node) => this.pollNode(node)));
  }
  private async pollNode(node: string, signal?: AbortSignal) {
    try {
      const response = await this.fetch(`${node.replace(/\/$/, "")}/v1/batch/latest`, {
        headers: { accept: "application/json" },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs ?? 2_000)])
          : AbortSignal.timeout(this.options.requestTimeoutMs ?? 2_000),
      });
      if (!response.ok) return false;
      this.accept(node, await response.json());
      return true;
    } catch {
      return false;
    }
  }
  private async streamNode(node: string, signal: AbortSignal) {
    const status = this.nodes.get(node)!;
    const response = await this.fetch(`${node.replace(/\/$/, "")}/v1/batch/stream`, {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`oracle node stream returned ${response.status}`);
    status.transport = "sse";
    for await (const event of readSseEvents(response.body)) {
      if (signal.aborted) return;
      if (event.event !== "batch") continue;
      try {
        this.accept(node, JSON.parse(event.data));
      } catch {
        status.rejected++;
      }
    }
  }
  async start() {
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        abort.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    this.tasks = this.options.nodes.map(async (node) => {
      const status = this.nodes.get(node)!;
      while (!abort.signal.aborted) {
        try {
          await this.streamNode(node, abort.signal);
        } catch {
          // Fall through to the REST fallback.
        }
        if (abort.signal.aborted) break;
        status.transport = (await this.pollNode(node, abort.signal)) ? "rest" : "down";
        await sleep(this.options.reconnectMs ?? 1_000);
      }
    });
    // Seed every node immediately so a report is available before the first stream event.
    await Promise.all(this.options.nodes.map((node) => this.pollNode(node, abort.signal)));
  }
  async close() {
    this.abort?.abort();
    this.abort = undefined;
    await Promise.all(this.tasks);
    this.tasks = [];
  }
}
