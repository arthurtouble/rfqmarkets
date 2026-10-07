import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder } from "ethers";
import { USDC, marginRate } from "../packages/shared/src/pricing.js";
import {
  marketMid,
  marketNotional,
  toExposureBook,
  toExposureMarket,
  toPosition,
  toSession,
} from "../packages/shared/src/clearing-structs.js";
import { MARKETS, marketIndex, marketName, otherMarketIndex } from "../packages/shared/src/markets.js";
import {
  BASE,
  MASK,
  abs,
  ceilDiv,
  decodeMarketLimitWord,
  high128,
  low128,
} from "../packages/shared/src/numeric.js";
import {
  decodeLocalReport,
  encodeLocalReport,
  ORACLE_OBSERVATION_TUPLE,
} from "../packages/shared/src/oracle-report.js";

test("numeric helpers", () => {
  assert.equal(abs(-3n), 3n);
  assert.equal(abs(3n), 3n);
  assert.equal(ceilDiv(7n, 2n), 4n);
  assert.equal(ceilDiv(8n, 2n), 4n);
  const word = 5n | (9n << 128n);
  assert.equal(low128(word), 5n);
  assert.equal(high128(word), 9n);
  assert.equal(low128(MASK + 1n), 0n);
  assert.deepEqual(decodeMarketLimitWord(word.toString()), { maxTradeNotional: 5n, maxMarketNotional: 9n });
});

test("market index mapping", () => {
  assert.deepEqual(MARKETS, ["BTC", "ETH"]);
  assert.equal(marketIndex("BTC"), 0);
  assert.equal(marketIndex("ETH"), 1);
  assert.equal(marketName(1n), "ETH");
  assert.equal(otherMarketIndex(0), 1);
  assert.throws(() => marketName(2), /unknown market index/);
});

test("local oracle report codec round-trips the adapter tuple array", () => {
  const observation = { market: 1n, bid: 10n, ask: 11n, observedAt: 12n, validUntil: 13n };
  const report = encodeLocalReport({ ...observation, market: 1 });
  assert.equal(
    report,
    AbiCoder.defaultAbiCoder().encode([`${ORACLE_OBSERVATION_TUPLE}[]`], [[[1, 10n, 11n, 12n, 13n]]]),
  );
  assert.deepEqual(decodeLocalReport(report), [observation]);
  const pair = encodeLocalReport([{ ...observation, market: 0 }, observation]);
  assert.deepEqual(
    decodeLocalReport(pair).map((item) => item.market),
    [0n, 1n],
  );
});

test("clearing struct converters normalize ethers results to bigint models", () => {
  const market = toExposureMarket({
    aggregateBase: "-2000000000000000000",
    fundingIndex: 1,
    fundingTime: 2n,
    lastPriceTime: 3n,
    lastBid: 99n,
    lastAsk: 101n,
    enabled: 1,
  });
  assert.equal(market.enabled, true);
  assert.equal(marketMid(market), 100n);
  assert.equal(marketNotional(market), -200n);
  assert.equal(marketNotional(market, 50n), -100n);
  assert.deepEqual(toExposureBook({ longBase: 1, shortBase: "2", limits: 3n, ready: false }), {
    longBase: 1n,
    shortBase: 2n,
    limits: 3n,
    ready: false,
  });
  assert.deepEqual(toPosition({ size: -1, entryPrice: 2, lastFundingIndex: -3 }), {
    size: -1n,
    entryPrice: 2n,
    lastFundingIndex: -3n,
  });
  assert.equal(
    toSession({
      account: "0x1",
      validUntil: 1,
      marketMask: 3n,
      maxTradeNotional: 1,
      maxCumulativeNotional: 1,
      usedNotional: 0,
      maxFee: BASE,
    }).marketMask,
    3,
  );
});

test("margin tiers keep the top tier above 5M notional, as the contract does", () => {
  assert.deepEqual(
    [marginRate(5_000_000n * USDC, true), marginRate(5_000_000n * USDC, false)],
    [10_000n, 6_000n],
  );
  assert.deepEqual(
    [marginRate(9_000_000n * USDC, true), marginRate(9_000_000n * USDC, false)],
    [10_000n, 6_000n],
  );
  assert.deepEqual([marginRate(25_000n * USDC, true), marginRate(25_000n * USDC, false)], [2_000n, 1_200n]);
});
