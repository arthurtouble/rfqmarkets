import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SLIPPAGE_BPS, DEFAULT_TRIGGER_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS, MIN_SLIPPAGE_BPS, clampSlippageBps, isValidSlippageBps, parseSlippagePercent, slippageToPercent } from "./slippage.js";

test("slippage bounds match the API (1..500 bps, quote default 8, trigger default 100)", () => {
  assert.equal(MIN_SLIPPAGE_BPS, 1);
  assert.equal(MAX_SLIPPAGE_BPS, 500);
  assert.equal(DEFAULT_SLIPPAGE_BPS, 8);
  assert.equal(DEFAULT_TRIGGER_SLIPPAGE_BPS, 100);
  for (const valid of [1, 8, 500]) assert.equal(isValidSlippageBps(valid), true);
  for (const invalid of [0, 501, 2.5, -1, Number.NaN, "8"]) assert.equal(isValidSlippageBps(invalid), false);
});

test("clamps to the accepted range and falls back when unset", () => {
  assert.equal(clampSlippageBps(0), 1);
  assert.equal(clampSlippageBps(9_999), 500);
  assert.equal(clampSlippageBps(12.6), 13);
  assert.equal(clampSlippageBps(undefined), 8);
  assert.equal(clampSlippageBps(null, 100), 100);
  assert.equal(clampSlippageBps(Number.NaN), 8);
});

test("parses typed percentages into bps", () => {
  assert.equal(parseSlippagePercent("0.08"), 8);
  assert.equal(parseSlippagePercent("0.5%"), 50);
  assert.equal(parseSlippagePercent(" 5 "), 500);
  assert.equal(parseSlippagePercent(".25"), 25);
  for (const invalid of ["", "0", "0.001", "5.01", "6", "-1", "abc", "1e1"]) assert.equal(parseSlippagePercent(invalid), null, invalid);
  assert.equal(slippageToPercent(8), "0.08");
  assert.equal(slippageToPercent(50), "0.5");
  assert.equal(slippageToPercent(500), "5");
});
