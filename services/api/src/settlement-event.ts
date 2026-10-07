import { Interface, type JsonRpcProvider } from "ethers";
/** Receipt inclusion alone is insufficient: settlement can instead trigger resolution. */
export async function settlementEvent(
  provider: Pick<JsonRpcProvider, "send">,
  address: string,
  iface: Interface,
  hash: string,
  event: string,
  matches: (args: Record<string, unknown>) => boolean,
) {
  const receipt = (await provider.send("eth_getTransactionReceipt", [hash])) as {
    status: string;
    logs: Array<{ address: string; data: string; topics: string[] }>;
  } | null;
  if (!receipt || BigInt(receipt.status) !== 1n) return false;
  return receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== address.toLowerCase()) return false;
    try {
      const parsed = iface.parseLog(log);
      return parsed?.name === event && matches(parsed.args.toObject());
    } catch {
      return false;
    }
  });
}
