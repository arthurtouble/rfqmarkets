// Referrals: an account names the account that referred it by signing a Referral under the venue's EIP-712
// domain. The binding is off chain, permanent and first-come: once an account has a referrer it cannot be
// changed. A referrer earns REFERRAL_SHARE_BPS of its referees' trading points on top of its own.

import { TypedDataEncoder, getAddress } from "ethers";
import { DOMAIN_NAME, DOMAIN_VERSION } from "../../../packages/shared/src/eip712.js";

export const referralTypes = {
  Referral: [
    { name: "account", type: "address" },
    { name: "referrer", type: "address" },
    { name: "issuedAt", type: "uint64" },
  ],
};
/** Referrers earn 10% of their referees' points. */
export const REFERRAL_SHARE_BPS = 1_000n;
/** A signed referral must be submitted within this long of `issuedAt` (either side, for clock skew). */
export const REFERRAL_MAX_AGE_SECONDS = 600;

export interface Referral {
  account: string;
  referrer: string;
  /** Unix seconds. */
  issuedAt: number;
}

export function referralDigest(chainId: bigint, verifyingContract: string, referral: Referral) {
  return TypedDataEncoder.hash(
    { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract },
    referralTypes,
    { account: referral.account, referrer: referral.referrer, issuedAt: BigInt(referral.issuedAt) },
  );
}

/** Why a referral cannot be recorded, or undefined when its terms are acceptable (signature aside). */
export function referralTermsError(referral: Referral, nowSeconds: number) {
  if (getAddress(referral.account) === getAddress(referral.referrer)) return "an account cannot refer itself";
  if (Math.abs(nowSeconds - referral.issuedAt) > REFERRAL_MAX_AGE_SECONDS) return "referral expired";
}

/** The referrer's bonus on its referees' point totals. */
export const referralBonus = (refereePoints: readonly bigint[]) =>
  (refereePoints.reduce((sum, points) => sum + points, 0n) * REFERRAL_SHARE_BPS) / 10_000n;
