import assert from "node:assert/strict";
import test from "node:test";
import { partialCloseDelta } from "./close-size.js";

test("partial close delta reduces longs and shorts without flipping", () => {
  assert.equal(partialCloseDelta(8_000n, 2_500), -2_000n);
  assert.equal(partialCloseDelta(-8_000n, 7_500), 6_000n);
  assert.equal(partialCloseDelta(8_000n, 10_000), -8_000n);
});

test("partial close delta rejects invalid or unrepresentable requests", () => {
  assert.throws(() => partialCloseDelta(0n, 5_000), /already closed/);
  assert.throws(() => partialCloseDelta(10n, 0), /invalid close percentage/);
  assert.throws(() => partialCloseDelta(1n, 2_500), /minimum position unit/);
});
