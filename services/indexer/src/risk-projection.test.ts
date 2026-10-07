import assert from "node:assert/strict";
import test from "node:test";
import { LAUNCH_MARKETS, marketRegistry } from "../../../packages/shared/src/markets.js";
import { RiskProjection } from "./risk-projection.js";

const sizes = (...values: Array<[number, string]>) => new Map(values);

test("risk projection replaces accounts without double counting", () => {
  const view = new RiskProjection();
  view.update({ account: "a", collateral: "100", sizes: sizes([0, "10"], [1, "-3"]) });
  view.update({ account: "b", collateral: "50", sizes: sizes([0, "-4"], [1, "0"]) });
  assert.deepEqual(view.snapshot(7), {
    indexedBlock: 7,
    accountCount: 2,
    totalCollateral: "150",
    markets: {
      BTC: { longBase: "10", shortBase: "4", netBase: "6", longAccounts: 1, shortAccounts: 1 },
      ETH: { longBase: "0", shortBase: "3", netBase: "-3", longAccounts: 0, shortAccounts: 1 },
    },
  });
  view.update({ account: "a", collateral: "80", sizes: sizes([1, "5"]) });
  assert.deepEqual(view.snapshot(8), {
    indexedBlock: 8,
    accountCount: 2,
    totalCollateral: "130",
    markets: {
      BTC: { longBase: "0", shortBase: "4", netBase: "-4", longAccounts: 0, shortAccounts: 1 },
      ETH: { longBase: "5", shortBase: "0", netBase: "5", longAccounts: 1, shortAccounts: 0 },
    },
  });
  view.clear();
  assert.equal(view.snapshot(9).accountCount, 0);
});

test("risk projection covers every registered market and labels ones the registry lacks", () => {
  marketRegistry.replace([
    ...LAUNCH_MARKETS,
    { index: 2, symbol: "SOL", impactK: 20_000n, shockBps: 6_000n, marginScaleBps: 10_000, enabled: true },
  ]);
  try {
    const view = new RiskProjection();
    view.update({ account: "a", collateral: "1", sizes: sizes([2, "7"], [3, "-1"]) });
    const markets = view.snapshot(1).markets;
    assert.deepEqual(Object.keys(markets), ["BTC", "ETH", "SOL", "market #3"]);
    assert.equal(markets.SOL.longBase, "7");
    assert.equal(markets["market #3"].shortBase, "1");
  } finally {
    marketRegistry.reset();
  }
});
