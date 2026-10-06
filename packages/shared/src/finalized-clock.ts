import type { JsonRpcProvider } from "ethers";

type RpcSender = Pick<JsonRpcProvider, "send">;

/**
 * The `finalized` header, bounded by the request's context block and, with a
 * secondary RPC, confirmed there by hash. Undefined when unavailable or unsafe.
 */
export async function finalizedClock(
  provider: RpcSender,
  contextBlock: number,
  contextTimestamp: number,
  secondary?: RpcSender,
) {
  try {
    const raw = (await provider.send("eth_getBlockByNumber", ["finalized", false])) as null | {
      number: string;
      timestamp: string;
      hash: string;
    };
    if (!raw) return undefined;
    const block = Number(BigInt(raw.number)),
      timestamp = Number(BigInt(raw.timestamp));
    if (
      !Number.isSafeInteger(block) ||
      !Number.isSafeInteger(timestamp) ||
      block < 0 ||
      timestamp < 0 ||
      block > contextBlock ||
      timestamp > contextTimestamp ||
      !/^0x[\da-f]{64}$/i.test(raw.hash)
    )
      return undefined;
    if (secondary) {
      const other = (await secondary.send("eth_getBlockByNumber", ["finalized", false])) as typeof raw;
      if (!other || BigInt(other.number) < BigInt(raw.number)) return undefined;
      const header = (await secondary.send("eth_getBlockByNumber", [raw.number, false])) as typeof raw;
      if (
        !header ||
        header.hash.toLowerCase() !== raw.hash.toLowerCase() ||
        header.timestamp !== raw.timestamp
      )
        return undefined;
    }
    return { block, timestamp, hash: raw.hash };
  } catch {
    return undefined;
  }
}
