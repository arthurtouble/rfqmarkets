// Isolated accounts: each Home trade holds its own margin in an account derived from the owner and the market,
// so its loss stops at that margin. Mirrors packages/shared/src/isolated.ts with viem, which the app already ships.
import { encodeAbiParameters, getAddress, keccak256, slice, toHex, type Address } from "viem";

/** RFQTypes ISOLATED_ACCOUNT_TAG. */
const ISOLATED_ACCOUNT_TAG = keccak256(toHex("rfq.isolated"));

/** `RFQTypes.MIN_FIRST_DEPOSIT`: the first margin moved into an isolated account must be at least this (USDC 1e6). */
export const MIN_ISOLATED_OPEN = 10_000_000n;

/** The isolated account holding `owner`'s isolated position in `market` (RFQLedger.isolatedAccount). */
export function isolatedAccountOf(owner: string, market: number): Address {
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint8" }],
    [ISOLATED_ACCOUNT_TAG, getAddress(owner), market],
  );
  return getAddress(slice(keccak256(encoded), 12));
}

/**
 * The margin move that leaves exactly `stake` in an isolated account already holding `held`: positive adds,
 * negative returns the excess, zero needs none. Null when the account is new and `stake` is under the
 * contract's opening floor, so the trade uses the main balance instead.
 */
export function marginTopUp(stake: bigint, held: bigint, registered: boolean): bigint | null {
  if (!registered && stake < MIN_ISOLATED_OPEN) return null;
  return stake - held;
}
