import assert from "node:assert/strict";
import { test } from "node:test";
import { USDC, ceilDiv } from "../../../packages/shared/src/numeric.js";
import { checkPricePolicy, checkQuoteModel, checkQuoteSpread } from "./pricing-policy.js";
import { buildFixture } from "./test-fixtures.js";

const error = (rejection: { body: { error: string } } | undefined) => rejection?.body.error;

test("checkQuoteModel requires the configured spread model", () => {
  const { payload } = buildFixture(),
    spread = payload.quote.spread;
  assert.equal(checkQuoteModel(spread, undefined), undefined);
  assert.equal(checkQuoteModel(undefined, undefined), undefined);
  assert.equal(checkQuoteModel(spread, "adaptive-v3"), undefined);
  assert.equal(error(checkQuoteModel(undefined, "adaptive-v3")), "quote model mismatch");
  // Approvers still on the whole-bps model refuse quotes in tenths of a bp, and the reverse.
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
    { ...spread, baseBps: "1", totalBps: "2" },
    { ...spread, volatilityBps: "2000", totalBps: "2000" },
    { ...spread, totalBps: "3" },
    { ...spread, volatilityBps: "2000", totalBps: "999" },
  ])
    assert.equal(
      error(checkQuoteSpread({ ...quote, spread: changed }, payload.intent.baseDelta)),
      "quote spread rejected",
    );
  // A calm market quotes no spread at all: the market's base spread is in the fee instead.
  assert.equal(spread.totalBps, "0");
  // A capped total (100 bps, in tenths) is accepted when the components exceed the cap.
  const capped = { ...spread, volatilityBps: "2000", totalBps: "1000" };
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
  // An inventory-reducing trade's rebate prices it better than the mid, and the approver recomputes it.
  for (const side of ["buy", "sell"] as const) {
    const reducing = buildFixture({ side, settled: { BTC: (side === "buy" ? -50_000n : 50_000n) * USDC } });
    assert(reducing.approval.impactCharge < 0n, side);
    assert.equal(
      checkQuoteSpread(reducing.payload.quote, reducing.payload.intent.baseDelta),
      undefined,
      side,
    );
  }
});

test("checkPricePolicy enforces freshness, rounding, notional cap and a minimum charge", () => {
  const fixture = buildFixture(),
    base = {
      quote: fixture.payload.quote,
      intent: fixture.intent,
      approval: fixture.approval,
      nowMs: fixture.nowMs,
      maxFutureSeconds: 5,
      capNotional: true,
      baseSpreadBps: 2,
    };
  // The base spread and the platform's 2 bps are the fee (4 bps, 40 cents on $1,000); a calm quote carries
  // only the inventory charge over the mid.
  assert.equal(base.approval.fee, 400_000n);
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
    { ...base, approval: { ...base.approval, fee: -1n } },
    // A market with a wider base spread needs a larger fee than this quote carries.
    { ...base, baseSpreadBps: 3 },
    // Without the fee the mid price is too cheap, on either side.
    { ...base, approval: { ...base.approval, fee: 0n } },
    { ...base, approval: { ...base.approval, executionPrice: BigInt(base.quote.ask) } },
    {
      ...base,
      quote: sell.payload.quote,
      intent: sell.intent,
      approval: { ...sell.approval, fee: 0n },
    },
  ];
  for (const input of rejected) assert.equal(error(checkPricePolicy(input)), "policy rejected");
  // The charge is base spread + markup (4 bps here, 40 cents on $1,000) plus impact over the mid. A
  // fee and price premium short of it are rejected: the fee pays its share and the premium the rest.
  const touch = BigInt(base.quote.ask),
    notional = BigInt(base.quote.amount),
    impact = base.approval.impactCharge;
  assert.equal(notional, 1_000n * USDC);
  const premium = (charge: bigint) => touch + ceilDiv(touch * (charge + impact), notional);
  const at = (price: bigint, fee = 0n) => ({
    ...base,
    approval: { ...base.approval, executionPrice: price, fee },
  });
  assert.equal(checkPricePolicy(at(premium(400_000n))), undefined);
  assert.equal(error(checkPricePolicy(at(premium(390_000n)))), "policy rejected");
  assert.equal(checkPricePolicy(at(premium(200_000n), 200_000n)), undefined);
  assert.equal(error(checkPricePolicy(at(premium(200_000n), 190_000n))), "policy rejected");
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

test("checkPricePolicy lets an inventory rebate price better than the mid, but no further", () => {
  for (const side of ["buy", "sell"] as const) {
    const fixture = buildFixture({ side, settled: { BTC: (side === "buy" ? -50_000n : 50_000n) * USDC } }),
      input = {
        quote: fixture.payload.quote,
        intent: fixture.intent,
        approval: fixture.approval,
        nowMs: fixture.nowMs,
        maxFutureSeconds: 5,
        capNotional: true,
        baseSpreadBps: 2,
      },
      mid = BigInt(fixture.payload.quote.bid),
      price = fixture.approval.executionPrice;
    assert(side === "buy" ? price < mid : price > mid, side);
    assert.equal(checkPricePolicy(input), undefined, side);
    // Claiming the rebate without the impact charge that justifies it is underpriced.
    assert.equal(
      error(checkPricePolicy({ ...input, approval: { ...input.approval, impactCharge: 0n } })),
      "policy rejected",
      side,
    );
  }
});
