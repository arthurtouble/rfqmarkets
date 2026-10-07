import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPricePolicy, checkQuoteModel, checkQuoteSpread } from "./pricing-policy.js";
import { buildFixture } from "./test-fixtures.js";

const error = (rejection: { body: { error: string } } | undefined) => rejection?.body.error;

test("checkQuoteModel requires the configured spread model", () => {
  const { payload } = buildFixture(),
    spread = payload.quote.spread;
  assert.equal(checkQuoteModel(spread, undefined), undefined);
  assert.equal(checkQuoteModel(undefined, undefined), undefined);
  assert.equal(checkQuoteModel(spread, "adaptive-v1"), undefined);
  assert.equal(error(checkQuoteModel(undefined, "adaptive-v1")), "quote model mismatch");
  assert.equal(error(checkQuoteModel(spread, "adaptive-v2")), "quote model mismatch");
});

test("checkQuoteSpread recomputes the spread breakdown and expected price", () => {
  for (const side of ["buy", "sell"] as const) {
    const { payload } = buildFixture({ side });
    assert.equal(checkQuoteSpread(payload.quote, payload.intent.baseDelta), undefined, side);
  }
  const { payload } = buildFixture(),
    quote = payload.quote,
    spread = quote.spread!;
  assert.equal(checkQuoteSpread({ ...quote, spread: undefined }, payload.intent.baseDelta), undefined);
  for (const changed of [
    { ...spread, baseBps: "1", totalBps: "1" },
    { ...spread, volatilityBps: "200", totalBps: "202" },
    { ...spread, totalBps: "3" },
    { ...spread, volatilityBps: "200", totalBps: "99" },
  ])
    assert.equal(
      error(checkQuoteSpread({ ...quote, spread: changed }, payload.intent.baseDelta)),
      "quote spread rejected",
    );
  // A capped total is accepted when the components exceed the cap.
  const capped = { ...spread, volatilityBps: "200", totalBps: "100" };
  assert.equal(
    error(checkQuoteSpread({ ...quote, spread: capped }, payload.intent.baseDelta)),
    "quote spread price mismatch",
  );
  assert.equal(
    error(
      checkQuoteSpread(
        { ...quote, expectedPrice: (BigInt(quote.expectedPrice) - 1n).toString() },
        payload.intent.baseDelta,
      ),
    ),
    "quote spread price mismatch",
  );
});

test("checkPricePolicy enforces freshness, rounding, notional cap, fee floor and minimum premium", () => {
  const fixture = buildFixture(),
    base = {
      quote: fixture.payload.quote,
      intent: fixture.intent,
      approval: fixture.approval,
      nowMs: fixture.nowMs,
      maxFutureSeconds: 5,
      capNotional: true,
    };
  assert.equal(checkPricePolicy(base), undefined);
  const sell = buildFixture({ side: "sell" });
  assert.equal(
    checkPricePolicy({ ...base, quote: sell.payload.quote, intent: sell.intent, approval: sell.approval }),
    undefined,
  );
  const rejected = [
    { ...base, nowMs: fixture.nowMs + 8_001 },
    { ...base, nowMs: fixture.nowMs - 5_001 },
    { ...base, intent: { ...base.intent, baseDelta: base.intent.baseDelta * 2n } },
    { ...base, approval: { ...base.approval, fee: 0n } },
    { ...base, approval: { ...base.approval, executionPrice: BigInt(base.quote.ask) } },
    {
      ...base,
      quote: sell.payload.quote,
      intent: sell.intent,
      approval: { ...sell.approval, executionPrice: BigInt(sell.payload.quote.bid) },
    },
  ];
  for (const input of rejected) assert.equal(error(checkPricePolicy(input)), "policy rejected");
  const large = buildFixture({ amount: "1000001" });
  const largeInput = {
    ...base,
    quote: large.payload.quote,
    intent: large.intent,
    approval: large.approval,
  };
  assert.equal(error(checkPricePolicy(largeInput)), "policy rejected");
  assert.equal(checkPricePolicy({ ...largeInput, capNotional: false }), undefined);
});
