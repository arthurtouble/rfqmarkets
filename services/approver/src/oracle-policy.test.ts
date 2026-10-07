import assert from "node:assert/strict";
import { test } from "node:test";
import { AbiCoder, keccak256 } from "ethers";
import {
  checkChainTimeOracle,
  checkOracleWidth,
  checkSubmittedReport,
  checkVerifiedObservation,
  observationOutsideWindow,
  safetyPrices,
} from "./oracle-policy.js";
import { PRICES, buildFixture, type PayloadOptions } from "./test-fixtures.js";

const error = (rejection: { body: { error: string } } | undefined) => rejection?.body.error;

function submitted(
  options: PayloadOptions = {},
  overrides: Partial<Parameters<typeof checkSubmittedReport>[0]> = {},
) {
  const fixture = buildFixture(options);
  return checkSubmittedReport({
    report: fixture.payload.report,
    oracleReportHash: fixture.approval.oracleReportHash,
    market: fixture.intent.market as 0 | 1,
    quote: fixture.payload.quote,
    oracle: {},
    nowMs: fixture.nowMs,
    maxFutureSeconds: 5,
    checkWallClock: true,
    ...overrides,
  });
}

test("observationOutsideWindow rejects future, expired and stale observations", () => {
  const window = (observedAt: bigint, validUntil: bigint) =>
    observationOutsideWindow({ observedAt, validUntil }, 1_000n, 5);
  assert.equal(window(1_000n, 1_010n), false);
  assert.equal(window(992n, 1_010n), false);
  assert.equal(window(1_005n, 1_010n), false);
  assert.equal(window(991n, 1_010n), true, "older than eight seconds");
  assert.equal(window(1_006n, 1_010n), true, "beyond clock-skew allowance");
  assert.equal(window(995n, 999n), true, "expired");
});

test("checkSubmittedReport accepts an empty report and a matching local report", () => {
  assert.deepEqual(submitted({}, { report: "0x" }), {});
  const result = submitted();
  assert.equal(result.rejection, undefined);
  assert.equal(result.observation?.bid, PRICES.BTC);
});

test("checkSubmittedReport rejects hash, decode, market, price and freshness mismatches", () => {
  assert.equal(
    error(submitted({}, { oracleReportHash: `0x${"00".repeat(32)}` }).rejection),
    "oracle hash mismatch",
  );
  assert.equal(
    error(submitted({}, { report: "0x1234", oracleReportHash: keccak256("0x1234") }).rejection),
    "oracle report rejected",
  );
  for (const report of [{ market: 1 }, { bid: PRICES.BTC - 1n }, { ask: PRICES.BTC + 1n }])
    assert.equal(
      error(submitted({ report }).rejection),
      "oracle report rejected",
      JSON.stringify(report, (_, v) => String(v)),
    );
  const nowMs = Date.now(),
    stale = { observedAt: BigInt(Math.floor(nowMs / 1000)) - 9n };
  assert.equal(error(submitted({ nowMs, report: stale }).rejection), "oracle report rejected");
  assert.equal(submitted({ nowMs, report: stale }, { checkWallClock: false }).rejection, undefined);
});

test("checkSubmittedReport rejects non-positive prices even when they match the quote", () => {
  const zero = buildFixture({ report: { bid: 0n, ask: 0n } });
  const result = checkSubmittedReport({
    report: zero.payload.report,
    oracleReportHash: zero.approval.oracleReportHash,
    market: 0,
    quote: { bid: "0", ask: "0" },
    oracle: {},
    nowMs: zero.nowMs,
    maxFutureSeconds: 5,
    checkWallClock: true,
  });
  assert.equal(error(result.rejection), "oracle report rejected");
});

test("Pyth reports only carry a market until verified on chain", () => {
  const report = AbiCoder.defaultAbiCoder().encode(["uint8", "bytes[]"], [0, ["0x01"]]),
    other = AbiCoder.defaultAbiCoder().encode(["uint8", "bytes[]"], [1, ["0x01"]]);
  const pyth = { oracle: { oracleMode: "pyth" as const } };
  assert.deepEqual(submitted({}, { ...pyth, report, oracleReportHash: keccak256(report) }), {});
  assert.equal(
    error(submitted({}, { ...pyth, report: other, oracleReportHash: keccak256(other) }).rejection),
    "oracle report rejected",
  );
  const observation = { market: 0n, bid: 10n, ask: 11n, observedAt: 1n, validUntil: 2n };
  assert.equal(checkVerifiedObservation(observation, 0), undefined);
  assert.equal(error(checkVerifiedObservation({ ...observation, market: 1n }, 0)), "oracle report rejected");
  assert.equal(error(checkVerifiedObservation({ ...observation, bid: 0n }, 0)), "oracle report rejected");
  assert.equal(error(checkVerifiedObservation({ ...observation, ask: 9n }, 0)), "oracle report rejected");
});

test("chain-time freshness and width checks use the safety prices", () => {
  const observation = { market: 0n, bid: 100n, ask: 101n, observedAt: 1_000n, validUntil: 1_060n };
  assert.equal(checkChainTimeOracle(undefined, 5_000, 5), undefined);
  assert.equal(checkChainTimeOracle(observation, 1_008, 5), undefined);
  assert.equal(error(checkChainTimeOracle(observation, 1_009, 5)), "chain-time oracle rejected");
  assert.deepEqual(safetyPrices(observation, { bid: "1", ask: "2" }), { bid: 100n, ask: 101n, mark: 100n });
  assert.deepEqual(safetyPrices(undefined, { bid: "1000", ask: "1010" }), {
    bid: 1000n,
    ask: 1010n,
    mark: 1005n,
  });
  assert.equal(checkOracleWidth(safetyPrices(undefined, { bid: "1000", ask: "1010" })), undefined);
  assert.equal(
    error(checkOracleWidth(safetyPrices(undefined, { bid: "1000", ask: "1011" }))),
    "oracle width rejected",
  );
});
