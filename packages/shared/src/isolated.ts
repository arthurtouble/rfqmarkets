import { AbiCoder, dataSlice, getAddress, id, keccak256 } from "ethers";

/** RFQTypes ISOLATED_ACCOUNT_TAG. */
const ISOLATED_ACCOUNT_TAG = id("rfq.isolated");

/**
 * The isolated account holding `owner`'s isolated position in `market`, as RFQLedger.isolatedAccount derives it.
 * Nobody holds a key for it: the owner signs its intents, and its collateral moves only to and from the owner.
 */
export function isolatedAccountAddress(owner: string, market: number) {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "uint8"],
    [ISOLATED_ACCOUNT_TAG, getAddress(owner), market],
  );
  return getAddress(dataSlice(keccak256(encoded), 12));
}

/** Clearing reader for the owner of an isolated account. */
export interface IsolatedOwnerReader {
  isolatedOwner(
    account: string,
    overrides?: { blockTag?: number },
  ): Promise<{ owner: string; market: bigint | number }>;
}

/**
 * The address whose signature authorizes `account`: its owner for an isolated account, else the account itself
 * (RFQLedger.signerOf).
 */
export async function signerAccount(clearing: IsolatedOwnerReader, account: string, blockNumber?: number) {
  const { owner } = await clearing.isolatedOwner(
    account,
    blockNumber === undefined ? {} : { blockTag: blockNumber },
  );
  return BigInt(owner) === 0n ? getAddress(account) : getAddress(owner);
}
