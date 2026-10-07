/** Fixed-point units shared with RFQClearing. */
export const USDC = 1_000_000n;
export const RATE = 1_000_000_000_000n;
export const BASE = 1_000_000_000_000_000_000n;
export const YEAR_SECONDS = 365n * 86_400n;
/** Low 128 bits of a packed contract limit word. */
export const MASK = (1n << 128n) - 1n;

export const abs = (value: bigint) => (value < 0n ? -value : value);

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

/** Low half of a packed `uint256` limit word. */
export const low128 = (word: bigint) => word & MASK;
/** High half of a packed `uint256` limit word. */
export const high128 = (word: bigint) => word >> 128n;

/**
 * `marketLimitWord(market)` packs the per-trade notional cap in the low 128 bits
 * and the market net-notional cap in the high 128 bits.
 */
export function decodeMarketLimitWord(word: bigint | number | string) {
  const value = BigInt(word);
  return { maxTradeNotional: low128(value), maxMarketNotional: high128(value) };
}
