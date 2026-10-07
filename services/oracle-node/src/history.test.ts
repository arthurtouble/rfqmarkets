import assert from "node:assert/strict";
import { test } from "node:test";
import type { PriceBatchWire } from "../../../packages/shared/src/signed-oracle.js";
import { BatchHistory } from "./history.js";

const batch = (observedAt: number): PriceBatchWire => ({
  observedAt,
  prices: [{ market: 0, bid: "1", ask: "2" }],
  signature: `0x${"11".repeat(65)}`,
  signer: "0x000000000000000000000000000000000000dEaD",
});
const times = (batches: PriceBatchWire[]) => batches.map((item) => item.observedAt);

test("batch history pages ascending after a high-water mark", () => {
  const history = new BatchHistory(900);
  for (let second = 100; second < 110; second++) history.push(batch(second));
  history.push(batch(105)); // out of order: ignored
  assert.equal(history.size, 10);
  assert.deepEqual(times(history.after(0, 3)), [100, 101, 102]);
  assert.deepEqual(times(history.after(104, 3)), [105, 106, 107]);
  assert.deepEqual(times(history.after(107, 10)), [108, 109]);
  assert.deepEqual(history.after(109, 10), []);
  assert.deepEqual(history.after(0, 0), []);
  assert.equal(history.oldest(), 100);
});

test("batch history is bounded by age and by count", () => {
  const byAge = new BatchHistory(60, 10_000);
  for (let second = 0; second < 5_000; second++) byAge.push(batch(1_000 + second));
  assert.equal(byAge.size, 60);
  assert.equal(byAge.oldest(), 5_940);
  assert.deepEqual(times(byAge.after(0, 2)), [5_940, 5_941]);
  const byCount = new BatchHistory(10_000, 5);
  for (let second = 0; second < 20; second++) byCount.push(batch(second * 2));
  assert.deepEqual(times(byCount.after(0, 100)), [30, 32, 34, 36, 38]);
  assert.deepEqual(times(byCount.after(31, 2)), [32, 34]);
});
