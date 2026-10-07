import assert from "node:assert/strict";
import { test } from "node:test";
import { replayPortfolio, type PortfolioEvent } from "./portfolio.js";
import { POINTS_WEEK_MS, mergeByOwner, rankTraders, weeklyPoints, windowStats } from "./leaderboard.js";

const E = 10n ** 18n,
  usdc = (value: number) => BigInt(value) * 1_000_000n,
  HOUR = 3_600;
let sequence = 0;
/** A TradeExecuted at `hour` hours after the epoch. */
const trade = (hour: number, delta: bigint, price: bigint, fee = 0n): PortfolioEvent => ({
  txHash: `0x${(sequence + 1).toString(16).padStart(64, "0")}`,
  logIndex: sequence++,
  blockNumber: hour,
  timestamp: hour * HOUR,
  kind: "TradeExecuted",
  payload: { market: "0", baseDelta: delta.toString(), price: price.toString(), fee: fee.toString() },
});

test("window stats count only fills and PnL inside the window", () => {
  // Buy 1 at 100, sell half at 120 (+10), then a day later sell the rest at 90 (-5).
  const replay = replayPortfolio([
    trade(1, E, usdc(100), usdc(1)),
    trade(2, -E / 2n, usdc(120)),
    trade(30, -E / 2n, usdc(90)),
  ]);
  const all = windowStats(replay, -Infinity);
  assert.equal(all.volume, usdc(100 + 60 + 45));
  assert.equal(all.netPnl, usdc(10 - 1 - 5));
  assert.equal(all.tradeCount, 3);
  const lastDay = windowStats(replay, 29 * HOUR * 1_000);
  assert.equal(lastDay.volume, usdc(45));
  assert.equal(lastDay.netPnl, -usdc(5));
  assert.equal(lastDay.tradeCount, 1);
  assert.deepEqual(windowStats(replayPortfolio([]), 0), { volume: 0n, netPnl: 0n, tradeCount: 0 });
});

test("isolated accounts merge into their owner and ranking is stable", () => {
  const stats = new Map([
    ["0xA", { volume: usdc(100), netPnl: usdc(5), tradeCount: 1 }],
    ["0xA-isolated", { volume: usdc(300), netPnl: -usdc(2), tradeCount: 2 }],
    ["0xB", { volume: usdc(350), netPnl: usdc(9), tradeCount: 3 }],
    ["0xC", { volume: usdc(350), netPnl: usdc(1), tradeCount: 1 }],
    ["0xD", { volume: 0n, netPnl: 0n, tradeCount: 0 }],
  ]);
  const merged = mergeByOwner(stats, (account) => (account === "0xA-isolated" ? "0xA" : undefined));
  assert.deepEqual(merged.get("0xA")?.accounts, ["0xA", "0xA-isolated"]);
  const byVolume = rankTraders(merged, "volume", 10);
  assert.deepEqual(
    byVolume.map((row) => [row.rank, row.account, row.volume, row.points]),
    [
      [1, "0xA", usdc(400).toString(), "4"],
      [2, "0xB", usdc(350).toString(), "3"],
      [3, "0xC", usdc(350).toString(), "3"],
    ],
  );
  assert.deepEqual(
    rankTraders(merged, "pnl", 2).map((row) => row.account),
    ["0xB", "0xA"],
  );
});

test("weekly points sum trade notional across an owner's accounts", () => {
  const weekHours = POINTS_WEEK_MS / 3_600_000,
    owner = replayPortfolio([trade(1, E, usdc(250)), trade(weekHours + 1, -E, usdc(250))]),
    isolated = replayPortfolio([trade(2, E, usdc(199))]);
  const points = weeklyPoints([owner, isolated]);
  assert.deepEqual(points.weeks, [
    { weekStartMs: 0, volume: usdc(449).toString(), points: "4" },
    { weekStartMs: POINTS_WEEK_MS, volume: usdc(250).toString(), points: "2" },
  ]);
  assert.equal(points.total, "6");
});
