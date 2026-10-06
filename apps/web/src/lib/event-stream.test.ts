import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffDelay } from "./event-stream.js";

test("stream reconnect backoff doubles and caps", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 20].map(attempt => backoffDelay(attempt)), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
});
