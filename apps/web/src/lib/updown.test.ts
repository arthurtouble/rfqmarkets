import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendTick,
  betNotional,
  cashOutValue,
  feeWords,
  lossAt,
  multiplierChoices,
  onePercentGain,
  pickMultiplier,
  stakeProblem,
  tradeFee,
} from "./updown.js";

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

test("the loss at the auto-close price follows the move, either way", () => {
  // A $1,000 position entered at $2,000: a 10% drop to $1,800 loses $100, as does a rise to $2,200.
  assert.equal(lossAt(1_000n * USDC, 2_000n * USDC, 1_800n * USDC), 100n * USDC);
  assert.equal(lossAt(1_000n * USDC, 2_000n * USDC, 2_200n * USDC), 100n * USDC);
  assert.equal(lossAt(1_000n * USDC, 0n, 1_800n * USDC), 0n);
});

test("Home asks for at least the isolated account's opening amount", () => {
  // Below it the trade would quietly use the whole balance, so it could lose more than the amount.
  assert.equal(stakeProblem(9_990_000n), "The smallest trade is $10");
  assert.equal(stakeProblem(10n * USDC), null);
  assert.equal(stakeProblem(null), null);
});

test("the fee line follows the venue's fee", () => {
  assert.equal(feeWords(20n * USDC, 0), "no fees");
  assert.equal(tradeFee(20n * USDC, 5), 10_000n);
  assert.equal(feeWords(20n * USDC, 5), "a $0.01 fee");
  assert.equal(feeWords(1_000n * USDC, 2.5), "a $0.30 fee");
});

test("cash out shows what comes back to the balance, not the PnL", () => {
  // $25 in, down $3.20: $21.80 comes back.
  assert.equal(cashOutValue(21_800_000n, 75n * USDC, 0), 21_800_000n);
  assert.equal(cashOutValue(21_800_000n, 100n * USDC, 10), 21_700_000n);
  assert.equal(cashOutValue(-2n * USDC, 100n * USDC, 0), 0n);
});
