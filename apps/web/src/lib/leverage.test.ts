import assert from "node:assert/strict";
import { test } from "node:test";
import { clampLeverage, leveragePresets, marginForScale, marginFromLeverage, maxLeverageAt, sizeFromLeverage } from "./leverage.js";

const USDC = 1_000_000n;

test("sizes notional from margin and leverage in exact integers", () => {
  assert.equal(sizeFromLeverage(100n * USDC, 5), 500n * USDC);
  assert.equal(sizeFromLeverage(100n * USDC, 2.5), 250n * USDC);
  assert.equal(sizeFromLeverage(100n * USDC, 20), 2_000n * USDC);
  // Leverage below 0.01x precision rounds down.
  assert.equal(sizeFromLeverage(100n * USDC, 1.239), 123n * USDC);
  for (const leverage of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(sizeFromLeverage(100n * USDC, leverage), 0n);
  assert.equal(sizeFromLeverage(0n, 5), 0n);
});

test("margin for a notional at a leverage rounds up", () => {
  assert.equal(marginFromLeverage(500n * USDC, 5), 100n * USDC);
  assert.equal(marginFromLeverage(1_000n, 3), 334n);
  assert.equal(marginFromLeverage(1_000n, 0), 0n);
});

test("presets keep standard steps below the market max and end at the max", () => {
  assert.deepEqual(leveragePresets(20), [2, 5, 10, 20]);
  assert.deepEqual(leveragePresets(5), [2, 5]);
  assert.deepEqual(leveragePresets(10), [2, 5, 10]);
  assert.deepEqual(leveragePresets(3.33), [2, 3.33]);
  assert.deepEqual(leveragePresets(1), [1]);
  assert.deepEqual(leveragePresets(40, [10, 2, 25, 2]), [2, 10, 25, 40]);
  assert.deepEqual(leveragePresets(0), []);
});

test("max leverage follows the scaled tiers", () => {
  assert.deepEqual(marginForScale(10_000), { marginScaleBps: 10_000, maxLeverage: 5, initialMarginBps: 2_000, maintenanceMarginBps: 1_200 });
  assert.deepEqual(marginForScale(2_500), { marginScaleBps: 2_500, maxLeverage: 20, initialMarginBps: 500, maintenanceMarginBps: 300 });
  assert.equal(maxLeverageAt(0n, 2_500), 20);
  // 50k notional sits in the 25% tier: 6.25% scaled at 0.25x.
  assert.equal(maxLeverageAt(50_000n * USDC, 2_500), 16);
  assert.equal(maxLeverageAt(50_000n * USDC), 4);
  // The scaled rate is capped at 100% of notional.
  assert.equal(maxLeverageAt(10_000_000n * USDC, 50_000), 1);
});

test("clamps leverage into [1, max]", () => {
  assert.equal(clampLeverage(50, 20), 20);
  assert.equal(clampLeverage(0.2, 20), 1);
  assert.equal(clampLeverage(7.5, 20), 7.5);
  assert.equal(clampLeverage(Number.NaN, 20), 1);
});
