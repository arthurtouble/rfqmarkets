import { AbiCoder, getBytes, isHexString } from "ethers";

export interface StreamsV3Observation {
  feedId: string;
  bid: bigint;
  ask: bigint;
  observedAt: number;
  validUntil: number;
}

/** Decode the signed Data Streams envelope without treating it as trusted. */
export function decodeStreamsV3Envelope(
  fullReport: string,
  expectedFeedId: string,
  decimals: number,
): StreamsV3Observation {
  if (
    !isHexString(fullReport) ||
    !/^0x[0-9a-fA-F]{64}$/.test(expectedFeedId) ||
    decimals < 6 ||
    decimals > 18
  )
    throw new Error("invalid Data Streams configuration");
  const coder = AbiCoder.defaultAbiCoder();
  const outer = coder.decode(["bytes32[3]", "bytes", "bytes32[]", "bytes32[]", "bytes32"], fullReport);
  const decoded = coder.decode(
    ["bytes32", "uint32", "uint32", "uint192", "uint192", "uint32", "int192", "int192", "int192"],
    getBytes(outer[1]),
  );
  const feedId = String(decoded[0]),
    observedAt = Number(decoded[2]),
    validUntil = Number(decoded[5]),
    scale = 10n ** BigInt(decimals - 6),
    price = BigInt(decoded[6]),
    bid = BigInt(decoded[7]),
    ask = BigInt(decoded[8]);
  if (
    feedId.toLowerCase() !== expectedFeedId.toLowerCase() ||
    price <= 0n ||
    bid <= 0n ||
    ask < bid ||
    observedAt <= 0 ||
    validUntil < observedAt
  )
    throw new Error("invalid Data Streams v3 report");
  return { feedId, bid: bid / scale, ask: ask / scale, observedAt, validUntil };
}
