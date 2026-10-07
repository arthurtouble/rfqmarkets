import { BASE, RATE, USDC, abs, ceilDiv } from "./numeric.js";
import { marketRegistry, type Market } from "./markets.js";

export { BASE, RATE, USDC, ceilDiv } from "./numeric.js";
export type { Market } from "./markets.js";

/**
 * A market's inventory-impact coefficient, as registered on chain (`marketParams(id).impactK`, kept in
 * the market registry). The charge is per market: there is no cross-market term.
 */
export const impactK = (market: Market) => marketRegistry.get(market).impactK;
/** Settled maker inventory notional per market; a market with no entry has none. */
export type Exposure = Partial<Record<Market, bigint>>;
export type QuoteRequest = {
  market: Market;
  side: "buy" | "sell";
  amount: string;
  /** Price protection the intent's limit price allows beyond the expected price; defaults to `toleranceBps`. */
  slippageBps?: number;
};
/** Bounds for a caller-chosen market-order slippage tolerance. */
export const MIN_SLIPPAGE_BPS = 1;
export const MAX_SLIPPAGE_BPS = 500;

export function parseUsdc(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * USDC + BigInt((fraction + "000000").slice(0, 6));
}
export function formatUsdc(value: bigint): string {
  const sign = value < 0n ? "-" : "",
    absolute = abs(value);
  return `${sign}${absolute / USDC}.${(absolute % USDC).toString().padStart(6, "0")}`;
}
function floorDiv(numerator: bigint, denominator: bigint): bigint {
  let quotient = numerator / denominator;
  if (numerator < 0n && numerator % denominator !== 0n) quotient -= 1n;
  return quotient;
}
/** One market's impact potential: floor(k * skew^2 / (2 * RATE * 1e6)), as `RFQRiskMath.potential`. */
export function marketPotential(impactK: bigint, skew: bigint): bigint {
  return floorDiv(impactK * skew * skew, 2n * RATE * USDC);
}
export function potential(exposure: Exposure): bigint {
  let total = 0n;
  for (const [market, skew] of Object.entries(exposure))
    total += marketPotential(impactK(market), skew ?? 0n);
  return total;
}
/** Mirrors `RFQRiskMath.impactCost(impactK, skew, delta)` for the market being traded. */
export function impactCost(exposure: Exposure, market: Market, delta: bigint): bigint {
  const skew = exposure[market] ?? 0n,
    k = impactK(market);
  return marketPotential(k, skew + delta) - marketPotential(k, skew);
}
/**
 * The greatest impact charge over every subset of pending reservations that may settle first. The
 * charge depends only on the traded market's skew, so the extremes are its settled skew plus all
 * pending sells or plus all pending buys.
 */
