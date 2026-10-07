import assert from "node:assert/strict";
import { test } from "node:test";
import { ShadowModelTelemetry } from "./shadow-model.js";
test("shadow telemetry aggregates without retaining customer quotes", () => {
  const metrics = new ShadowModelTelemetry();
  metrics.observe(4, 6);
  metrics.observe(8, 7);
  metrics.observe(Number.NaN, 10);
  assert.deepEqual(metrics.snapshot(), {
    modelVersion: "adaptive-shadow-v2",
    count: 2,
    meanLiveBps: 6,
    meanCandidateBps: 6.5,
    widerRate: 0.5,
    maxAbsoluteDeltaBps: 2,
  });
});
