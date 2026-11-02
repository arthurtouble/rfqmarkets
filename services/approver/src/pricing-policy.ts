import type { ApproverPayload } from "../../../packages/shared/src/approver-payload.js";
import type { MakerApproval, TradeIntent } from "../../../packages/shared/src/eip712.js";
import { BASE, USDC, abs, ceilDiv } from "../../../packages/shared/src/numeric.js";
import { PLATFORM_MARKUP_BPS, quotedPrice } from "../../../packages/shared/src/pricing.js";
import { reject, type Rejection } from "./rejection.js";

type WireQuote = ApproverPayload["quote"];

/**
 * The least a fill may charge, before impact: the market's base spread plus the platform's 2 bps, the
 * market's trading fee (`tradingFeeBps`). The on-chain fee and any price premium over the mid both count
 * towards it; fills now pay it as the fee and carry only the model spread and impact in the price.
 */
export const minimumChargeBps = (baseSpreadBps: number | bigint) =>
  BigInt(baseSpreadBps) + PLATFORM_MARKUP_BPS;
/** Adaptive-spread bounds the approver accepts from the leader. */
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
 * Recompute the leader's adaptive spread: the components must sum to the capped total and the expected
 * price must equal mid +/- (spread + impact) premium, or the oracle touch +/- impact when that is wider. The market's base spread is not a floor here: it is
 * charged as the fee, which `checkPricePolicy` requires.
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
  if (total > MAX_SPREAD_BPS || total !== (sum > MAX_SPREAD_BPS ? MAX_SPREAD_BPS : sum))
    return reject("quote spread rejected");
  const notional = BigInt(quote.amount),
    impact = BigInt(quote.impactCharge) > 0n ? BigInt(quote.impactCharge) : 0n,
    // Quotes are priced from the oracle mid, never inside the touch (packages/shared/src/pricing.ts quotedPrice).
    expected = quotedPrice({
      buy: !wireBaseDelta.startsWith("-"),
      bid: BigInt(quote.bid),
      ask: BigInt(quote.ask),
      notional,
      spreadCharge: ceilDiv(notional * total, 10_000n),
      impactCharge: impact,
    });
  if (expected !== BigInt(quote.expectedPrice)) return reject("quote spread price mismatch");
}

/**
 * Quote freshness, base/notional rounding and a minimum charge: the fee plus
 * the price premium over the mid must reach the market's trading fee (its base
 * spread and the platform's 2 bps) and the impact charge. `capNotional` applies the static
 * per-trade ceiling when no chain limit word is available.
 */
export function checkPricePolicy(input: {
  quote: WireQuote;
  intent: TradeIntent;
  approval: MakerApproval;
  nowMs: number;
  maxFutureSeconds: number;
  capNotional: boolean;
  /** The market's on-chain base spread. */
  baseSpreadBps: number;
}): Rejection | undefined {
  const { quote, intent, approval, nowMs, maxFutureSeconds, capNotional } = input;
  const notional = BigInt(quote.amount),
    observedAge = nowMs - quote.observedAtMs,
    mid = (BigInt(quote.bid) + BigInt(quote.ask)) / 2n;
  const baseRounding = abs(abs(intent.baseDelta) - (notional * BASE) / mid),
    positiveImpact = approval.impactCharge > 0n ? approval.impactCharge : 0n,
    minimumCharge = ceilDiv(notional * minimumChargeBps(input.baseSpreadBps), 10_000n) + positiveImpact,
    // A fee pays part of the charge; the price premium must cover the rest.
    premiumCharge = minimumCharge > approval.fee ? minimumCharge - approval.fee : 0n,
    anchor = mid,
    minimumPremium = ceilDiv(anchor * premiumCharge, notional);
  const underpriced =
    intent.baseDelta > 0n
      ? approval.executionPrice < anchor + minimumPremium
      : approval.executionPrice > anchor - minimumPremium;
  if (
    observedAge < -maxFutureSeconds * 1_000 ||
    observedAge > MAX_QUOTE_AGE_MS ||
    (baseRounding * mid) / BASE > 1n ||
    (capNotional && notional > MAX_TRADE_NOTIONAL) ||
    approval.fee < 0n ||
    underpriced
  )
    return reject("policy rejected");
}
