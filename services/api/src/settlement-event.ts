import { Interface, type JsonRpcProvider } from "ethers";
type RawReceipt = {
  status: string;
  logs: Array<{ address: string; data: string; topics: string[] }>;
} | null;

/**
 * Receipt inclusion alone is insufficient: settlement can instead trigger resolution. Called once the
 * sender has seen the receipt, so a missing one is a load-balanced RPC answering from a node a block
 * behind (or refusing the read); it is asked again for up to `waitMs` before the settlement counts as
 * not credited.
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
  // A refused read (403, 429, timeout) is retried like a missing receipt; only the last one is thrown.
  let failure: unknown;
  const read = () =>
    (provider.send("eth_getTransactionReceipt", [hash]) as Promise<RawReceipt>).then(
      (value) => ((failure = undefined), value),
      (error: unknown) => ((failure = error), null),
    );
  let receipt = await read();
  while (!receipt && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    receipt = await read();
  }
  if (!receipt && failure) throw failure;
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

/**
 * A read made after a settlement landed (the new balance or position): retried a few times, since a
 * public RPC refusing one call must not turn a settled trade or transfer into a reported failure.
 */
export async function afterSettlement<T>(read: () => Promise<T>, attempts = 4, delayMs = 250): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