export function requiredPendingImpact(
  settled: Exposure,
  pending: Array<{ market: Market; delta: bigint }>,
  market: Market,
  delta: bigint,
): bigint {
  const settledSkew = settled[market] ?? 0n;
  let low = settledSkew,
    high = settledSkew;
  for (const item of pending) {
    if (item.market !== market) continue;
    if (item.delta < 0n) low += item.delta;
    else high += item.delta;
  }
  const lowCost = impactCost({ [market]: low }, market, delta),
    highCost = impactCost({ [market]: high }, market, delta);
  return lowCost > highCost ? lowCost : highCost;
}
export interface PriceSnapshot {
  market: Market;
  bid: bigint;
  ask: bigint;
  observedAtMs: number;
  source?: string;
  volatilityBps?: number;
  volatility?: { fastBps: number; mediumBps: number; slowBps: number; jumpBps: number; sampleCount: number };
}
export interface SpreadBreakdown {
  baseBps: bigint;
  volatilityBps: bigint;
  toxicityBps: bigint;
  hedgeBps: bigint;
  basisBps: bigint;
  uncertaintyBps: bigint;
  totalBps: bigint;
  modelVersion: string;
}
export interface AdaptiveSpreadInputs {
  baseBps?: number;
  volatilityBps?: number;
  toxicityScoreBps?: number;
  hedgeCostBps?: number;
  hedgeLatencyMs?: number;
  venueBasisBps?: number;
  confidenceBps?: number;
  riskMode?: "normal" | "guarded" | "reduce_only";
  maxTotalBps?: number;
}
export interface Quote {
  quoteId: string;
  market: Market;
  side: "buy" | "sell";
  notional: bigint;
  delta: bigint;
  baseDelta: bigint;
  expectedPrice: bigint;
  worstPrice: bigint;
  fee: bigint;
  impactCharge: bigint;
  spread?: SpreadBreakdown;
  expiresAtMs: number;
  snapshot: PriceSnapshot;
}
export interface PricingParameters {
  maxNotional: bigint;
  baseSpreadBps: bigint;
  feeBps: bigint;
  toleranceBps: bigint;
  maxSnapshotAgeMs?: number;
  quoteLifetimeMs?: number;
  spread?: SpreadBreakdown;
}
export const launchPricing: PricingParameters = {
  maxNotional: 25_000n * USDC,
  baseSpreadBps: 2n,
  feeBps: 2n,
  toleranceBps: 8n,
};
const bounded = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
const bps = (value: number) => BigInt(Math.ceil(Math.max(0, value)));
/** Deterministic market-wide quote-risk decomposition. */
export function adaptiveSpread(inputs: AdaptiveSpreadInputs = {}): SpreadBreakdown {
  const baseBps = bps(bounded(inputs.baseBps ?? 2, 1, 20));
  const observedVol = bounded(inputs.volatilityBps ?? 0, 0, 2_000);
  const volatilityBps = bps(Math.min(40, observedVol / 5));
  const toxicityBps = bps(Math.min(35, (bounded(inputs.toxicityScoreBps ?? 0, 0, 10_000) * 35) / 10_000));
  const hedgeCost = bounded(inputs.hedgeCostBps ?? 0, 0, 50),
    latency = bounded(inputs.hedgeLatencyMs ?? 0, 0, 30_000);
  const hedgeMode = inputs.riskMode === "guarded" ? 4 : inputs.riskMode === "reduce_only" ? 12 : 0;
  const hedgeBps = bps(Math.min(30, hedgeCost + hedgeMode + (Math.sqrt(latency / 1_000) * observedVol) / 25));
  const basisBps = bps(Math.min(25, Math.abs(bounded(inputs.venueBasisBps ?? 0, -500, 500))));
  const uncertaintyBps = bps(Math.min(20, bounded(inputs.confidenceBps ?? 0, 0, 500) / 2));
  const uncapped = baseBps + volatilityBps + toxicityBps + hedgeBps + basisBps + uncertaintyBps;
  const cap = BigInt(inputs.maxTotalBps ?? 100),
    totalBps = uncapped > cap ? cap : uncapped;
  return {
    baseBps,
    volatilityBps,
    toxicityBps,
    hedgeBps,
    basisBps,
    uncertaintyBps,
    totalBps,
    modelVersion: QUOTE_MODEL_VERSION,
  };
}
/** Spread model the leader quotes with; approvers reject quotes from any other model. */
export const QUOTE_MODEL_VERSION = "adaptive-v1";
export function marginRate(notional: bigint, initial: boolean) {
  if (notional <= 25_000n * USDC) return initial ? 2_000n : 1_200n;
  if (notional <= 100_000n * USDC) return initial ? 2_500n : 1_500n;
  if (notional <= 250_000n * USDC) return initial ? 3_300n : 2_000n;
  if (notional <= 1_000_000n * USDC) return initial ? 5_000n : 3_000n;
  if (notional <= 2_500_000n * USDC) return initial ? 6_700n : 4_000n;
  // Matches RFQRiskMath.marginRate: the top tier also applies above 5M notional.
  return initial ? 10_000n : 6_000n;
}
/** Base tiers of `RFQRiskMath.marginRate`: notional ceiling (USDC units) and initial/maintenance bps. */
export const MARGIN_TIERS = [
  { maxNotional: 25_000n * USDC, initialBps: 2_000n, maintenanceBps: 1_200n },
  { maxNotional: 100_000n * USDC, initialBps: 2_500n, maintenanceBps: 1_500n },
  { maxNotional: 250_000n * USDC, initialBps: 3_300n, maintenanceBps: 2_000n },
  { maxNotional: 1_000_000n * USDC, initialBps: 5_000n, maintenanceBps: 3_000n },
  { maxNotional: 2_500_000n * USDC, initialBps: 6_700n, maintenanceBps: 4_000n },
  { maxNotional: undefined, initialBps: 10_000n, maintenanceBps: 6_000n },
] as const;
/** Per-market margin multiplier of the base tiers (`marketParams(id).marginScaleBps`); 10_000 = 1x. */
export const DEFAULT_MARGIN_SCALE_BPS = 10_000;
export const MIN_MARGIN_SCALE_BPS = 2_500;
export const MAX_MARGIN_SCALE_BPS = 50_000;
/** Mirrors `RFQRiskMath.scaledMarginRate`: the base tier rate times the market multiplier, capped at 100%. */
export function scaledMarginRate(notional: bigint, initial: boolean, scaleBps: bigint | number) {
  const rate = (marginRate(notional, initial) * BigInt(scaleBps)) / 10_000n;
  return rate < 10_000n ? rate : 10_000n;
}
/** Margin a leg of `notional` requires, as `RFQRiskMath.accountMargin` adds it per leg. */
export function legMargin(notional: bigint, initial: boolean, scaleBps: bigint | number) {
  return (notional * scaledMarginRate(notional, initial, scaleBps)) / 10_000n;
}
/** Leverage the first tier's scaled initial margin allows, rounded down to 0.01x (20 at 2_500). */
export function maxLeverage(scaleBps: bigint | number) {
  return Number(1_000_000n / scaledMarginRate(0n, true, scaleBps)) / 100;
}
/** The margin parameters a client needs to show leverage presets for one market. */
export function marketMarginView(scaleBps: bigint | number) {
  return {
    marginScaleBps: Number(scaleBps),
    maxLeverage: maxLeverage(scaleBps),
    initialMarginBps: Number(scaledMarginRate(0n, true, scaleBps)),
    maintenanceMarginBps: Number(scaledMarginRate(0n, false, scaleBps)),
  };
}
export function constructQuote(
  request: QuoteRequest,
  snapshot: PriceSnapshot,
  settled: Exposure,
  pending: Array<{ market: Market; delta: bigint }>,
  nowMs = Date.now(),
  quoteId = crypto.randomUUID(),
  parameters: PricingParameters = launchPricing,
  exactBaseDelta?: bigint,
): Quote {
  if (nowMs - snapshot.observedAtMs > (parameters.maxSnapshotAgeMs ?? 2_000))
    throw new Error("oracle snapshot is stale");
  const mid = (snapshot.bid + snapshot.ask) / 2n,
    requested = parseUsdc(request.amount),
    baseDelta =
      exactBaseDelta ?? (request.side === "buy" ? (requested * BASE) / mid : (-requested * BASE) / mid);
  if (baseDelta === 0n || baseDelta > 0n !== (request.side === "buy"))
    throw new Error("invalid exact base direction");
  const absoluteBase = abs(baseDelta),
    notional = exactBaseDelta === undefined ? requested : (absoluteBase * mid) / BASE;
  if (notional <= 0n || notional > parameters.maxNotional) throw new Error("amount exceeds market limit");
  const delta = baseDelta > 0n ? notional : -notional,
    rawImpact = requiredPendingImpact(settled, pending, request.market, delta),
    impactCharge = rawImpact > 0n ? rawImpact : 0n,
    spread = parameters.spread,
    spreadBps = spread?.totalBps ?? parameters.baseSpreadBps,
    baseSpread = ceilDiv(notional * spreadBps, 10_000n),
    fee = ceilDiv(notional * parameters.feeBps, 10_000n),
    anchor = request.side === "buy" ? snapshot.ask : snapshot.bid,
    premium = ceilDiv(anchor * (baseSpread + impactCharge), notional),
    expectedPrice = request.side === "buy" ? anchor + premium : anchor - premium,
    toleranceBps = request.slippageBps === undefined ? parameters.toleranceBps : BigInt(request.slippageBps),
    tolerance = ceilDiv(expectedPrice * toleranceBps, 10_000n),
    worstPrice = request.side === "buy" ? expectedPrice + tolerance : expectedPrice - tolerance;
  return {
    quoteId,
    market: request.market,
    side: request.side,
    notional,
    delta,
    baseDelta,
    expectedPrice,
    worstPrice,
    fee,
    impactCharge,
    spread,
    expiresAtMs: nowMs + (parameters.quoteLifetimeMs ?? 30_000),
    snapshot,
  };
}
