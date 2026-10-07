import assert from "node:assert/strict";
import test from "node:test";
import { base, integer, percent, price, shortId, signedBase, usd } from "./format.js";

const E18 = 10n ** 18n;

test("usd shows whole dollars, and cents for small amounts", () => {
  assert.equal(usd("25000000000"), "$25,000");
  assert.equal(usd("12345678"), "$12.35");
  assert.equal(usd("0"), "$0");
  assert.equal(usd(undefined), "—");
  assert.equal(price("120240000000"), "$120,240.00");
});

test("base sizes and signs", () => {
  assert.equal(base(String(E18 / 8n)), "0.125");
  assert.equal(base(String(E18 / 3n), 2), "0.33");
  assert.equal(signedBase(String(E18)), "+1");
  assert.equal(signedBase(String(-3n * E18)), "−3");
  assert.equal(signedBase("0"), "0");
  assert.equal(signedBase(null), "—");
});

test("integers, percents and ids", () => {
  assert.equal(integer(36712345), "36,712,345");
  assert.equal(integer(-1), "—", "the hedger reports block -1 before its first read");
  assert.equal(percent(7.25), "7.3%");
  assert.equal(percent(75), "75%");
  assert.equal(shortId("0x8f1d2c3b4a5968778695a4b3c2d1e0f1"), "0x8f1d2c…e0f1");
});
