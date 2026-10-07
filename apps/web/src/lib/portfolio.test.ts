import assert from "node:assert/strict";
import { test } from "node:test";
import { pnlSeries, seriesChange } from "./portfolio.js";
import type { PortfolioPoint } from "./types.js";

const HOUR = 3_600_000, NOW = 1_800_000_000_000;
const point = (hoursAgo: number, netPnl: bigint): PortfolioPoint => ({
  timeMs: NOW - hoursAgo * HOUR, blockNumber: 0, realizedPnl: "0", fees: "0", funding: "0", liquidationPenalties: "0",
  netPnl: netPnl.toString(), netDeposits: "0", collateral: "0",
});

test("a range starts from the PnL carried into it and ends at the live value", () => {
  const points = [point(72, -5n), point(30, 20n), point(5, 50n), point(1, 40n)];
  const day = pnlSeries(points, "1d", NOW, 7n);
  assert.deepEqual(day.map(item => item.value), [20n, 50n, 40n, 47n]);
  assert.equal(day[0].timeMs, NOW - 24 * HOUR);
  assert.equal(day.at(-1)!.timeMs, NOW);
  assert.equal(seriesChange(day), 27n);
});

test("all time starts at the first event, and an empty account draws a flat zero line", () => {
  const all = pnlSeries([point(72, -5n), point(1, 40n)], "all", NOW);
  assert.deepEqual(all.map(item => item.value), [0n, -5n, 40n, 40n]);
  assert.equal(all[0].timeMs, NOW - 72 * HOUR);
  assert.equal(pnlSeries([point(1, 40n)], "all", NOW)[0].timeMs, NOW - 24 * HOUR);
  const empty = pnlSeries([], "1w", NOW);
  assert.deepEqual(empty.map(item => item.value), [0n, 0n]);
  assert.equal(seriesChange(empty), 0n);
});

test("points arrive in any order", () => {
  assert.deepEqual(pnlSeries([point(1, 40n), point(5, 50n)], "1d", NOW).map(item => item.value), [0n, 50n, 40n, 40n]);
});
