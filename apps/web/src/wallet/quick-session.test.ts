import assert from "node:assert/strict";
import { test } from "node:test";
import { QUICK_LIMITS, allMarketsMask, maskIncludes, quickSessionRequest, sessionCovers, type QuickSession } from "./quick-session.js";

test("the session mask covers every registered market", () => {
  assert.equal(allMarketsMask(1), 1);
  assert.equal(allMarketsMask(2), 3);
  assert.equal(allMarketsMask(5), 31);
  assert.equal(allMarketsMask(53), Number.MAX_SAFE_INTEGER);
  assert.equal(allMarketsMask(54), ((1n << 54n) - 1n).toString());
  assert.equal(allMarketsMask(128), ((1n << 128n) - 1n).toString());
  for (const invalid of [0, 129, 2.5]) assert.throws(() => allMarketsMask(invalid));
  assert.deepEqual(quickSessionRequest(3), { ...QUICK_LIMITS, marketMask: 7 });
});

test("mask membership and session coverage by market", () => {
  assert.equal(maskIncludes(7, 2), true);
  assert.equal(maskIncludes(3, 2), false);
  assert.equal(maskIncludes(((1n << 100n) - 1n).toString(), 99), true);
  const session: QuickSession = { account: "0x1", sessionAddress: "0x2", validUntil: Date.now() + 3_600_000, privateKey: "0x01", marketMask: "7" };
  assert.equal(sessionCovers(session, 2_500_000_000n, 2), true);
  assert.equal(sessionCovers(session, 2_500_000_001n, 2), false);
  assert.equal(sessionCovers(session, 1n, 3), false);
  // Sessions saved before the mask was stored cover the launch markets only.
  assert.equal(sessionCovers({ ...session, marketMask: undefined }, 1n, 1), true);
  assert.equal(sessionCovers({ ...session, marketMask: undefined }, 1n, 2), false);
  assert.equal(sessionCovers({ ...session, privateKey: undefined }, 1n), false);
});
