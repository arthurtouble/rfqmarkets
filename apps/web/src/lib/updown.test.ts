import assert from "node:assert/strict";
import { test } from "node:test";
import { appendTick, betNotional, multiplierChoices, onePercentGain, pickMultiplier } from "./updown.js";

const USDC = 1_000_000n;

test("multipliers stop at the market's maximum", () => {
  assert.deepEqual(multiplierChoices(20), [2, 3, 5, 10]);
  assert.deepEqual(multiplierChoices(5), [2, 3, 5]);
  assert.deepEqual(multiplierChoices(1.5), [1]);
});

test("a chosen multiplier the market does not allow falls back to the closest one below", () => {
  assert.equal(pickMultiplier(3, [2, 3, 5, 10]), 3);
  assert.equal(pickMultiplier(10, [2, 3, 5]), 5);
  assert.equal(pickMultiplier(4, [2, 3, 5]), 3);
  assert.equal(pickMultiplier(1, [2, 3]), 2);
});

test("a $25 stake at 3× is a $75 position and a 1% move is worth 75 cents", () => {
  const notional = betNotional(25n * USDC, 3);
  assert.equal(notional, 75n * USDC);
  assert.equal(onePercentGain(notional), 750_000n);
});

test("the tick line keeps a moving window and ignores repeated snapshots", () => {
  let points = appendTick([], { time: 1_000, value: 100 }, 10_000, 3);
  points = appendTick(points, { time: 1_000, value: 101 }, 10_000, 3);
  assert.deepEqual(points, [{ time: 1_000, value: 100 }]);
  points = appendTick(points, { time: 2_000, value: 101 }, 10_000, 3);
  points = appendTick(points, { time: 3_000, value: 102 }, 10_000, 3);
  points = appendTick(points, { time: 4_000, value: 103 }, 10_000, 3);
  assert.deepEqual(
    points.map((point) => point.time),
    [2_000, 3_000, 4_000],
  );
  points = appendTick(points, { time: 13_500, value: 104 }, 10_000, 3);
  assert.deepEqual(
    points.map((point) => point.time),
    [4_000, 13_500],
  );
});
