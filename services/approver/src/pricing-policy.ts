import type { ApproverPayload } from "../../../packages/shared/src/approver-payload.js";
import type { MakerApproval, TradeIntent } from "../../../packages/shared/src/eip712.js";
import { BASE, USDC, abs, ceilDiv } from "../../../packages/shared/src/numeric.js";
import { FEE_TIERS, discountedFee } from "../../../packages/shared/src/fee-tiers.js";
import { reject, type Rejection } from "./rejection.js";

type WireQuote = ApproverPayload["quote"];

/** Protocol fee charged on every fill before volume discounts. */
export const MIN_FEE_BPS = 2n;
/** The deepest published volume-tier discount; the fee floor allows no more than this off the base fee. */
export const MAX_FEE_DISCOUNT_BPS = Math.max(...FEE_TIERS.map((tier) => tier.discountBps));
/** Adaptive-spread bounds the approver accepts from the leader. */
export const MIN_BASE_SPREAD_BPS = 2n;
export const MAX_SPREAD_BPS = 100n;
/** Oldest price observation a quote may be built on. */
export const MAX_QUOTE_AGE_MS = 8_000;
/** Per-trade notional ceiling; with a chain connection the market limit word also applies. */
export const MAX_TRADE_NOTIONAL = 1_000_000n * USDC;

export function checkQuoteModel(
  spread: WireQuote["spread"],
  expectedModelVersion: string | undefined,
): Rejection | undefined {
  if (expectedModelVersion && (!spread || spread.modelVersion !== expectedModelVersion))
    return reject("quote model mismatch");
}

/**
 * Recompute the leader's adaptive spread: the components must sum to the capped
 * total, and the expected price must equal anchor +/- (spread + impact) premium.
 */
export function checkQuoteSpread(quote: WireQuote, wireBaseDelta: string): Rejection | undefined {
  const spread = quote.spread;
  if (!spread) return;
  const components = [
      spread.baseBps,
      spread.volatilityBps,
      spread.toxicityBps,
      spread.hedgeBps,
      spread.basisBps,
      spread.uncertaintyBps,
    ].map(BigInt),
    total = BigInt(spread.totalBps),
    sum = components.reduce((value, item) => value + item, 0n);
  if (
    components[0] < MIN_BASE_SPREAD_BPS ||
    total > MAX_SPREAD_BPS ||
    total !== (sum > MAX_SPREAD_BPS ? MAX_SPREAD_BPS : sum)
  )
    return reject("quote spread rejected");
  const selling = wireBaseDelta.startsWith("-"),
    notional = BigInt(quote.amount),
    impact = BigInt(quote.impactCharge) > 0n ? BigInt(quote.impactCharge) : 0n,
    spreadCharge = ceilDiv(notional * total, 10_000n),
    anchor = selling ? BigInt(quote.bid) : BigInt(quote.ask),
    premium = ceilDiv(anchor * (spreadCharge + impact), notional),
    expected = selling ? anchor - premium : anchor + premium;
  if (expected !== BigInt(quote.expectedPrice)) return reject("quote spread price mismatch");
}

/**
 * Quote freshness, base/notional rounding, fee floor and a minimum premium of
 * fee + impact over the touch. `capNotional` applies the static per-trade
 * ceiling when no chain limit word is available.
 */
export function checkPricePolicy(input: {
  quote: WireQuote;
  intent: TradeIntent;
  approval: MakerApproval;
  nowMs: number;
  maxFutureSeconds: number;
  capNotional: boolean;
}): Rejection | undefined {
  const { quote, intent, approval, nowMs, maxFutureSeconds, capNotional } = input;
  const notional = BigInt(quote.amount),
    // Approvers cannot see an account's volume tier, so the floor is the base fee at the deepest tier.
    requiredFee = discountedFee(ceilDiv(notional * MIN_FEE_BPS, 10_000n), MAX_FEE_DISCOUNT_BPS),
    observedAge = nowMs - quote.observedAtMs,
    mid = (BigInt(quote.bid) + BigInt(quote.ask)) / 2n;
  const baseRounding = abs(abs(intent.baseDelta) - (notional * BASE) / mid),
    positiveImpact = approval.impactCharge > 0n ? approval.impactCharge : 0n,
    minimumCharge = requiredFee + positiveImpact,
    anchor = intent.baseDelta > 0n ? BigInt(quote.ask) : BigInt(quote.bid),
    minimumPremium = ceilDiv(anchor * minimumCharge, notional);
  const underpriced =
    intent.baseDelta > 0n
      ? approval.executionPrice < anchor + minimumPremium
      : approval.executionPrice > anchor - minimumPremium;
  if (
    observedAge < -maxFutureSeconds * 1_000 ||
    observedAge > MAX_QUOTE_AGE_MS ||
    (baseRounding * mid) / BASE > 1n ||
    (capNotional && notional > MAX_TRADE_NOTIONAL) ||
    approval.fee < requiredFee ||
    underpriced
  )
    return reject("policy rejected");
}
