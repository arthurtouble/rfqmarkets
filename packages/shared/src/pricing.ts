import type { RiskMode } from "./api-types.js";
import { BASE, RATE, USDC, abs, ceilDiv } from "./numeric.js";
import { baseSpreadOf, DEFAULT_BASE_SPREAD_BPS, marketRegistry, type Market } from "./markets.js";

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
  /** The trading account, when known. Quotes are the same for every account. */
  account?: string;
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
/** The adaptive spread by component, each in tenths of a bp (`SPREAD_UNITS_PER_BPS`) since adaptive-v3. */
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
  riskMode?: RiskMode;
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
  /** Inventory charge in USDC micro; negative is a rebate for a trade that reduces the maker's inventory. */
  impactCharge: bigint;
  spread?: SpreadBreakdown;
  expiresAtMs: number;
  snapshot: PriceSnapshot;
}
export interface PricingParameters {
  maxNotional: bigint;
  /** Whole-bps spread over the mid, used only when there is no adaptive `spread`. */
  baseSpreadBps: bigint;
  feeBps: bigint;
  toleranceBps: bigint;
  maxSnapshotAgeMs?: number;
  quoteLifetimeMs?: number;
  spread?: SpreadBreakdown;
}
/**
 * The platform's share of every fill's trading fee, in bps of notional. Insurance takes its share of the
 * whole fee on chain (`RFQSettlement.chargeFee`); nothing else moves to insurance on a fill.
 */
export const PLATFORM_MARKUP_BPS = 2n;
/**
 * The trading fee a market charges, in bps of notional: its on-chain base spread (`marketSpread(id)`,
 * else `defaultSpread()`, else 2 bps) plus the platform's 2 bps. It is charged as an explicit fee, not
 * in the price, so a small trade in a calm market fills at the oracle mid and pays only this fee.
 * Approvers require the fee plus any price premium to reach it.
 */
export const tradingFeeBps = (market?: Market) =>
  BigInt(
    market !== undefined && marketRegistry.has(market)
      ? baseSpreadOf(marketRegistry.get(market))
      : DEFAULT_BASE_SPREAD_BPS,
  ) + PLATFORM_MARKUP_BPS;
/** The fee of a market without its own base spread: 4 bps (0.04%). */
export const DEFAULT_TRADING_FEE_BPS = BigInt(DEFAULT_BASE_SPREAD_BPS) + PLATFORM_MARKUP_BPS;
export const launchPricing: PricingParameters = {
  maxNotional: 25_000n * USDC,
  // No fixed spread: the price premium comes only from the adaptive model and the inventory charge.
  baseSpreadBps: 0n,
  feeBps: DEFAULT_TRADING_FEE_BPS,
  toleranceBps: 8n,
};
const bounded = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
/**
 * Spread components and totals are in tenths of a bp from adaptive-v3 on (the fields keep their `Bps`
 * names), so the price moves in 0.1 bp steps, about $1 on BTC at $100k, instead of whole bps.
 */
export const SPREAD_UNITS_PER_BPS = 10n;
/** `value` bps in spread units (tenths of a bp), rounded up; the epsilon keeps float noise from adding a unit. */
export const toSpreadUnits = (value: number) =>
  BigInt(Math.max(0, Math.ceil(Math.max(0, value) * 10 - 1e-9)));
/** Nearest spread unit (half up): volatility moves the price by its own size, not up to the next step. */
const nearestUnits = (value: number) => BigInt(Math.floor(Math.max(0, value) * 10 + 0.5));
/** The charge a spread of `units` (tenths of a bp) takes from `notional`, rounded up. */
export const spreadChargeOf = (notional: bigint, units: bigint) =>
  ceilDiv(notional * units, 10_000n * SPREAD_UNITS_PER_BPS);
/**
 * Deterministic market-wide quote-risk decomposition: the spread over the oracle mid, before the
 * size-dependent inventory charge, in tenths of a bp. There is no fixed base: the market's base spread
 * is charged as the trading fee (`tradingFeeBps`), so `baseBps` is zero unless a caller sets a
 * per-market minimum (at most 50 bps).
 */
