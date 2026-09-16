/** Returns an exact reduce-only delta for a requested share of an open position. */
export function partialCloseDelta(size: bigint, percentageBps: number) {
  if (size === 0n) throw new Error("position is already closed");
  if (!Number.isSafeInteger(percentageBps) || percentageBps < 1 || percentageBps > 10_000) throw new Error("invalid close percentage");
  const quantity = (size < 0n ? -size : size) * BigInt(percentageBps) / 10_000n;
  if (quantity === 0n) throw new Error("close amount is below the minimum position unit");
  return size > 0n ? -quantity : quantity;
}
