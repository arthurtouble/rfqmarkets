import assert from "node:assert/strict";
import test from "node:test";
import { BASE, constructQuote } from "../packages/shared/src/pricing.js";

const snapshot = {
  market: "ETH" as const,
  bid: 3_999n * 1_000_000n,
  ask: 4_001n * 1_000_000n,
  observedAtMs: 1_000,
};
const parameters = { maxNotional: 1_000_000n * 1_000_000n, baseSpreadBps: 2n, feeBps: 2n, toleranceBps: 8n };

test("an exact close quote preserves the full base position", () => {
  const exactBaseDelta = -12_345_678_901_234_567n;
  const quote = constructQuote(
    { market: "ETH", side: "sell", amount: "1" },
    snapshot,
    { BTC: 0n, ETH: 0n },
    [],
    1_000,
    "00000000-0000-4000-8000-000000000001",
    parameters,
    exactBaseDelta,
  );
  assert.equal(quote.baseDelta, exactBaseDelta);
  assert.equal(quote.notional, (-exactBaseDelta * (snapshot.bid + snapshot.ask)) / 2n / BASE);
  assert(quote.expectedPrice < snapshot.bid);
});

test("an exact quote rejects a base delta opposite to its side", () => {
  assert.throws(
    () =>
      constructQuote(
        { market: "ETH", side: "buy", amount: "1" },
        snapshot,
        { BTC: 0n, ETH: 0n },
        [],
        1_000,
        "00000000-0000-4000-8000-000000000002",
        parameters,
        -1n,
      ),
    /invalid exact base direction/,
  );
});
