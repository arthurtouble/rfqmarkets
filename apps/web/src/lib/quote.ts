// Indicative quotes built locally from the market stream so the ticket updates
// every tick. The firm quote still comes from POST /v1/quote at submit time.
import { adaptiveSpread, constructQuote, type SpreadBreakdown } from "../../../../packages/shared/src/pricing.js";
import { quoteToWire } from "../../../../packages/shared/src/wire.js";
import { microToInput } from "./format.js";
import { clampSlippageBps } from "./slippage.js";
import type { Market, MarketSnapshot, MarketState, Quote, Side } from "./types.js";

/** Price data older than this is treated as unavailable. */
export const STALE_AFTER_MS = 2_500;

function spreadOf(live: MarketState): SpreadBreakdown {
  if (!live.spread) return adaptiveSpread({ volatilityBps: live.volatilityBps, riskMode: live.riskMode });
  const s = live.spread;
  return {
    modelVersion: s.modelVersion, baseBps: BigInt(s.baseBps), volatilityBps: BigInt(s.volatilityBps),
    toxicityBps: BigInt(s.toxicityBps), hedgeBps: BigInt(s.hedgeBps), basisBps: BigInt(s.basisBps),
    uncertaintyBps: BigInt(s.uncertaintyBps), totalBps: BigInt(s.totalBps),
  };
}

export type IndicativeQuote = { quote: Quote } | { error: string };

/**
 * `slippageBps` (1..500) sets the indicative worst price, as POST /v1/quote does;
 * omitted, the launch tolerance applies. Markets added after launch have no
 * local impact parameters, so they return an error until the firm quote.
 */
export function indicativeQuote(snapshot: MarketSnapshot, market: Market, side: Side, amountMicro: bigint, nowMs: number, slippageBps?: number): IndicativeQuote {
  const live = snapshot.markets[market];
  if (!live) return { error: `No price for ${market}` };
  if (nowMs - live.observedAtMs > STALE_AFTER_MS) return { error: "Waiting for fresh prices" };
  if (!live.enabled) return { error: `${market} trading is disabled` };
  if (!(side === "buy" ? live.canBuy : live.canSell)) return { error: `Only exposure-reducing ${side === "buy" ? "buys" : "sells"} are available` };
  const maxNotional = BigInt(live.operatingMaxTradeNotional);
  if (amountMicro > maxNotional) return { error: `Maximum per trade is ${Number(maxNotional) / 1e6} USDC` };
  try {
    const { pricing } = snapshot, spread = spreadOf(live);
    const value = constructQuote(
      { market, side, amount: microToInput(amountMicro), ...(slippageBps === undefined ? {} : { slippageBps: clampSlippageBps(slippageBps) }) },
      { market, bid: BigInt(live.bid), ask: BigInt(live.ask), observedAtMs: live.observedAtMs, source: live.source, volatilityBps: live.volatilityBps },
      Object.fromEntries(Object.entries(pricing.settled).map(([name, value]) => [name, BigInt(value)])),
      pricing.pending.map(item => ({ market: item.market, delta: BigInt(item.delta) })),
      nowMs, crypto.randomUUID(),
      { maxNotional, baseSpreadBps: spread.totalBps, feeBps: BigInt(pricing.feeBps), toleranceBps: BigInt(pricing.toleranceBps), spread, maxSnapshotAgeMs: STALE_AFTER_MS },
    );
    return { quote: { ...quoteToWire(value), market, quoteId: undefined } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Quote unavailable" };
  }
}
