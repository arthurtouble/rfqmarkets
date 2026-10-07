import assert from "node:assert/strict";
import test from "node:test";
import { isolatedAccountAddress, signerAccount } from "./isolated.js";

const owner = "0x328809Bc894f92807417D2dAD6b7C998c1aFdac6";

test("isolated account addresses match the clearing contract's derivation", () => {
  // Same vector as test/contracts/IsolatedMargin.t.sol.
  assert.equal(isolatedAccountAddress(owner, 0), "0xf26A159F2BCCC9c9497161A12fBBa347114dE454");
  assert.notEqual(isolatedAccountAddress(owner, 1), isolatedAccountAddress(owner, 0));
});

test("an isolated account is signed for by its owner", async () => {
  const isolated = isolatedAccountAddress(owner, 0);
  const clearing = {
    isolatedOwner: async (account: string) =>
      account === isolated
        ? { owner, market: 0n }
        : { owner: "0x0000000000000000000000000000000000000000", market: 0n },
  };
  assert.equal(await signerAccount(clearing, isolated), owner);
  assert.equal(await signerAccount(clearing, owner), owner);
});
