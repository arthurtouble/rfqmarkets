import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryCandleStore, candleToWire, resampleCandles } from "./candles.js";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % (60 * MINUTE)); // an hour boundary

test("one-minute OHLC aggregation per market", () => {
  const store = new MemoryCandleStore();
  store.record(0, T0 + 1_000, 100n);
  store.record(0, T0 + 2_000, 105n);
  store.record(0, T0 + 3_000, 98n);
  store.record(0, T0 + 59_999, 101n);
  store.record(0, T0 + MINUTE, 102n);
  store.record(1, T0 + 1_000, 7n);
  assert.deepEqual(store.range(0, T0, T0 + 10 * MINUTE), [
    { start: T0, open: 100n, high: 105n, low: 98n, close: 101n, samples: 4 },
    { start: T0 + MINUTE, open: 102n, high: 102n, low: 102n, close: 102n, samples: 1 },
  ]);
  assert.equal(store.range(1, T0, T0).length, 1);
  assert.deepEqual(store.range(2, T0, T0 + MINUTE), []);
  assert.deepEqual(
    store.range(0, T0 + 1, T0 + MINUTE),
    [store.range(0, T0 + MINUTE, T0 + MINUTE)[0]],
    "from rounds up",
  );
  assert.deepEqual(candleToWire(store.range(0, T0, T0)[0]), {
    time: T0 / 1_000,
    open: "100",
    high: "105",
    low: "98",
    close: "101",
    samples: 4,
  });
});

test("the ring buffer keeps only the retention window", () => {
  const store = new MemoryCandleStore(10 * MINUTE);
  for (let minute = 0; minute < 25; minute++) store.record(0, T0 + minute * MINUTE, BigInt(minute));
  const candles = store.range(0, T0, T0 + 30 * MINUTE);
  assert.equal(candles.length, 10);
  assert.equal(candles[0].start, T0 + 15 * MINUTE);
  assert.equal(candles.at(-1)!.close, 24n);
  // A late sample for an evicted minute does not overwrite the newer candle in its slot.
  store.record(0, T0 + 20 * MINUTE - 10 * MINUTE, 999n);
  assert.equal(store.range(0, T0 + 20 * MINUTE, T0 + 20 * MINUTE)[0].close, 20n);
  assert.deepEqual(store.range(0, T0, T0 + 5 * MINUTE), [], "evicted minutes are gone");
});

test("resampling merges minutes into aligned buckets", () => {
  const store = new MemoryCandleStore();
  for (let minute = 0; minute < 12; minute++) {
    store.record(0, T0 + minute * MINUTE, BigInt(100 + minute));
    store.record(0, T0 + minute * MINUTE + 30_000, BigInt(90 + minute));
  }
  const five = resampleCandles(store.range(0, T0, T0 + 12 * MINUTE), 5 * MINUTE);
  assert.equal(five.length, 3);
  assert.deepEqual(five[0], { start: T0, open: 100n, high: 104n, low: 90n, close: 94n, samples: 10 });
  assert.deepEqual(five[2], {
    start: T0 + 10 * MINUTE,
    open: 110n,
    high: 111n,
    low: 100n,
    close: 101n,
    samples: 4,
  });
});
