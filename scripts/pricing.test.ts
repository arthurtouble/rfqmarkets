import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE,
  adaptiveSpread,
  constructQuote,
  launchPricing,
  quotedPrice,
  tradingFeeBps,
} from "../packages/shared/src/pricing.js";

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
  assert(quote.expectedPrice < (snapshot.bid + snapshot.ask) / 2n, "a sale prices below the oracle mid");
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

test("a small calm trade fills at the mid and pays the market's base spread plus 2 bps as its fee", () => {
  const calm = adaptiveSpread({ volatilityBps: 0.28 });
  assert.equal(calm.baseBps, 0n);
  assert.equal(calm.volatilityBps, 0n);
  assert.equal(calm.totalBps, 0n);
  // Volatility counts to the nearest bps: 2.5 bps of risk (0.5 after the 1/5 weight) adds one.
  assert.equal(adaptiveSpread({ volatilityBps: 2.4 }).totalBps, 0n);
  assert.equal(adaptiveSpread({ volatilityBps: 2.5 }).totalBps, 1n);
  assert.equal(tradingFeeBps("BTC"), 4n);
  assert.equal(launchPricing.feeBps, 4n);
  const tight = {
    market: "BTC" as const,
    bid: 100_000n * 1_000_000n,
    ask: 100_000n * 1_000_000n,
    observedAtMs: 1_000,
  };
  const quote = constructQuote(
    { market: "BTC", side: "buy", amount: "20" },
    tight,
    { BTC: 0n },
    [],
    1_000,
    crypto.randomUUID(),
    { ...launchPricing, feeBps: tradingFeeBps("BTC"), spread: calm },
  );
  // Only the inventory charge of $20 (2 micro-USDC) moves it: under two cents on a $100,000 price.
  assert.equal(quote.impactCharge, 2n);
  assert(quote.expectedPrice > tight.ask && quote.expectedPrice - tight.ask < 20_000n);
  assert.equal(quote.fee, 8_000n); // 4 bps of $20
});

test("a quote never prices inside the oracle touch, which the contract requires", () => {
  const wide = {
    market: "BTC" as const,
    bid: 99_980n * 1_000_000n,
    ask: 100_020n * 1_000_000n,
    observedAtMs: 1_000,
  };
  for (const side of ["buy", "sell"] as const) {
    const quote = constructQuote(
      { market: "BTC", side, amount: "20" },
      wide,
      { BTC: 0n },
      [],
      1_000,
      crypto.randomUUID(),
      {
        ...launchPricing,
        spread: adaptiveSpread(),
      },
    );
    const beyond = side === "buy" ? quote.expectedPrice - wide.ask : wide.bid - quote.expectedPrice;
    assert(beyond > 0n && beyond < 20_000n, side);
  }
  // A wider model spread prices from the mid past the touch; impact on the touch branch is charged in full.
  const args = { bid: wide.bid, ask: wide.ask, notional: 100_000n * 1_000_000n };
  assert.equal(
    quotedPrice({ ...args, buy: true, spreadCharge: 50_000_000n, impactCharge: 0n }),
    100_050n * 1_000_000n,
  );
  const impactCharge = 5_000_000n,
    price = quotedPrice({ ...args, buy: false, spreadCharge: 0n, impactCharge }),
    quantity = (args.notional * BASE) / 100_000_000_000n,
    delivered = (quantity * wide.bid) / BASE - (quantity * price) / BASE;
  assert(delivered >= impactCharge);
});
