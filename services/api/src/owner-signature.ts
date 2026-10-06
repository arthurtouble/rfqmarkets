import { Interface, getAddress, recoverAddress, type Provider } from "ethers";

const walletInterface = new Interface(["function isValidSignature(bytes32,bytes) view returns(bytes4)"]);
export async function validOwnerSignature(
  account: string,
  digest: string,
  signature: string,
  provider?: Pick<Provider, "getCode" | "call">,
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
    });
    return (
      String(walletInterface.decodeFunctionResult("isValidSignature", result)[0]).toLowerCase() ===
      "0x1626ba7e"
    );
  } catch {
    return false;
  }
}
