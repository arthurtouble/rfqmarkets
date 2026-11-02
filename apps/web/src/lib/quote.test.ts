import assert from "node:assert/strict";
import { test } from "node:test";
import { indicativeQuote, marketFeeBps, STALE_AFTER_MS, touchPrices } from "./quote.js";
import type { MarketSnapshot, MarketState } from "./types.js";

const USDC = 1_000_000n;
const NOW = 1_000_000;
const market = (overrides: Partial<MarketState> = {}): MarketState => ({
  market: "BTC",
  bid: (99_990n * USDC).toString(),
  ask: (100_010n * USDC).toString(),
  mid: (100_000n * USDC).toString(),
  observedAtMs: NOW,
  source: "test",
  volatilityBps: 1,
  baseSpreadBps: 2,
  fundingApr: "0",
  fundingIndex: "0",
  projectedFundingIndex: "0",
  enabled: true,
  maxTradeNotional: (25_000n * USDC).toString(),
  maxMarketNotional: (100_000n * USDC).toString(),
  operatingMaxTradeNotional: (25_000n * USDC).toString(),
  riskMode: "normal",
  canBuy: true,
  canSell: true,
  ...overrides,
});
const snapshotWith = (state: MarketState): MarketSnapshot => ({
  blockNumber: 1,
  serverTimeMs: NOW,
  markets: { BTC: state },
  pricing: { settled: { BTC: "0" }, pending: [], baseSpreadBps: 0, feeBps: 4, toleranceBps: 8 },
});
const quoteOf = (result: ReturnType<typeof indicativeQuote>) => {
  if (!("quote" in result)) throw new Error(result.error);
  return result.quote;
};

test("a long quotes above mid and a short below, with the 4 bps fee", () => {
  const snapshot = snapshotWith(market());
  const long = quoteOf(indicativeQuote(snapshot, "BTC", "buy", 1_000n * USDC, NOW));
  const short = quoteOf(indicativeQuote(snapshot, "BTC", "sell", 1_000n * USDC, NOW));
  assert.ok(BigInt(long.expectedPrice) > 100_000n * USDC);
  assert.ok(BigInt(short.expectedPrice) < 100_000n * USDC);
  assert.equal(long.fee, 400_000n.toString());
  assert.ok(BigInt(long.baseDelta!) > 0n && BigInt(short.baseDelta!) < 0n);
  assert.equal(long.quoteId, undefined, "indicative quotes are never signable");
});

test("each market's own fee applies, and small trades fill at the touch, not past it", () => {
  const own = snapshotWith(market({ feeBps: 7 }));
  assert.equal(marketFeeBps(own, "BTC"), 7);
  assert.equal(marketFeeBps(snapshotWith(market()), "BTC"), 4);
  assert.equal(marketFeeBps(null, "BTC"), 4);
  assert.equal(quoteOf(indicativeQuote(own, "BTC", "buy", 1_000n * USDC, NOW)).fee, 700_000n.toString());
  // A calm spread is zero, so a small trade fills at the mid inside the oracle's band; a wider one moves off it.
  const calm = market({
    spread: {
      baseBps: "0",
      volatilityBps: "0",
      toxicityBps: "0",
      hedgeBps: "0",
      basisBps: "0",
      uncertaintyBps: "0",
      totalBps: "0",
      modelVersion: "adaptive-v3",
    },
  });
  assert.deepEqual(touchPrices(calm), { bid: 100_000n * USDC, ask: 100_000n * USDC });
  // Spread components are in tenths of a bp: 50 is 5 bps, 3 is 0.3 bps ($3 on $100,000).
  const wide = market({ spread: { ...calm.spread!, volatilityBps: "50", totalBps: "50" } });
  assert.deepEqual(touchPrices(wide), { bid: 99_950n * USDC, ask: 100_050n * USDC });
  const fine = market({ spread: { ...calm.spread!, volatilityBps: "3", totalBps: "3" } });
  assert.deepEqual(touchPrices(fine), { bid: 99_997n * USDC, ask: 100_003n * USDC });
});

test("slippage widens the protected price on the trader's side", () => {
  const snapshot = snapshotWith(market());
  const tight = quoteOf(indicativeQuote(snapshot, "BTC", "buy", 1_000n * USDC, NOW, 5));
  const wide = quoteOf(indicativeQuote(snapshot, "BTC", "buy", 1_000n * USDC, NOW, 100));
  assert.equal(tight.expectedPrice, wide.expectedPrice);
  assert.ok(BigInt(wide.worstPrice) > BigInt(tight.worstPrice));
  const short = quoteOf(indicativeQuote(snapshot, "BTC", "sell", 1_000n * USDC, NOW, 100));
  assert.ok(BigInt(short.worstPrice) < BigInt(short.expectedPrice));
});

test("stale prices, missing markets, closed sides and oversize trades do not quote", () => {
  const snapshot = snapshotWith(market());
  assert.deepEqual(indicativeQuote(snapshot, "BTC", "buy", 1_000n * USDC, NOW + STALE_AFTER_MS + 1), {
    error: "Waiting for fresh prices",
  });
  assert.deepEqual(indicativeQuote(snapshot, "SOL", "buy", 1_000n * USDC, NOW), {
    error: "No price for SOL",
  });
  assert.ok(
    "error" in indicativeQuote(snapshotWith(market({ canBuy: false })), "BTC", "buy", 1_000n * USDC, NOW),
  );
  assert.ok(
    "quote" in indicativeQuote(snapshotWith(market({ canBuy: false })), "BTC", "sell", 1_000n * USDC, NOW),
  );
  assert.ok("error" in indicativeQuote(snapshot, "BTC", "buy", 25_001n * USDC, NOW));
});

test("a paused market still quotes, since reductions trade while paused", () => {
  assert.ok(
    "quote" in indicativeQuote(snapshotWith(market({ enabled: false })), "BTC", "sell", 1_000n * USDC, NOW),
  );
});

test("a market listed after launch quotes locally without an impact estimate", () => {
  const sol = market({
    market: "SOL",
    index: 2,
    bid: 149_990_000n.toString(),
    ask: 150_010_000n.toString(),
    mid: 150_000_000n.toString(),
  });
  const snapshot: MarketSnapshot = { ...snapshotWith(market()), markets: { BTC: market(), SOL: sol } };
  const quote = quoteOf(indicativeQuote(snapshot, "SOL", "buy", 300n * USDC, NOW));
  assert.equal(quote.impactCharge, "0");
  // No impact, only the 0.2 bps volatility spread from 1 bps of risk: the buy fills just above the mid.
  assert.equal(quote.expectedPrice, 150_003_000n.toString());
  // The launch markets keep their registered impact.
  assert.ok("quote" in indicativeQuote(snapshot, "BTC", "buy", 1_000n * USDC, NOW));
});
