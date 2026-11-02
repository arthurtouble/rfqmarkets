import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE,
  adaptiveSpread,
  constructQuote,
  impactCost,
  impactScaleMilli,
  launchPricing,
  quotedImpact,
  quotedPrice,
  tradingFeeBps,
  type Market,
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
  const calm = adaptiveSpread({ volatilityBps: 0.24 });
  assert.equal(calm.baseBps, 0n);
  assert.equal(calm.volatilityBps, 0n);
  assert.equal(calm.totalBps, 0n);
  // Spreads are in tenths of a bp; volatility counts to the nearest tenth after its 1/5 weight.
  assert.equal(adaptiveSpread({ volatilityBps: 0.25 }).totalBps, 1n);
  assert.equal(adaptiveSpread({ volatilityBps: 2.4 }).totalBps, 5n);
  assert.equal(adaptiveSpread({ volatilityBps: 2.6 }).totalBps, 5n);
  assert.equal(adaptiveSpread({ volatilityBps: 2.8 }).totalBps, 6n);
  // Other components round up to the next tenth, and the total caps at 100 bps.
  assert.equal(adaptiveSpread({ hedgeCostBps: 1.21 }).hedgeBps, 13n);
  assert.equal(adaptiveSpread({ confidenceBps: 0.6 }).uncertaintyBps, 3n);
  assert.equal(
    adaptiveSpread({ volatilityBps: 2_000, toxicityScoreBps: 10_000, hedgeCostBps: 50 }).totalBps,
    1_000n,
  );
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

test("a quote prices from the mid even inside a wide oracle band, as the contract measures it", () => {
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
    const mid = (wide.bid + wide.ask) / 2n,
      beyond = side === "buy" ? quote.expectedPrice - mid : mid - quote.expectedPrice;
    assert(beyond > 0n && beyond < 20_000n, side);
  }
  // A wider model spread prices from the mid; the contract's floored comparison sees the full impact charge.
  const args = { bid: wide.bid, ask: wide.ask, notional: 100_000n * 1_000_000n };
  assert.equal(
    quotedPrice({ ...args, buy: true, spreadCharge: 50_000_000n, impactCharge: 0n }),
    100_050n * 1_000_000n,
  );
  const impactCharge = 5_000_000n,
    price = quotedPrice({ ...args, buy: false, spreadCharge: 0n, impactCharge }),
    quantity = (args.notional * BASE) / 100_000_000_000n,
    delivered = (quantity * 100_000_000_000n) / BASE - (quantity * price) / BASE;
  assert(delivered >= impactCharge);
});

test("the size curve steepens with volatility and an inventory-reducing trade gets half the improvement", () => {
  assert.equal(impactScaleMilli(undefined), 1_000n);
  assert.equal(impactScaleMilli(5), 1_100n);
  assert.equal(impactScaleMilli(100), 3_000n);
  assert.equal(impactScaleMilli(1_000), 4_000n);
  const notional = 20_000n * 1_000_000n;
  assert.equal(quotedImpact(5_000_000n, 0, notional), 5_000_000n);
  assert.equal(quotedImpact(5_000_000n, 50, notional), 10_000_000n);
  assert.equal(quotedImpact(3n, 5, notional), 4n); // rounded up
  assert.equal(quotedImpact(-5_000_001n, 200, notional), -2_500_000n); // halved towards zero, never scaled
  assert.equal(quotedImpact(-50_000_000n, 0, notional), -10_000_000n); // at most 5 bps of notional
  const base = {
    market: "BTC" as const,
    bid: 100_000n * 1_000_000n,
    ask: 100_000n * 1_000_000n,
    observedAtMs: 1_000,
  };
  const quote = (side: "buy" | "sell", volatilityBps: number) =>
    constructQuote(
      { market: "BTC", side, amount: "20000" },
      { ...base, volatilityBps },
      { BTC: 40_000n * 1_000_000n },
      [],
      1_000,
      crypto.randomUUID(),
      { ...launchPricing, spread: adaptiveSpread() },
    );
  const calmBuy = quote("buy", 0),
    stormyBuy = quote("buy", 100),
    sell = quote("sell", 100);
  // Adding $20k to a $40k long requires $10 (5 bps), tripled at 100 bps of risk.
  assert.equal(calmBuy.impactCharge, 10_000_000n);
  assert.equal(stormyBuy.impactCharge, 30_000_000n);
  // Selling $20k against it improves the maker's inventory by $6 and passes $3 back: $15 above the mid per BTC.
  assert.equal(sell.impactCharge, -3_000_000n);
  assert.equal(sell.expectedPrice, 100_015n * 1_000_000n);
});

test("every quote meets the contract's impact checks, rebates included", () => {
  let seed = 7,
    rebates = 0;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 20_000; i++) {
    const market: Market = i % 2 ? "BTC" : "ETH",
      price = BigInt(Math.floor((market === "BTC" ? 1e11 : 4e9) * (0.5 + random()))),
      half = BigInt(Math.floor(random() * 5e6)),
      side = random() < 0.5 ? ("buy" as const) : ("sell" as const),
      skew = BigInt(Math.floor((random() - 0.5) * 2e12)),
      amount = (random() < 0.5 ? random() * 50 + 1 : random() * 25_000 + 1).toFixed(6),
      exact =
        random() < 0.3 ? BigInt(Math.floor(random() * 1e17) + 1) * (side === "buy" ? 1n : -1n) : undefined,
      snapshot = {
        market,
        bid: price - half,
        ask: price + half,
        observedAtMs: 0,
        volatilityBps: random() < 0.3 ? 0 : random() * 300,
      };
    const q = constructQuote(
      { market, side, amount },
      snapshot,
      { [market]: skew },
      [],
      0,
      crypto.randomUUID(),
      {
        ...launchPricing,
        maxNotional: 1n << 60n,
        spread: adaptiveSpread({ volatilityBps: random() < 0.5 ? 0 : random() * 50 }),
      },
      exact,
    );
    // RFQRiskMath.tradeAssessment with the quote's expected price as the execution price.
    const mark = (snapshot.bid + snapshot.ask) / 2n,
      quantity = q.baseDelta < 0n ? -q.baseDelta : q.baseDelta,
      required = impactCost({ [market]: skew }, market, (q.baseDelta * mark) / BASE),
      delivered =
        q.baseDelta > 0n
          ? (quantity * q.expectedPrice) / BASE - (quantity * mark) / BASE
          : (quantity * mark) / BASE - (quantity * q.expectedPrice) / BASE;
    if (q.impactCharge < 0n) rebates++;
    assert(q.impactCharge >= required, `vector ${i}: charge below the contract's requirement`);
    assert(delivered >= q.impactCharge, `vector ${i}: price does not deliver the charge`);
  }
  assert(rebates > 5_000, "the vectors include inventory-reducing trades");
});
