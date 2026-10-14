import type { ApproverPayload } from "../../../packages/shared/src/approver-payload.js";
import type { MakerApproval, TradeIntent } from "../../../packages/shared/src/eip712.js";
import { BASE, USDC, abs, ceilDiv } from "../../../packages/shared/src/numeric.js";
import { PLATFORM_MARKUP_BPS } from "../../../packages/shared/src/pricing.js";
import { reject, type Rejection } from "./rejection.js";

type WireQuote = ApproverPayload["quote"];

/**
 * The least a fill may charge over the touch, before impact: the market's base spread plus the platform
 * markup. Any on-chain fee counts towards it; fills now carry the markup in the price and no fee.
 */
export const minimumChargeBps = (baseSpreadBps: number | bigint) =>
  BigInt(baseSpreadBps) + PLATFORM_MARKUP_BPS;
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
 * Recompute the leader's adaptive spread: the base component must reach the market's base spread, the
 * components must sum to the capped total, and the expected price must equal anchor +/- (spread + impact)
 * premium.
 */
export function checkQuoteSpread(
  quote: WireQuote,
  wireBaseDelta: string,
  minBaseBps = Number(MIN_BASE_SPREAD_BPS),
): Rejection | undefined {
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
  // The market's on-chain base spread (set by governance or the risk operator) is a floor on the base component.
  if (components[0] < BigInt(minBaseBps)) return reject("quote spread below market base");
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
 * Quote freshness, base/notional rounding and a minimum charge: the fee plus
 * the price premium over the touch must reach the market's base spread, the
 * platform markup and the impact charge. `capNotional` applies the static
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
    anchor = intent.baseDelta > 0n ? BigInt(quote.ask) : BigInt(quote.bid),
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