export function adaptiveSpread(inputs: AdaptiveSpreadInputs = {}): SpreadBreakdown {
  const baseBps = toSpreadUnits(bounded(inputs.baseBps ?? 0, 0, 50));
  const observedVol = bounded(inputs.volatilityBps ?? 0, 0, 2_000);
  const volatilityBps = nearestUnits(Math.min(40, observedVol / 5));
  const toxicityBps = toSpreadUnits(
    Math.min(35, (bounded(inputs.toxicityScoreBps ?? 0, 0, 10_000) * 35) / 10_000),
  );
  const hedgeCost = bounded(inputs.hedgeCostBps ?? 0, 0, 50),
    latency = bounded(inputs.hedgeLatencyMs ?? 0, 0, 30_000);
  const hedgeMode = inputs.riskMode === "guarded" ? 4 : inputs.riskMode === "reduce_only" ? 12 : 0;
  const hedgeBps = toSpreadUnits(
    Math.min(30, hedgeCost + hedgeMode + (Math.sqrt(latency / 1_000) * observedVol) / 25),
  );
  const basisBps = toSpreadUnits(Math.min(25, Math.abs(bounded(inputs.venueBasisBps ?? 0, -500, 500))));
  const uncertaintyBps = toSpreadUnits(Math.min(20, bounded(inputs.confidenceBps ?? 0, 0, 500) / 2));
  const uncapped = baseBps + volatilityBps + toxicityBps + hedgeBps + basisBps + uncertaintyBps;
  const cap = BigInt(inputs.maxTotalBps ?? 100) * SPREAD_UNITS_PER_BPS,
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
export const QUOTE_MODEL_VERSION = "adaptive-v3";
/**
 * How much steeper the size curve gets with volatility, in thousandths: 1x in a still market, rising by
 * 1x per 50 bps of short-horizon risk to at most 4x. Only charges scale; rebates do not.
 */
export function impactScaleMilli(volatilityBps: number | undefined) {
  return 1_000n + BigInt(Math.min(3_000, Math.floor(bounded(volatilityBps ?? 0, 0, 2_000) * 20)));
}
/** Largest inventory rebate a fill can earn, in bps of its notional. */
export const MAX_REBATE_BPS = 5n;
/**
 * The inventory charge a quote carries. A trade that adds to the maker's inventory pays the contract's
 * required charge scaled by `impactScaleMilli`; one that reduces it gets half of the improvement as a
 * better price (rounded towards zero, at most `MAX_REBATE_BPS` of notional), so the contract's
 * requirement still holds with margin and a round trip always costs more than it earns.
 */
export function quotedImpact(rawImpact: bigint, volatilityBps: number | undefined, notional: bigint) {
  if (rawImpact >= 0n) return ceilDiv(rawImpact * impactScaleMilli(volatilityBps), 1_000n);
  const half = -rawImpact / 2n,
    cap = (notional * MAX_REBATE_BPS) / 10_000n;
  return -(half < cap ? half : cap);
}
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
/**
 * The smallest trade a new quote or order is sized at (USDC 1e6). Below about a cent, rounding the price to whole
 * micro-USDC moves it by whole percents and re-pricing at settlement rounds the trade to nothing, so it could only
 * fail after the trader signed; a dollar also keeps sponsored gas from being spent on dust.
 */
export const MIN_TRADE_NOTIONAL = 1_000_000n;
export const MIN_TRADE_ERROR = "amount below the minimum trade of $1";
export const DEFAULT_MARGIN_SCALE_BPS = 10_000;
export const MIN_MARGIN_SCALE_BPS = 1_250;
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
/** Leverage the first tier's scaled initial margin allows, rounded down to 0.01x (20 at 2_500, 40 at 1_250). */
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
/**
 * The price a fill of `notional` pays before its fee: the oracle mid moved by the spread and inventory
 * charges. The contract measures the delivered inventory charge from the mid too
 * (`RFQRiskMath.tradeAssessment`), so a small trade in a calm market fills at the mid even when the
 * exchanges the oracle reads disagree.
 */
export function quotedPrice(input: {
  buy: boolean;
  bid: bigint;
  ask: bigint;
  notional: bigint;
  /** The adaptive spread's charge, in USDC micro. */
  spreadCharge: bigint;
  impactCharge: bigint;
}): bigint {
  const { buy, bid, ask, notional, spreadCharge, impactCharge } = input,
    mid = (bid + ask) / 2n,
    charge = spreadCharge + impactCharge,
    // Rounded up for a charge and towards zero for a rebate, always in the maker's favour.
    premium = charge >= 0n ? ceilDiv(mid * charge, notional) : -((mid * -charge) / notional);
  return buy ? mid + premium : mid - premium;
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
    impactCharge = quotedImpact(
      requiredPendingImpact(settled, pending, request.market, delta),
      snapshot.volatilityBps,
      notional,
    ),
    spread = parameters.spread,
    spreadUnits = spread?.totalBps ?? parameters.baseSpreadBps * SPREAD_UNITS_PER_BPS,
    // The market's base spread is in the fee; the price carries only the model spread and impact.
    fee = ceilDiv(notional * parameters.feeBps, 10_000n),
    expectedPrice = quotedPrice({
      buy: request.side === "buy",
      bid: snapshot.bid,
      ask: snapshot.ask,
      notional,
      spreadCharge: spreadChargeOf(notional, spreadUnits),
      impactCharge,
    }),
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
