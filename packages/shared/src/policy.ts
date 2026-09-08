import { z } from "zod";

export const USDC = 1_000_000n;
export const RATE = 1_000_000_000_000n;
export const BASE = 1_000_000_000_000_000_000n;
const K = { BTC: 10_000n, ETH: 12_000n, CROSS: 6_573n } as const;
export type Market = "BTC" | "ETH";
export type Exposure = Record<Market, bigint>;

export const quoteRequestSchema = z.object({
  market: z.enum(["BTC", "ETH"]),
  side: z.enum(["buy", "sell"]),
  amount: z.string().regex(/^\d+(\.\d{1,6})?$/),
});

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export function parseUsdc(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * USDC + BigInt((fraction + "000000").slice(0, 6));
}

export function formatUsdc(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / USDC}.${(absolute % USDC).toString().padStart(6, "0")}`;
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  let quotient = numerator / denominator;
  if (numerator < 0n && numerator % denominator !== 0n) quotient -= 1n;
  return quotient;
}

export function potential(exposure: Exposure): bigint {
  const numerator = K.BTC * exposure.BTC * exposure.BTC
    + 2n * K.CROSS * exposure.BTC * exposure.ETH
    + K.ETH * exposure.ETH * exposure.ETH;
  return floorDiv(numerator, 2n * RATE * USDC);
}

export function impactCost(exposure: Exposure, market: Market, delta: bigint): bigint {
  const next = { ...exposure, [market]: exposure[market] + delta };
  return potential(next) - potential(exposure);
}

export function requiredPendingImpact(
  settled: Exposure,
  pending: Array<{ market: Market; delta: bigint }>,
  market: Market,
  delta: bigint,
): bigint {
  if (pending.length > 12) throw new Error("prototype exhaustive pending bound exceeded");
  let greatest: bigint | undefined;
  for (let mask = 0; mask < 2 ** pending.length; mask++) {
    const state = { ...settled };
    for (let index = 0; index < pending.length; index++) {
      if ((mask & (1 << index)) !== 0) state[pending[index].market] += pending[index].delta;
    }
    const cost = impactCost(state, market, delta);
    if (greatest === undefined || cost > greatest) greatest = cost;
  }
  return greatest ?? impactCost(settled, market, delta);
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

export interface PriceSnapshot {
  market: Market;
  bid: bigint;
  ask: bigint;
  observedAtMs: number;
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
  expiresAtMs: number;
  snapshot: PriceSnapshot;
}

export function constructQuote(
  request: QuoteRequest,
  snapshot: PriceSnapshot,
  settled: Exposure,
  pending: Array<{ market: Market; delta: bigint }>,
  nowMs = Date.now(),
  quoteId = crypto.randomUUID(),
): Quote {
  const notional = parseUsdc(request.amount);
  if (notional <= 0n || notional > 25_000n * USDC) throw new Error("amount outside launch limit");
  if (nowMs - snapshot.observedAtMs > 2_000) throw new Error("oracle snapshot is stale");
  const delta = request.side === "buy" ? notional : -notional;
  const rawImpact = requiredPendingImpact(settled, pending, request.market, delta);
  // Pending states never grant credits; settled offsets are capped separately later.
  const impactCharge = rawImpact > 0n ? rawImpact : 0n;
  const baseSpread = ceilDiv(notional * 2n, 10_000n);
  const fee = ceilDiv(notional * 2n, 10_000n);
  const anchor = request.side === "buy" ? snapshot.ask : snapshot.bid;
  const premium = ceilDiv(anchor * (baseSpread + impactCharge), notional);
  const expectedPrice = request.side === "buy" ? anchor + premium : anchor - premium;
  const tolerance = ceilDiv(expectedPrice * 8n, 10_000n);
  const worstPrice = request.side === "buy" ? expectedPrice + tolerance : expectedPrice - tolerance;
  const mid = (snapshot.bid + snapshot.ask) / 2n;
  const baseMagnitude = notional * BASE / mid;
  const baseDelta = request.side === "buy" ? baseMagnitude : -baseMagnitude;
  return { quoteId, market: request.market, side: request.side, notional, delta, baseDelta, expectedPrice, worstPrice, fee, impactCharge, expiresAtMs: nowMs + 30_000, snapshot };
}
