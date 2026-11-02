import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SESSION_LIMITS,
  allMarketsMask,
  forgetSessionKeys,
  maskIncludes,
  quickSessionRequest,
  sessionCovers,
  type QuickSession,
} from "./quick-session.js";

test("the session mask covers every registered market", () => {
  assert.equal(allMarketsMask(1), 1);
  assert.equal(allMarketsMask(2), 3);
  assert.equal(allMarketsMask(5), 31);
  assert.equal(allMarketsMask(53), Number.MAX_SAFE_INTEGER);
  assert.equal(allMarketsMask(54), ((1n << 54n) - 1n).toString());
  assert.equal(allMarketsMask(128), ((1n << 128n) - 1n).toString());
  for (const invalid of [0, 129, 2.5]) assert.throws(() => allMarketsMask(invalid));
  assert.deepEqual(quickSessionRequest(3), {
    // Any trade the protocol allows: the largest position a market may hold, and no total limit.
    maxTradeAmount: "5000000",
    maxCumulativeAmount: "340282366920938463463374607431768.211455",
    // 10 bps of the per-trade limit.
    maxFee: "5000",
    durationSeconds: 7 * 24 * 60 * 60,
    marketMask: 7,
  });
});

test("the trading key has no limit of its own", () => {
  assert.equal(SESSION_LIMITS.maxTradeMicro, 5_000_000n * 1_000_000n);
  assert.equal(SESSION_LIMITS.maxCumulativeMicro, (1n << 128n) - 1n);
});

test("mask membership and session coverage by market", () => {
  assert.equal(maskIncludes(7, 2), true);
  assert.equal(maskIncludes(3, 2), false);
  assert.equal(maskIncludes(((1n << 100n) - 1n).toString(), 99), true);
  const session: QuickSession = {
    account: "0x1",
    sessionAddress: "0x2",
    validUntil: Date.now() + 3_600_000,
    privateKey: "0x01",
    marketMask: "7",
    maxTradeNotional: "50000000",
    maxFee: "50000",
  };
  assert.equal(sessionCovers(session, 50_000_000n, 2), true);
  assert.equal(sessionCovers(session, 50_000_001n, 2), false);
  assert.equal(sessionCovers(session, 1n, 3), false);
  // Sessions saved before the mask was stored cover the launch markets only.
  assert.equal(sessionCovers({ ...session, marketMask: undefined }, 1n, 1), true);
  assert.equal(sessionCovers({ ...session, marketMask: undefined }, 1n, 2), false);
  assert.equal(sessionCovers({ ...session, privateKey: undefined }, 1n), false);
  // The trade's fee must fit the key's fee cap: 50 USDC at 4 bps is 0.02, at 11 bps 0.055.
  assert.equal(sessionCovers(session, 50_000_000n, 2, 4), true);
  assert.equal(sessionCovers(session, 50_000_000n, 2, 10), true);
  assert.equal(sessionCovers(session, 50_000_000n, 2, 11), false);
  assert.equal(sessionCovers({ ...session, maxFee: "1" }, 10_000_000n, 2, 4), false);
});

test("sessions expire 30 seconds early and keys can be forgotten", () => {
  const base: QuickSession = {
    account: "0x1",
    sessionAddress: "0x2",
    validUntil: Date.now() + 3_600_000,
    privateKey: "0x01",
    marketMask: "3",
    maxTradeNotional: "50000000",
    maxFee: "50000",
  };
  assert.equal(sessionCovers({ ...base, validUntil: Date.now() + 20_000 }, 1n, 0), false);
  assert.equal(sessionCovers({ ...base, validUntil: Date.now() + 60_000 }, 1n, 0), true);
  assert.equal(sessionCovers(null, 1n, 0), false);
  assert.doesNotThrow(() => forgetSessionKeys());
});
