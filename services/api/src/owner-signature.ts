import { Interface, getAddress, recoverAddress, type Provider } from "ethers";
import { signerAccount, type IsolatedOwnerReader } from "../../../packages/shared/src/isolated.js";

const walletInterface = new Interface(["function isValidSignature(bytes32,bytes) view returns(bytes4)"]);
/** EOA signature by `account`, or an ERC-1271 wallet at `account` accepting it (at `blockTag` if given). */
export async function validOwnerSignature(
  account: string,
  digest: string,
  signature: string,
  provider?: Pick<Provider, "getCode" | "call">,
  blockTag?: number,
) {
  try {
    if (getAddress(recoverAddress(digest, signature)) === getAddress(account)) return true;
  } catch {}
  if (!provider) return false;
  try {
    if ((await provider.getCode(account)) === "0x") return false;
    const result = await provider.call({
      to: account,
      data: walletInterface.encodeFunctionData("isValidSignature", [digest, signature]),
      ...(blockTag === undefined ? {} : { blockTag }),
    });
    return (
      String(walletInterface.decodeFunctionResult("isValidSignature", result)[0]).toLowerCase() ===
      "0x1626ba7e"
    );
  } catch {
    return false;
  }
}

/**
 * The address that signs for `account`: the owner of an isolated account, else the account. A failed read
 * falls back to the account itself, which can only reject an owner's signature, never accept another one.
 */
export async function signingAccount(
  clearing: IsolatedOwnerReader | undefined,
  account: string,
  blockTag?: number,
) {
  if (!clearing) return getAddress(account);
  try {
    return await signerAccount(clearing, account, blockTag);
  } catch {
    return getAddress(account);
  }
}
