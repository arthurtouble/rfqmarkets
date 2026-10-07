import assert from "node:assert/strict";
import { test } from "node:test";
import type { HedgeRiskSnapshot } from "../../../packages/shared/src/hedge-risk.js";
import { checkHedgeRisk, effectiveHedgeMode, fetchHedgeRisk } from "./hedge-policy.js";
import { word } from "./test-fixtures.js";

const error = (rejection: { body: { error: string } } | undefined) => rejection?.body.error;
const now = 1_000_000;
const snapshot = (mode: "normal" | "guarded" | "reduce_only", overrides: Partial<HedgeRiskSnapshot> = {}) =>
  ({
    observedAtMs: now,
    healthy: true,
    indexedBlock: 1,
    markets: {
      BTC: { mode, gapNotional: "0", bandUsdc: "0" },
      ETH: { mode: "normal", gapNotional: "0", bandUsdc: "0" },
    },
    ...overrides,
  }) as HedgeRiskSnapshot;
const spread = {
  baseBps: "2",
  volatilityBps: "0",
  toxicityBps: "0",
  hedgeBps: "3",
  basisBps: "2",
  uncertaintyBps: "0",
  totalBps: "7",
  modelVersion: "adaptive-v1",
};
const base = {
  risk: snapshot("normal"),
  market: "BTC" as const,
  nowMs: now,
  aggregateBase: 0n,
  positionSize: 0n,
  delta: 10n,
  limitWord: word(1_000n),
  executionNotional: 600n,
  spread,
};

test("fetchHedgeRisk sends the bearer token and fails on non-2xx", async () => {
  let authorization: string | undefined;
  const ok = (async (_url: string, init: RequestInit) => {
    authorization = (init.headers as Record<string, string>).authorization;
    return Response.json(snapshot("normal"));
  }) as unknown as typeof fetch;
  assert.equal((await fetchHedgeRisk({ url: "http://hedger", token: "t" }, ok)).healthy, true);
  assert.equal(authorization, "Bearer t");
  const failing = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(fetchHedgeRisk({ url: "http://hedger", token: "t" }, failing));
});

test("effectiveHedgeMode fails closed on unhealthy, stale or missing snapshots", () => {
  assert.equal(effectiveHedgeMode(snapshot("guarded"), "BTC", now), "guarded");
  assert.equal(effectiveHedgeMode(snapshot("normal", { healthy: false }), "BTC", now), "reduce_only");
  assert.equal(effectiveHedgeMode(snapshot("normal", { observedAtMs: 0 }), "BTC", now), "reduce_only");
  assert.equal(effectiveHedgeMode(snapshot("normal"), "BTC", now + 3_001), "reduce_only");
  assert.equal(effectiveHedgeMode(snapshot("normal"), "BTC", now + 3_001, 5_000), "normal");
  assert.equal(
    effectiveHedgeMode(snapshot("normal", { markets: {} as HedgeRiskSnapshot["markets"] }), "BTC", now),
    "reduce_only",
  );
});

test("checkHedgeRisk enforces reduce-only, guarded limits and venue execution spread", () => {
  assert.equal(checkHedgeRisk(base), undefined);
  assert.equal(
    error(checkHedgeRisk({ ...base, risk: snapshot("reduce_only") })),
    "hedge risk requires exposure reduction",
  );
  assert.equal(
    checkHedgeRisk({ ...base, risk: snapshot("reduce_only"), aggregateBase: -20n }),
    undefined,
    "reduce-only admits trades that shrink maker exposure",
  );
  assert.equal(error(checkHedgeRisk({ ...base, risk: snapshot("guarded") })), "guarded hedge limit exceeded");
  assert.equal(error(checkHedgeRisk({ ...base, executionNotional: 1_001n })), "guarded hedge limit exceeded");
  assert.equal(
    checkHedgeRisk({ ...base, executionNotional: 1_001n, positionSize: -20n }),
    undefined,
    "normal mode exempts the account's own position reductions",
  );
  const execution = { estimatedCostBps: 3.2, latencyMs: 1, basisBps: -2, depthUsdc: "0", observedAtMs: now };
  const withExecution = snapshot("normal");
  withExecution.markets.BTC.execution = execution;
  assert.equal(
    error(checkHedgeRisk({ ...base, risk: withExecution })),
    "venue execution spread rejected",
    "hedge bps must cover the rounded-up venue cost",
  );
  assert.equal(
    checkHedgeRisk({ ...base, risk: withExecution, spread: { ...spread, hedgeBps: "4" } }),
    undefined,
  );
  assert.equal(
    error(
      checkHedgeRisk({
        ...base,
        risk: withExecution,
        spread: { ...spread, hedgeBps: "4", basisBps: "1" },
      }),
    ),
    "venue execution spread rejected",
  );
  assert.equal(checkHedgeRisk({ ...base, risk: withExecution, spread: undefined }), undefined);
});
