import { getAddress } from "ethers";
import type { SessionState } from "../../../packages/shared/src/clearing-structs.js";
import {
  recoverDigestSigner,
  type MakerApproval,
  type SigningDomain,
  type TradeIntent,
  type Trigger,
} from "../../../packages/shared/src/eip712.js";
import { reject, type Rejection } from "./rejection.js";

/**
 * ECDSA signer of the intent (in its triggered form when `trigger` is given), or undefined when the
 * signature is not a recoverable ECDSA signature.
 */
export function recoverSigner(
  domain: SigningDomain,
  intent: TradeIntent,
  signature: string,
  trigger?: Trigger,
) {
  try {
    return recoverDigestSigner(domain, intent, signature, trigger);
  } catch {
    return undefined;
  }
}

/**
 * The approval must bind this exact intent. Without a chain connection only
 * an EOA signature by the account is accepted; with one, ERC-1271 and session
 * signers are resolved on chain by `checkUserAuthorization`.
 */
export function checkUserSignature(input: {
  approval: MakerApproval;
  intentHash: string;
  intentSigner: string | undefined;
  account: string;
  requireAccountSigner: boolean;
}): Rejection | undefined {
  if (
    input.approval.intentHash !== input.intentHash ||
    (input.requireAccountSigner && input.intentSigner !== input.account)
  )
    return reject("invalid user signature", 401);
}

/**
 * Chain-state authorization: the account signed (EOA or ERC-1271), or the
 * signer holds a live session for this account whose market mask, expiry,
 * fee and notional budgets cover the intent.
 */
export function checkUserAuthorization(input: {
  accountSignatureValid: boolean;
  session: SessionState | undefined;
  intent: TradeIntent;
  fee: bigint;
  notional: bigint;
}): Rejection | undefined {
  const { accountSignatureValid, session, intent, fee, notional } = input;
  if (
    !accountSignatureValid &&
    (!session ||
      getAddress(session.account) !== intent.account ||
      session.validUntil < intent.deadline ||
      (session.marketMask & (1 << intent.market)) === 0 ||
      session.maxFee < fee ||
      session.usedNotional + notional > session.maxCumulativeNotional ||
      notional > session.maxTradeNotional)
  )
    return reject("user authorization rejected");
}
