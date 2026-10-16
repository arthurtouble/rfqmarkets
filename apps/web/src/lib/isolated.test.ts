import assert from "node:assert/strict";
import { test } from "node:test";
import { homeTotals, idleIsolated, isolatedAccountOf, marginTopUp, MIN_ISOLATED_OPEN } from "./isolated.js";

test("isolated account addresses match the clearing contract's derivation", () => {
  // Same vector as test/contracts/IsolatedMargin.t.sol and packages/shared/src/isolated.test.ts.
  const owner = "0x328809Bc894f92807417D2dAD6b7C998c1aFdac6";
  assert.equal(isolatedAccountOf(owner, 0), "0xf26A159F2BCCC9c9497161A12fBBa347114dE454");
  assert.equal(isolatedAccountOf(owner.toLowerCase(), 0), "0xf26A159F2BCCC9c9497161A12fBBa347114dE454");
  assert.notEqual(isolatedAccountOf(owner, 1), isolatedAccountOf(owner, 0));
});

test("the margin move leaves exactly the amount in the isolated account", () => {
  assert.equal(marginTopUp(25_000_000n, 0n, false), 25_000_000n);
  assert.equal(marginTopUp(25_000_000n, 5_000_000n, true), 20_000_000n);
  assert.equal(marginTopUp(25_000_000n, 30_000_000n, true), -5_000_000n);
  assert.equal(marginTopUp(25_000_000n, 25_000_000n, true), 0n);
  // A new isolated account opens with at least the contract's floor; smaller trades use the main balance.
  assert.equal(marginTopUp(MIN_ISOLATED_OPEN - 1n, 0n, false), null);
  assert.equal(marginTopUp(5_000_000n, 0n, true), 5_000_000n);
});

test("homeTotals sums the equity and unrealized PnL of every isolated account", () => {
  assert.deepEqual(homeTotals([]), { equity: 0n, unrealizedPnl: 0n });
  assert.deepEqual(
    homeTotals([
      { equity: "12000000", unrealizedPnl: "2000000" },
      { equity: "7000000", unrealizedPnl: "-3000000" },
    ]),
    { equity: 19_000_000n, unrealizedPnl: -1_000_000n },
  );
});

test("idle isolated accounts are the ones holding money with no open position", () => {
  const owner = "0x328809Bc894f92807417D2dAD6b7C998c1aFdac6";
  const btc = isolatedAccountOf(owner, 0),
    eth = isolatedAccountOf(owner, 1),
    sol = isolatedAccountOf(owner, 2);
  const markets = new Map([
    [btc.toLowerCase(), "BTC"],
    [eth.toLowerCase(), "ETH"],
    [sol.toLowerCase(), "SOL"],
  ]);
  const idle = idleIsolated(
    [
      // A trade that failed after its amount was set aside.
      { account: btc.toLowerCase(), collateral: "25000000", positions: { BTC: { size: "0" } } },
      // An open trade: its margin is in use.
      { account: eth, collateral: "10000000", positions: { ETH: { size: "-4000000000000000" } } },
      // Emptied after a cash out.
      { account: sol, collateral: "0", positions: {} },
      // Not one of the trader's markets.
      { account: owner, collateral: "5000000", positions: {} },
    ],
    (account) => markets.get(account.toLowerCase()) ?? null,
  );
  assert.deepEqual(idle, [{ market: "BTC", account: btc.toLowerCase(), heldMicro: 25_000_000n }]);
});
