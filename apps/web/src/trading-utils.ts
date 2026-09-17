import { adaptiveSpread } from "../../../packages/shared/src/pricing.js";
import type { Market, MarketSnapshot } from "./types.js";

export const randomNonce = () => BigInt(`0x${[...crypto.getRandomValues(new Uint8Array(32))]
  .map(value => value.toString(16).padStart(2, "0"))
  .join("")}`).toString();

export const spreadFromWire = (value: MarketSnapshot["markets"][Market]) => value.spread ? {
  ...value.spread,
  baseBps: BigInt(value.spread.baseBps),
  volatilityBps: BigInt(value.spread.volatilityBps),
  toxicityBps: BigInt(value.spread.toxicityBps),
  hedgeBps: BigInt(value.spread.hedgeBps),
  basisBps: BigInt(value.spread.basisBps),
  uncertaintyBps: BigInt(value.spread.uncertaintyBps),
  totalBps: BigInt(value.spread.totalBps),
} : adaptiveSpread({ volatilityBps: value.volatilityBps, riskMode: value.riskMode });
