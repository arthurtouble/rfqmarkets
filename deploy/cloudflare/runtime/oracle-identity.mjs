import { Wallet, getAddress } from "ethers";

// Each oracle node's signer key is generated inside its own Durable Object on first use and kept only
// in that object's storage. Only the address leaves Cloudflare (KV `oracle-node-<n>.json`).
export async function ensureOracleSigner(storage) {
  let signer = await storage.get("oracle-signer");
  if (!signer) {
    const wallet = Wallet.createRandom();
    signer = { address: wallet.address, privateKey: wallet.privateKey, createdAt: new Date().toISOString() };
    await storage.put("oracle-signer", signer);
  }
  return signer;
}

export const publicOracleSigner = (signer) => ({ address: signer.address });

/**
 * What the node may sign for, from the KV deployment record: the adapter's domain, and only when the
 * deployment's oracle signer set includes this node. Anything else is a reason not to sign.
 */
export function oracleDomainFor(deployment, address) {
  if (!deployment) return { ready: false, reason: "contracts_not_deployed" };
  let verifyingContract;
  try {
    verifyingContract = getAddress(deployment.contracts?.oracleAdapter ?? "");
  } catch {
    return { ready: false, reason: "oracle_adapter_missing" };
  }
  const signers = (deployment.oracle?.signers ?? []).map((item) => String(item).toLowerCase());
  if (!signers.includes(address.toLowerCase())) return { ready: false, reason: "signer_not_in_deployment" };
  return { ready: true, verifyingContract };
}
