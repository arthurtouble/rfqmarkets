import assert from "node:assert/strict";
import { test } from "node:test";
import { isolatedAccountOf, marginTopUp, MIN_ISOLATED_OPEN } from "./isolated.js";

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
