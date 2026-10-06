import type { Market } from "../../../packages/shared/src/pricing.js";

export type { Market };
export type Side = "buy" | "sell";

export const MARKETS = ["BTC", "ETH"] as const satisfies readonly Market[];

/** On-chain market index used by the clearing contract and the EIP-712 intents. */
export function marketIndex(market: Market): 0 | 1 {
  return market === "BTC" ? 0 : 1;
}

export function marketName(index: number): Market {
  return index === 0 ? "BTC" : "ETH";
}

export function abs(value: bigint) {
  return value < 0n ? -value : value;
}

/** A Unix timestamp in whole seconds. */
export function unixSeconds(now = Date.now()) {
  return Math.floor(now / 1_000);
}
