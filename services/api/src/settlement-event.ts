import { Interface, type JsonRpcProvider } from "ethers";
type RawReceipt = {
  status: string;
  logs: Array<{ address: string; data: string; topics: string[] }>;
} | null;

/**
 * Receipt inclusion alone is insufficient: settlement can instead trigger resolution. Called once the
 * sender has seen the receipt, so a missing one is a load-balanced RPC answering from a node a block
 * behind; it is asked again for up to `waitMs` before the settlement counts as not credited.
 */
export async function settlementEvent(
  provider: Pick<JsonRpcProvider, "send">,
  address: string,
  iface: Interface,
  hash: string,
  event: string,
  matches: (args: Record<string, unknown>) => boolean,
  { waitMs = 6_000, pollMs = 250 }: { waitMs?: number; pollMs?: number } = {},
) {
  const deadline = Date.now() + waitMs;
  let receipt = (await provider.send("eth_getTransactionReceipt", [hash])) as RawReceipt;
  while (!receipt && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    receipt = (await provider.send("eth_getTransactionReceipt", [hash])) as RawReceipt;
  }
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
