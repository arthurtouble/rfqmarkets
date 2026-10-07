import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyAccount, estimateLiquidationPrice, hasPosition, initialMarginAfter, liquidationPrice, markAccount, openMarkets } from "./account.js";
import type { MarketSnapshot, MarketState } from "./types.js";

const USDC = 1_000_000n, BASE = 10n ** 18n;
const market = (name: string, bid: bigint, ask: bigint): MarketState => ({
  market: name, bid: bid.toString(), ask: ask.toString(), mid: ((bid + ask) / 2n).toString(), observedAtMs: 0, source: "test",
  volatilityBps: 0, baseSpreadBps: 2, fundingApr: "0", fundingIndex: "0", projectedFundingIndex: "0", enabled: true,
  maxTradeNotional: "0", maxMarketNotional: "0", operatingMaxTradeNotional: "0", riskMode: "normal", canBuy: true, canSell: true,
});
const snapshot: MarketSnapshot = {
  blockNumber: 7, serverTimeMs: 0,
  markets: { BTC: market("BTC", 99_990n * USDC, 100_010n * USDC), ETH: market("ETH", 3_999n * USDC, 4_001n * USDC) },
  pricing: { settled: { BTC: "0", ETH: "0" }, pending: [], baseSpreadBps: 2, feeBps: 2, toleranceBps: 8 },
};

test("marks a long at the bid and sizes notional at the ask", () => {
  const state = emptyAccount("0xabc", snapshot);
  state.collateral = (10_000n * USDC).toString();
  state.positions.BTC = { ...state.positions.BTC, size: (BASE / 10n).toString(), entryPrice: (99_000n * USDC).toString() };
  const marked = markAccount(state, snapshot);
  assert.equal(marked.positions.BTC.markPrice, (99_990n * USDC).toString());
  assert.equal(marked.positions.BTC.unrealizedPnl, (99n * USDC).toString());
  assert.equal(marked.grossNotional, (10_001n * USDC).toString());
  assert.equal(marked.initialMargin, (2_000_200_000n).toString());
  assert.equal(marked.equity, (10_099n * USDC).toString());
  assert.equal(marked.liquidatable, false);
});

test("a loss on one market is not offset by a gain on another for opening equity", () => {
  const state = emptyAccount("0xabc", snapshot);
  state.collateral = (1_000n * USDC).toString();
  state.positions.BTC = { ...state.positions.BTC, size: (BASE / 100n).toString(), entryPrice: (90_000n * USDC).toString() };
  state.positions.ETH = { ...state.positions.ETH, size: (BASE / 10n).toString(), entryPrice: (5_000n * USDC).toString() };
  const marked = markAccount(state, snapshot);
  assert.equal(BigInt(marked.openingEquity), 1_000n * USDC - 100_100_000n);
  assert.ok(BigInt(marked.equity) > BigInt(marked.openingEquity));
});

test("initial margin after a trade includes the existing position", () => {
  const state = emptyAccount("0xabc", snapshot);
  assert.equal(initialMarginAfter(state, snapshot, "BTC", 1_000n * USDC), 200n * USDC - 1n);
  assert.equal(initialMarginAfter(state, snapshot, "BTC", -1_000n * USDC), 200n * USDC - 1n);
});

const flatSnapshot = (scaleBps?: number): MarketSnapshot => ({
  ...snapshot,
  markets: { BTC: { ...market("BTC", 100_000n * USDC, 100_000n * USDC), ...(scaleBps === undefined ? {} : { marginScaleBps: scaleBps, maxLeverage: 0 }) } },
  pricing: { ...snapshot.pricing, settled: { BTC: "0" } },
});
const longOneBtc = (snap: MarketSnapshot) => {
  const state = emptyAccount("0xabc", snap);
  state.collateral = (30_000n * USDC).toString();
  state.positions.BTC = { ...state.positions.BTC, size: BASE.toString(), entryPrice: (100_000n * USDC).toString() };
  return state;
};
const near = (actual: bigint | null, expected: bigint, tolerance = 1_000n) =>
  assert.ok(actual !== null && actual - expected <= tolerance && expected - actual <= tolerance, `${actual} is not near ${expected}`);

