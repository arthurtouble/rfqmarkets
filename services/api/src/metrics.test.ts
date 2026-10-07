import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeMetrics } from "./metrics.js";

test("runtime metrics remain bounded and report useful percentiles", () => {
  const metrics = new RuntimeMetrics(4);
  for (let value = 1; value <= 10; value++) metrics.record("firmQuote", value, value === 10 ? 503 : 200);
  const value = metrics.snapshot().firmQuote;
  assert.deepEqual(value, { count: 10, failures: 1, meanMs: 5.5, p50Ms: 8, p95Ms: 10, p99Ms: 10, maxMs: 10 });
});

test("runtime metric labels are supplied by code and snapshots do not mutate samples", () => {
  const metrics = new RuntimeMetrics(2);
  metrics.record("approval", 4.44);
  const first = metrics.snapshot();
  first.approval.maxMs = 999;
  assert.equal(metrics.snapshot().approval.maxMs, 4.4);
});
