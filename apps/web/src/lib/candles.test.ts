import assert from "node:assert/strict";
import { test } from "node:test";
import { candleToNumbers, linePoints, mergeLiveCandle } from "./candles.js";
import type { Candle } from "./types.js";

const candle = (time: number, open: number, high: number, low: number, close: number): Candle =>
  ({ time, open: String(open), high: String(high), low: String(low), close: String(close), samples: 1 });

test("a live mid extends the current bucket", () => {
  const merged = mergeLiveCandle([candle(0, 100, 105, 95, 101)], "1m", 30_000, 110n);
  assert.deepEqual(merged, [{ time: 0, open: "100", high: "110", low: "95", close: "110", samples: 2 }]);
  assert.equal(mergeLiveCandle(merged, "1m", 45_000, 90n)[0].low, "90");
});

test("a mid in a later bucket opens a candle at the previous close", () => {
  const merged = mergeLiveCandle([candle(0, 100, 105, 95, 101)], "1m", 125_000, 99n);
  assert.deepEqual(merged[1], { time: 120_000, open: "101", high: "101", low: "99", close: "99", samples: 1 });
  assert.equal(mergeLiveCandle([candle(0, 1, 1, 1, 1), candle(60_000, 1, 1, 1, 1)], "1m", 125_000, 2n, 2).length, 2);
});

test("stale or invalid ticks leave the series alone", () => {
  const series = [candle(300_000, 1, 1, 1, 1)];
  assert.deepEqual(mergeLiveCandle(series, "5m", 10_000, 5n), series);
  assert.deepEqual(mergeLiveCandle(series, "5m", 310_000, 0n), series);
  assert.deepEqual(mergeLiveCandle([], "1h", 3_700_000, 7n), [{ time: 3_600_000, open: "7", high: "7", low: "7", close: "7", samples: 1 }]);
  assert.deepEqual(candleToNumbers(candle(0, 1_500_000, 2_000_000, 1_000_000, 1_250_000)), { time: 0, open: 1.5, high: 2, low: 1, close: 1.25 });
});

test("line points start at the first open and step through closes at each bucket's end", () => {
  assert.deepEqual(linePoints([], 60_000, 0), []);
  assert.deepEqual(linePoints([candle(0, 100e6, 0, 0, 101e6), candle(60_000, 101e6, 0, 0, 99e6)], 60_000, 90_000), [
    { time: 0, value: 100 }, { time: 60_000, value: 101 }, { time: 90_000, value: 99 },
  ]);
  // A single bucket (a market listed minutes ago) still draws a line.
  assert.equal(linePoints([candle(0, 5e6, 0, 0, 6e6)], 300_000, 10_000).length, 2);
});
