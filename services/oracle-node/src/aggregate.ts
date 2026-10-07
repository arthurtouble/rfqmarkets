import { PRICE_SCALE, absDiff, medianOf, toMicroCeil, toMicroFloor } from "./decimal.js";
import type { ExchangeName, Instrument, QuoteCurrency, SymbolInstruments } from "./symbols.js";

/** One venue's quote, as 18-decimal prices (USD per market unit once converted). */
export interface SourceQuote {
  source: string;
  bid: bigint;
  ask: bigint;
  /** When the quote was last known to be current. */
  asOfMs: number;
}

export interface AggregationConfig {
  /** Sources older than this are dropped. */
  maxAgeMs: number;
  /** Sources whose mid is further than this from the median are dropped. */
  maxDeviationBps: number;
  /** Minimum sources left after filtering; otherwise the market is omitted. */
  minSources: number;
  /** Maximum signed width (ask - bid) relative to the mid; the contract caps it at 100 bps. */
  maxWidthBps: number;
}
export const DEFAULT_AGGREGATION: AggregationConfig = {
  maxAgeMs: 2_000,
  maxDeviationBps: 50,
  minSources: 3,
  maxWidthBps: 100,
};

export type AggregationResult =
  | {
      ok: true;
      /** USDC micro-units per market unit, rounded outward. */
      bid: bigint;
      ask: bigint;
      /** 18-decimal median mid. */
      median: bigint;
      sources: string[];
    }
  | { ok: false; reason: "insufficient-sources" | "too-wide"; sources: string[] };

const mid = (quote: { bid: bigint; ask: bigint }) => (quote.bid + quote.ask) / 2n;
const validQuote = (quote: SourceQuote) => quote.bid > 0n && quote.ask >= quote.bid;

/**
 * Filtered median of venue mids:
 * 1. drop invalid quotes and quotes older than maxAgeMs;
 * 2. median of mids; drop sources more than maxDeviationBps from it; recompute the median;
 * 3. require minSources survivors;
 * 4. half-spread = max |mid_i - median| over survivors; bid/ask = median -/+ half, rounded outward
 *    to micro-units;
 * 5. omit the market if (ask - bid) * 10_000 > mid * maxWidthBps (mid = floor((bid + ask) / 2)).
 */
export function aggregateMarket(
  quotes: readonly SourceQuote[],
  nowMs: number,
  config: AggregationConfig = DEFAULT_AGGREGATION,
): AggregationResult {
  const fresh = quotes.filter((quote) => validQuote(quote) && nowMs - quote.asOfMs <= config.maxAgeMs);
  if (fresh.length < config.minSources)
    return { ok: false, reason: "insufficient-sources", sources: fresh.map((quote) => quote.source) };
  const first = medianOf(fresh.map(mid)),
    kept = fresh.filter(
      (quote) => absDiff(mid(quote), first) * 10_000n <= first * BigInt(config.maxDeviationBps),
    );
  const sources = kept.map((quote) => quote.source);
  if (kept.length < config.minSources) return { ok: false, reason: "insufficient-sources", sources };
  const median = medianOf(kept.map(mid));
  let half = 0n;
  for (const quote of kept) {
    const distance = absDiff(mid(quote), median);
    if (distance > half) half = distance;
  }
  const bid = toMicroFloor(median - half),
    ask = toMicroCeil(median + half);
  if (bid <= 0n) return { ok: false, reason: "too-wide", sources };
  if ((ask - bid) * 10_000n > ((bid + ask) / 2n) * BigInt(config.maxWidthBps))
    return { ok: false, reason: "too-wide", sources };
  return { ok: true, bid, ask, median, sources };
}

export interface StableConfig {
  maxAgeMs: number;
  /** Minimum fresh stablecoin/USD sources for a rate. */
  minSources: number;
  /** A rate further than this from 1.0 is rejected (fail closed). */
  maxDepegBps: number;
  /** USDC pairs count as USD while USDC/USD is within this many bps of 1.0. */
  usdcParBps: number;
}
export const DEFAULT_STABLE: StableConfig = {
  maxAgeMs: 2_000,
  minSources: 2,
  maxDepegBps: 500,
  usdcParBps: 10,
};

/** Median USD price of a stablecoin from its fresh USD pairs, or undefined when unavailable. */
export function stableRate(
  quotes: readonly SourceQuote[],
  nowMs: number,
  config: StableConfig = DEFAULT_STABLE,
) {
  const fresh = quotes.filter((quote) => validQuote(quote) && nowMs - quote.asOfMs <= config.maxAgeMs);
  if (!fresh.length || fresh.length < config.minSources) return undefined;
  const rate = medianOf(fresh.map(mid));
  if (absDiff(rate, PRICE_SCALE) * 10_000n > PRICE_SCALE * BigInt(config.maxDepegBps)) return undefined;
  return rate;
}

export type StableRates = Partial<Record<"USDT" | "USDC", bigint>>;

/** Converts a quote in `currency` to USD; undefined when the needed rate is unavailable. */
export function toUsd(
  quote: SourceQuote,
  currency: QuoteCurrency,
  rates: StableRates,
  usdcParBps = DEFAULT_STABLE.usdcParBps,
): SourceQuote | undefined {
  if (currency === "USD") return quote;
  const rate = rates[currency];
  if (rate === undefined) return undefined;
  if (currency === "USDC" && absDiff(rate, PRICE_SCALE) * 10_000n <= PRICE_SCALE * BigInt(usdcParBps))
    return quote;
  return {
    ...quote,
    bid: (quote.bid * rate) / PRICE_SCALE,
    ask: (quote.ask * rate + PRICE_SCALE - 1n) / PRICE_SCALE,
  };
}

export type QuoteLookup = (
  exchange: ExchangeName,
  ticker: string,
) => { bid: bigint; ask: bigint; asOfMs: number } | undefined;

/** Collects a symbol's venue quotes in USD per market unit (lot multiplier applied). */
export function marketQuotes(
  resolved: SymbolInstruments,
  lookup: QuoteLookup,
  rates: StableRates,
  usdcParBps = DEFAULT_STABLE.usdcParBps,
): SourceQuote[] {
  const quotes: SourceQuote[] = [];
  for (const instrument of resolved.instruments) {
    const raw = lookup(instrument.exchange, instrument.ticker);
    if (!raw) continue;
    const usd = toUsd(
      { source: instrument.exchange, bid: raw.bid, ask: raw.ask, asOfMs: raw.asOfMs },
      instrument.quote,
      rates,
      usdcParBps,
    );
    if (usd) quotes.push({ ...usd, bid: usd.bid * resolved.multiplier, ask: usd.ask * resolved.multiplier });
  }
  return quotes;
}

/** Stablecoin/USD quotes for the rate computation. */
export function stableQuotes(instruments: readonly Instrument[], lookup: QuoteLookup): SourceQuote[] {
  const quotes: SourceQuote[] = [];
  for (const instrument of instruments) {
    const raw = lookup(instrument.exchange, instrument.ticker);
    if (raw) quotes.push({ source: instrument.exchange, bid: raw.bid, ask: raw.ask, asOfMs: raw.asOfMs });
  }
  return quotes;
}
