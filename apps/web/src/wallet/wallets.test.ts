import assert from "node:assert/strict";
import test from "node:test";
import { walletLabel, walletSections } from "./wallets.js";

const generic = { id: "injected", type: "injected", name: "Injected" };
const rabby = { id: "io.rabby", type: "injected", name: "Rabby Wallet" };
const base = { id: "baseAccount", type: "baseAccount", name: "Base Account" };
const wc = { id: "walletConnect", type: "walletConnect", name: "WalletConnect" };

test("announced extensions replace the generic browser wallet", () => {
  const sections = walletSections([generic, rabby, base, wc], true);
  assert.deepEqual(sections.installed, [rabby]);
  assert.deepEqual(sections.passkey, [base]);
  assert.deepEqual(sections.remote, [wc]);
});

test("generic browser wallet shows only when a provider exists", () => {
  assert.deepEqual(walletSections([generic, base], true).installed, [generic]);
  assert.deepEqual(walletSections([generic, base], false).installed, []);
});

test("labels", () => {
  assert.equal(walletLabel(generic), "Browser wallet");
  assert.equal(walletLabel(rabby), "Rabby Wallet");
  assert.equal(walletLabel(wc), "WalletConnect");
});
