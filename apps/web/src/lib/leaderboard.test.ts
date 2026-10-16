import assert from "node:assert/strict";
import { test } from "node:test";
import { countdown, findTrader, pointsLabel, pointsSummary, weekEnd, weekStart } from "./leaderboard.js";
import type { LeaderboardEntry, Points } from "./types.js";

const WEEK = 7 * 86_400_000;

test("points weeks start on Thursday 00:00 UTC, like the indexer", () => {
  const now = Date.UTC(2026, 9, 16, 5, 30); // Friday 16 October 2026
  assert.equal(new Date(weekStart(now)).toISOString(), "2026-10-15T00:00:00.000Z");
  assert.equal(weekEnd(now) - weekStart(now), WEEK);
  assert.equal(weekStart(weekStart(now)), weekStart(now));
});

test("pointsSummary picks out this week and the total", () => {
  const now = Date.UTC(2026, 9, 16);
  const points: Points = {
    account: "0x1",
    finality: "included",
    indexedBlock: 1,
    accounts: ["0x1"],
    total: "130",
    weeks: [
      { weekStartMs: weekStart(now) - WEEK, volume: "10000000000", points: "100" },
      { weekStartMs: weekStart(now), volume: "3000000000", points: "30" },
    ],
    referees: 0,
    referralPoints: "0",
    totalWithReferrals: "130",
  };
  assert.deepEqual(pointsSummary(points, now), { thisWeek: 30n, total: 130n });
  assert.deepEqual(pointsSummary(points, now + WEEK), { thisWeek: 0n, total: 130n });
  assert.deepEqual(pointsSummary(undefined, now), { thisWeek: 0n, total: 0n });
});

test("findTrader matches addresses whatever their case", () => {
  const entry: LeaderboardEntry = {
    rank: 2,
    account: "0xAbC0000000000000000000000000000000000001",
    volume: "1",
    netPnl: "0",
    tradeCount: 1,
    points: "0",
  };
  assert.equal(findTrader([entry], "0xabc0000000000000000000000000000000000001"), entry);
  assert.equal(findTrader([entry], "0x0000000000000000000000000000000000000002"), undefined);
  assert.equal(findTrader([entry], null), undefined);
});

test("labels", () => {
  assert.equal(pointsLabel(1234567n), "1,234,567");
  assert.equal(pointsLabel("0"), "0");
  assert.equal(countdown(Date.UTC(2026, 0, 4, 6), Date.UTC(2026, 0, 1, 2)), "3d 4h");
  assert.equal(countdown(Date.UTC(2026, 0, 1, 7, 12), Date.UTC(2026, 0, 1, 2)), "5h 12m");
  assert.equal(countdown(0, 1), "0h 0m");
});
