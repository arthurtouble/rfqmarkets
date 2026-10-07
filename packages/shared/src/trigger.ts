import type { Trigger } from "./eip712.js";
import { abs, ceilDiv } from "./numeric.js";

/** Off-chain trigger order kinds. Stop-loss and take-profit are always reduce-only. */
export const TRIGGER_KINDS = ["stop-loss", "take-profit", "stop-entry"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/**
 * Mirrors `RFQSettlement.executeTriggeredTrade`: the report's mid, (bid + ask) / 2 rounded down,
 * must be at or above (`triggerAbove`) or at or below the trigger price.
 */
export function triggerReached(bid: bigint, ask: bigint, trigger: Trigger) {
  const mid = (bid + ask) / 2n;
  return trigger.triggerAbove ? mid >= trigger.triggerPrice : mid <= trigger.triggerPrice;
}

/**
 * Mirrors the contract's reduce-only clamp: a reduce-only triggered intent larger than the opposite
 * position fills exactly `-position`. Every other intent fills its signed `baseDelta`.
 */
export function triggeredFillDelta(
  intent: { baseDelta: bigint; reduceOnly: boolean },
  positionSize: bigint,
): bigint {
  if (
    intent.reduceOnly &&
    positionSize > 0n !== intent.baseDelta > 0n &&
    abs(intent.baseDelta) > abs(positionSize)
  )
    return -positionSize;
  return intent.baseDelta;
}

/**
 * The trigger direction a kind implies for a side. A stop-loss sells a long when price falls and buys
 * back a short when it rises; a take-profit is the opposite; a stop entry buys a breakout above and
 * sells a breakdown below.
 */
export function triggerAboveFor(kind: TriggerKind, side: "buy" | "sell") {
  if (kind === "take-profit") return side === "sell";
  return side === "buy";
}

/**
 * The signed limit price of a triggered order: the trigger price moved `slippageBps` against the
 * trader, floored for sells and ceiled for buys.
 */
export function triggerLimitPrice(triggerPrice: bigint, side: "buy" | "sell", slippageBps: bigint) {
  return side === "buy"
    ? ceilDiv(triggerPrice * (10_000n + slippageBps), 10_000n)
    : (triggerPrice * (10_000n - slippageBps)) / 10_000n;
}
