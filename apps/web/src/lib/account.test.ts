import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyAccount, initialMarginAfter, markAccount } from "./account.js";
import type { MarketSnapshot, MarketState } from "./types.js";

const USDC = 1_000_000n, BASE = 10n ** 18n;
const market = (name: "BTC" | "ETH", bid: bigint, ask: bigint): MarketState => ({
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