test("liquidation price uses the market's scaled maintenance tier", () => {
  // 1 BTC long, 30k collateral: health 30k + (P - 100k) - rate * P is zero at P = 70k / (1 - rate).
  const unscaled = flatSnapshot();
  near(estimateLiquidationPrice(longOneBtc(unscaled), unscaled, "BTC"), 82_352_941_176n); // 15% tier
  const scaled = flatSnapshot(2_500);
  near(estimateLiquidationPrice(longOneBtc(scaled), scaled, "BTC"), 72_727_272_727n); // 3.75%
  // markAccount fills the same estimate and the scaled margins.
  const marked = markAccount(longOneBtc(scaled), scaled);
  near(BigInt(marked.positions.BTC.estimatedLiquidationPrice!), 72_727_272_727n);
  assert.equal(marked.maintenanceMargin, (3_750n * USDC).toString());
  assert.equal(marked.initialMargin, (6_250n * USDC).toString());
  // The account read's marginParameters apply when the stream lacks the scale.
  const fromRead = { ...longOneBtc(unscaled), marginParameters: { BTC: { marginScaleBps: 2_500, maxLeverage: 20, initialMarginBps: 500, maintenanceMarginBps: 300 } } };
  assert.equal(markAccount(fromRead, unscaled).maintenanceMargin, (3_750n * USDC).toString());
});

test("liquidation estimate after a trade applies it at the touch", () => {
  const snap = flatSnapshot(2_500), state = emptyAccount("0xabc", snap);
  state.collateral = (1_000n * USDC).toString();
  assert.equal(estimateLiquidationPrice(state, snap, "BTC"), null);
  // 20k long on 1k margin (20x): 0.2 BTC, health 1k + 0.2 (P - 100k) - 0.2 P * 3% = 0 at P ≈ 97_938.
  near(estimateLiquidationPrice(state, snap, "BTC", 20_000n * USDC), 97_938_144_329n);
  // A short of the same size liquidates above the mid.
  const short = estimateLiquidationPrice(state, snap, "BTC", -20_000n * USDC)!;
  assert.ok(short > 100_000n * USDC);
});

test("markets beyond the launch pair are marked from the snapshot", () => {
  const withSol: MarketSnapshot = {
    ...snapshot,
    markets: { ...snapshot.markets, SOL: { ...market("SOL", 199n * USDC, 201n * USDC), marginScaleBps: 5_000, maxLeverage: 10 } },
  };
  const state = emptyAccount("0xabc", withSol);
  assert.deepEqual(Object.keys(state.positions), ["BTC", "ETH", "SOL"]);
  state.collateral = (1_000n * USDC).toString();
  state.positions.SOL = { ...state.positions.SOL, size: (10n * BASE).toString(), entryPrice: (200n * USDC).toString() };
  const marked = markAccount(state, withSol);
  assert.equal(marked.positions.SOL.notional, (2_010n * USDC).toString());
  // 10% scaled initial margin (20% x 0.5).
  assert.equal(marked.initialMargin, (201n * USDC).toString());
  assert.deepEqual(openMarkets(marked), ["SOL"]);
  assert.equal(hasPosition(marked, "DOGE"), false);
});

test("liquidationPrice is null for a flat leg and the mid when already unhealthy", () => {
  const leg = { market: "BTC", size: BASE, entryPrice: 100_000n * USDC, bid: 100_000n * USDC, ask: 100_000n * USDC, mid: 100_000n * USDC, scaleBps: 10_000 };
  assert.equal(liquidationPrice(0n, [{ ...leg, size: 0n }], "BTC"), null);
  assert.equal(liquidationPrice(1n * USDC, [leg], "BTC"), 100_000n * USDC);
});
