import assert from "node:assert/strict";
import { test } from "node:test";
import { FEE_TIERS, discountedFee, feeTierFor, feeTierWindow, nextFeeTier } from "./fee-tiers.js";

const USDC = 1_000_000n;

test("tiers follow 14-day volume and the discount never undercharges", () => {
  assert.equal(feeTierFor(0n).tier, 0);
  assert.equal(feeTierFor(5_000_000n * USDC - 1n).tier, 0);
  assert.equal(feeTierFor(5_000_000n * USDC).tier, 1);
  assert.equal(feeTierFor(10n ** 30n).tier, 4);
  assert.equal(nextFeeTier(FEE_TIERS[1])?.tier, 2);
  assert.equal(nextFeeTier(FEE_TIERS[4]), undefined);
  assert.equal(discountedFee(200n, 0), 200n);
  assert.equal(discountedFee(200n, 1_100), 178n);
  // 3 * 11% = 0.33 waived rounds down to 0.
  assert.equal(discountedFee(3n, 1_100), 3n);
});

test("the window is the 14 full UTC days before today", () => {
  const day = 86_400_000,
    window = feeTierWindow(20 * day + 5);
  assert.deepEqual(window, { startMs: 6 * day, endMs: 20 * day });
});
