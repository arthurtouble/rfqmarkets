import type { Quote } from "./policy.js";

export function quoteToWire(quote: Quote) {
  return {
    quoteId: quote.quoteId,
    market: quote.market,
    side: quote.side,
    amount: quote.notional.toString(),
    baseDelta: quote.baseDelta.toString(),
    expectedPrice: quote.expectedPrice.toString(),
    worstPrice: quote.worstPrice.toString(),
    fee: quote.fee.toString(),
    impactCharge: quote.impactCharge.toString(),
    spread: quote.spread && {
      ...quote.spread,
      baseBps: quote.spread.baseBps.toString(),
      volatilityBps: quote.spread.volatilityBps.toString(),
      toxicityBps: quote.spread.toxicityBps.toString(),
      hedgeBps: quote.spread.hedgeBps.toString(),
      basisBps: quote.spread.basisBps.toString(),
      uncertaintyBps: quote.spread.uncertaintyBps.toString(),
      totalBps: quote.spread.totalBps.toString(),
    },
    expiresAtMs: quote.expiresAtMs,
    observedAtMs: quote.snapshot.observedAtMs,
    bid: quote.snapshot.bid.toString(),
    ask: quote.snapshot.ask.toString(),
  };
}
