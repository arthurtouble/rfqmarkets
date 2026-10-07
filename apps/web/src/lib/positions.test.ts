import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyAccount, markAccount } from "./account.js";
import { closeAllPreview, closePreview, fillAction, fillRealizes, isNearLiquidation, openPositions, positionView } from "./positions.js";
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

/** 10,000 USDC with 0.1 BTC long from 99,000 and 2 ETH short from 4,100. */
function account(collateral = 10_000n * USDC) {
  const state = emptyAccount("0xabc", snapshot);
  state.collateral = collateral.toString();
  state.positions.BTC = { ...state.positions.BTC, size: (BASE / 10n).toString(), entryPrice: (99_000n * USDC).toString() };
  state.positions.ETH = { ...state.positions.ETH, size: (-2n * BASE).toString(), entryPrice: (4_100n * USDC).toString() };
  return markAccount(state, snapshot);
}

test("a position view carries side, size, PnL, margin and return on margin", () => {
  const btc = positionView(account(), "BTC")!;
  assert.equal(btc.long, true);
  assert.equal(btc.size, BASE / 10n);
  assert.equal(btc.markPrice, 99_990n * USDC);
  assert.equal(btc.pnl, 99n * USDC);
  assert.equal(btc.notional, 10_001n * USDC);
  assert.equal(btc.margin, 2_000_200_000n);
  assert.ok(Math.abs(btc.roe! - 99 / 2_000.2) < 1e-6);

  const eth = positionView(account(), "ETH")!;
  assert.equal(eth.long, false);
  assert.equal(eth.size, 2n * BASE);
  assert.equal(eth.markPrice, 4_001n * USDC);
  assert.equal(eth.pnl, 198n * USDC);
  assert.equal(positionView(emptyAccount("0xabc", snapshot), "BTC"), null);
});

test("open positions are listed largest first and skip flat markets", () => {
  assert.deepEqual(openPositions(account()).map(view => view.market), ["BTC", "ETH"]);
  assert.deepEqual(openPositions(emptyAccount("0xabc", snapshot)), []);
  assert.deepEqual(openPositions(null), []);
});

test("liquidation distance flags positions within 10% of their liquidation price", () => {
  const safe = positionView(account(), "BTC")!;
  assert.equal(isNearLiquidation(safe), false);
  // 2,000 USDC behind ~18,000 USDC of positions sits just above maintenance margin.
  const thin = positionView(account(2_000n * USDC), "BTC")!;
  assert.ok(thin.liquidationPrice !== null && thin.liquidationPrice < thin.markPrice);
  assert.ok(thin.liquidationDistance! > 0 && thin.liquidationDistance! < 0.1, String(thin.liquidationDistance));
  assert.equal(isNearLiquidation(thin), true);
});

test("a partial close realizes its share at the exit side and rounds the size down", () => {
  const btc = positionView(account(), "BTC")!;
  const half = closePreview(btc, 5_000, snapshot.markets.BTC);
  assert.equal(half.price, 99_990n * USDC);
  assert.equal(half.closingSize, BASE / 20n);
  assert.equal(half.remainingSize, BASE / 20n);
  assert.equal(half.realizedPnl, 49_500_000n);
  assert.equal(half.closingNotional, 4_999_500_000n);

  const eth = positionView(account(), "ETH")!;
  const quarter = closePreview(eth, 2_500, snapshot.markets.ETH);
  assert.equal(quarter.price, 4_001n * USDC);
  assert.equal(quarter.closingSize, BASE / 2n);
  assert.equal(quarter.realizedPnl, 49_500_000n);

  const odd = closePreview({ ...btc, size: 3n }, 5_000, snapshot.markets.BTC);
  assert.equal(odd.closingSize, 1n);
  assert.equal(odd.remainingSize, 2n);
});

test("a close preview can use the firm quote's price and falls back to the mark", () => {
  const btc = positionView(account(), "BTC")!;
  assert.equal(closePreview(btc, 10_000, null, 100_000n * USDC).realizedPnl, 100n * USDC);
  assert.equal(closePreview(btc, 10_000).price, btc.markPrice);
});

test("close-all totals every position", () => {
  const views = openPositions(account());
  const total = closeAllPreview(views, snapshot.markets);
  assert.equal(total.count, 2);
  assert.equal(total.realizedPnl, 99n * USDC + 198n * USDC);
  assert.equal(total.notional, 9_999n * USDC + 8_002n * USDC);
});

test("fill actions describe what a trade did to the position", () => {
  const fill = (before: bigint, after: bigint, kind: "trade" | "close" | "liquidation" = "trade") => ({ kind, sizeBefore: before.toString(), sizeAfter: after.toString() });
  assert.equal(fillAction(fill(0n, 5n)), "Open long");
  assert.equal(fillAction(fill(0n, -5n)), "Open short");
  assert.equal(fillAction(fill(5n, 8n)), "Add to long");
  assert.equal(fillAction(fill(-5n, -8n)), "Add to short");
  assert.equal(fillAction(fill(5n, 2n)), "Reduce long");
  assert.equal(fillAction(fill(-5n, -2n)), "Reduce short");
  assert.equal(fillAction(fill(5n, 0n, "close")), "Close long");
  assert.equal(fillAction(fill(-5n, 0n)), "Close short");
  assert.equal(fillAction(fill(5n, -1n)), "Flip to short");
  assert.equal(fillAction(fill(-5n, 1n)), "Flip to long");
  assert.equal(fillAction(fill(5n, 0n, "liquidation")), "Liquidated");
  assert.equal(fillRealizes(fill(0n, 5n)), false);
  assert.equal(fillRealizes(fill(5n, 8n)), false);
  assert.equal(fillRealizes(fill(5n, 2n)), true);
  assert.equal(fillRealizes(fill(5n, -1n)), true);
});
