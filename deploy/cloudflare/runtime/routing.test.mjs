import assert from "node:assert/strict";
import test from "node:test";
import { hedgerOpsPath, portForPath } from "./routing.mjs";

test("routes only the intended public runtime surface", () => {
  assert.equal(portForPath("/health"), 4300);
  assert.equal(portForPath("/v1/risk"), 4300);
  assert.equal(portForPath("/v1/updates/stream"), 4300);
  assert.equal(portForPath("/v1/markets/stream"), 4500);
  assert.equal(portForPath("/v1/markets/history"), 4500);
  assert.equal(portForPath("/v1/candles"), 4500);
  assert.equal(portForPath("/v1/markets/stats"), 4500);
  assert.equal(portForPath(`/v1/portfolio/0x${"12".repeat(20)}/history`), 4300);
  assert.equal(portForPath(`/v1/funding/0x${"12".repeat(20)}`), 4300);
  assert.equal(portForPath("/v1/quote"), 4100);
  assert.equal(portForPath("/internal/risk"), null);
  assert.equal(portForPath("/approve"), null);
});

test("maps only the hedger's status reads for the operations dashboard", () => {
  assert.equal(hedgerOpsPath("/ops/hedger/v1/status", "GET"), "/v1/status");
  assert.equal(hedgerOpsPath("/ops/hedger/v1/status/stream", "GET"), "/v1/status/stream");
  assert.equal(hedgerOpsPath("/ops/hedger/v1/status", "POST"), null);
  assert.equal(hedgerOpsPath("/ops/hedger/v1/tick", "GET"), null);
  assert.equal(hedgerOpsPath("/ops/hedger/internal/risk", "GET"), null);
  assert.equal(portForPath("/ops/hedger/v1/status"), null);
});
