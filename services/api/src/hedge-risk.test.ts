import assert from "node:assert/strict";
import { test } from "node:test";
import { hedgeAdmission, type HedgeRiskSnapshot } from "../../../packages/shared/src/hedge-risk.js";
import { HttpHedgeRiskSource } from "./hedge-risk.js";

const snapshot: HedgeRiskSnapshot = {
  observedAtMs: 1,
  healthy: true,
  indexedBlock: 10,
  markets: {
    BTC: { mode: "normal", gapNotional: "0", bandUsdc: "25000000000" },
    ETH: { mode: "normal", gapNotional: "0", bandUsdc: "25000000000" },
  },
};

test("hedge admission guards size and only permits strict exposure reduction during outage", () => {
  assert.equal(hedgeAdmission("normal", 0n, 100n, 1_000n).maxTradeNotional, 1_000n);
  assert.equal(hedgeAdmission("guarded", 0n, 100n, 1_000n).maxTradeNotional, 500n);
  assert.equal(hedgeAdmission("reduce_only", 1_000n, -400n, 1_000n).allowed, true);
  assert.equal(
    hedgeAdmission("reduce_only", 1_000n, -2_000n, 1_000n).allowed,
    false,
    "a trade that merely flips equal exposure is not reducing",
  );
  assert.equal(hedgeAdmission("reduce_only", 0n, 1n, 1_000n).allowed, false);
});

test("HTTP hedge risk reads are authenticated, cached and coalesced", async () => {
  let calls = 0;
  const source = new HttpHedgeRiskSource(
    "http://hedger/internal/risk",
    "secret",
    async (_input, init) => {
      calls++;
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer secret");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify(snapshot), { status: 200 });
    },
    1_000,
  );
  const [first, second] = await Promise.all([source.latest(), source.latest()]);
  assert.equal(first.indexedBlock, 10);
  assert.equal(second.indexedBlock, 10);
  assert.equal(calls, 1);
  await source.latest();
  assert.equal(calls, 1);
});
