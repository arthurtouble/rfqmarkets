import { getAddress } from "ethers";
import type { ApproverPayload } from "../../../packages/shared/src/approver-payload.js";
import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  approvalFromWire,
  domainFromWire,
  intentFromWire,
  triggerFromWire,
  type MakerApproval,
  type SigningDomain,
  type TradeIntent,
  type Trigger,
} from "../../../packages/shared/src/eip712.js";
import { marketIndex } from "../../../packages/shared/src/markets.js";
import { abs } from "../../../packages/shared/src/numeric.js";
import { reject, type Rejection } from "./rejection.js";

/** Longest maker approval lifetime the approver will sign, before clock-skew allowance. */
export const APPROVAL_LIFETIME_SECONDS = 31;

export interface Envelope {
  domain: SigningDomain;
  /** The intent exactly as the user signed it. */
  intent: TradeIntent;
  approval: MakerApproval;
  /** Present for a triggered order; the approval then binds the `TriggeredTradeIntent` digest. */
  trigger?: Trigger;
  /**
   * The trade the approval prices: the signed intent, or for a reduce-only triggered intent the
   * quote's smaller delta that the contract clamps to the open position. Economics, exposure and
   * pricing are evaluated on this; the clamp itself is re-derived from the chain position.
   */
  fill: TradeIntent;
}

/** A triggered fill may only shrink a reduce-only intent in the same direction. */
export function plausibleTriggeredFill(intent: TradeIntent, fillDelta: bigint) {
  return (
    fillDelta === intent.baseDelta ||
    (intent.reduceOnly &&
      fillDelta !== 0n &&
      fillDelta > 0n === intent.baseDelta > 0n &&
      abs(fillDelta) < abs(intent.baseDelta))
  );
}

/** Typed-data view of the payload, or undefined when an integer or address is malformed. */
export function decodeEnvelope(input: ApproverPayload): Envelope | undefined {
  try {
    const intent = intentFromWire(input.intent),
      trigger = input.trigger ? triggerFromWire(input.trigger) : undefined,
      fill = trigger ? { ...intent, baseDelta: BigInt(input.quote.baseDelta) } : intent;
    if (trigger && (trigger.triggerPrice <= 0n || !plausibleTriggeredFill(intent, fill.baseDelta)))
      return undefined;
    return {
      domain: domainFromWire(input.domain),
      intent,
      approval: approvalFromWire(input.approval),
      ...(trigger ? { trigger } : {}),
      fill,
    };
  } catch {
    return undefined;
  }
}

export function checkDomain(
  domain: SigningDomain,
  expected: { chainId?: bigint; verifyingContract?: string },
): Rejection | undefined {
  if (
    domain.name !== DOMAIN_NAME ||
    domain.version !== DOMAIN_VERSION ||
    (expected.chainId !== undefined && domain.chainId !== expected.chainId) ||
    (expected.verifyingContract && domain.verifyingContract !== getAddress(expected.verifyingContract))
  )
    return reject("domain mismatch");
}

/**
 * Wall-clock deadline bounds. Only used without a chain connection; with one,
 * `checkChainTimeExpiry` applies the same bounds against the read block.
 */
export function checkWallClockExpiry(
  intent: TradeIntent,
  approval: MakerApproval,
  nowMs: number,
  maxFutureSeconds: number,
): Rejection | undefined {
  const expiryMs = Number(approval.deadline) * 1_000;
  if (
    Number(intent.deadline) * 1_000 <= nowMs ||
    expiryMs <= nowMs ||
    expiryMs > nowMs + (APPROVAL_LIFETIME_SECONDS + maxFutureSeconds) * 1_000
  )
    return reject("invalid expiry");
}

export function checkVersions(
  approval: MakerApproval,
  expected: { epoch?: number; policyVersion?: number; signerSetVersion?: number },
): Rejection | undefined {
  if (
    (expected.epoch !== undefined && approval.leaderEpoch !== BigInt(expected.epoch)) ||
    (expected.policyVersion !== undefined && approval.policyVersion !== BigInt(expected.policyVersion)) ||
    (expected.signerSetVersion !== undefined &&
      approval.signerSetVersion !== BigInt(expected.signerSetVersion))
  )
    return reject("version mismatch");
}

/** The typed intent and approval must restate the leader's quote exactly. */
export function checkEnvelopeConsistency(
  quote: ApproverPayload["quote"],
  intent: TradeIntent,
  approval: MakerApproval,
): Rejection | undefined {
  const priceOutsideLimit =
    (intent.baseDelta > 0n && approval.executionPrice > intent.limitPrice) ||
    (intent.baseDelta < 0n && approval.executionPrice < intent.limitPrice);
  if (
    intent.market !== marketIndex(quote.market) ||
    intent.baseDelta.toString() !== quote.baseDelta ||
    intent.maxFee < approval.fee ||
    priceOutsideLimit ||
    approval.executionPrice.toString() !== quote.expectedPrice ||
    approval.impactCharge.toString() !== quote.impactCharge ||
    approval.fee.toString() !== quote.fee ||
    approval.deadline > intent.deadline
  )
    return reject("inconsistent envelope");
}
