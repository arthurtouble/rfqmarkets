export {
  isKnownMarket,
  marketIndex,
  marketName,
  marketRegistry,
  marketSymbols,
  type Market,
} from "../../../packages/shared/src/markets.js";
export type { Side } from "../../../packages/shared/src/api-types.js";

export function abs(value: bigint) {
  return value < 0n ? -value : value;
}

/** A Unix timestamp in whole seconds. */
export function unixSeconds(now = Date.now()) {
  return Math.floor(now / 1_000);
}
