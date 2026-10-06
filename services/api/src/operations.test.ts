import assert from "node:assert/strict";
import { test } from "node:test";
import { senderHealthy } from "./operations.js";
import { buildApi } from "./server.js";

const receipt = { hash: "0x", blockHash: "0x", blockNumber: 0, status: 1 as const };

test("in-flight and final sender rows keep the leader healthy", () => {
  assert.equal(senderHealthy(undefined), true);
  assert.equal(senderHealthy([]), true);
  for (const status of ["signed", "submitted", "included", "reverted", "superseded"])
    assert.equal(senderHealthy([{ status, count: 1 }]), true, status);
  for (const status of ["ambiguous", "reorged"])
    assert.equal(
      senderHealthy([
        { status: "included", count: 4 },
        { status, count: 1 },
      ]),
      false,
      status,
    );
});

test("/health treats an in-flight trade as healthy and an ambiguous one as unhealthy", async () => {
  let rows = [{ status: "submitted", count: 1 }];
  const app = buildApi({
    sender: { reconcile: async () => {}, status: () => rows, submit: async () => receipt },
  });
  try {
    await app.ready();
    assert.equal((await app.inject({ url: "/health" })).json().ok, true);
    rows = [{ status: "ambiguous", count: 1 }];
    assert.equal((await app.inject({ url: "/health" })).json().ok, false);
  } finally {
    await app.close();
  }
});
