import assert from "node:assert/strict";
import test from "node:test";
import { GET_A_WALLET, isUserRejection, walletErrorMessage, walletLabel, walletSections } from "./wallets.js";

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

test("no connectors and no provider leave every section empty", () => {
  assert.deepEqual(walletSections([], false), { installed: [], passkey: [], remote: [] });
  assert.ok(GET_A_WALLET.every(wallet => wallet.url.startsWith("https://")));
});

// Shapes as viem/wagmi throw them: a wrapper whose `cause` is the provider's EIP-1193 error.
const wrapped = (inner: object, outer: object = {}) => Object.assign(new Error("Request failed"), { shortMessage: "Request failed", ...outer, cause: inner });

test("user rejections are recognised however they are wrapped", () => {
  assert.equal(isUserRejection({ code: 4001, message: "User rejected the request." }), true);
  assert.equal(isUserRejection(wrapped({ code: 4001 })), true);
  assert.equal(isUserRejection(wrapped(wrapped({ code: 4001 }))), true);
  assert.equal(isUserRejection({ name: "UserRejectedRequestError" }), true);
  assert.equal(isUserRejection(new Error("User denied account authorization")), true);
  assert.equal(isUserRejection(new Error("Connection request reset. Please try again.")), true);
  assert.equal(isUserRejection(new Error("execution reverted")), false);
  assert.equal(isUserRejection(null), false);
  assert.equal(isUserRejection("boom"), false);
});

test("wallet errors read as short sentences", () => {
  assert.equal(walletErrorMessage(wrapped({ code: 4001 }), "Base"), "You cancelled the request in your wallet.");
  assert.equal(walletErrorMessage(wrapped({ code: 4902, message: "Unrecognized chain ID" }), "Base"), "Your wallet doesn't have Base yet. Add it in the wallet, then try again.");
  assert.equal(walletErrorMessage({ code: -32002, message: "Request of type 'wallet_requestPermissions' already pending" }, "Base"), "Your wallet already has a request open. Finish or close it there, then try again.");
  assert.equal(walletErrorMessage(Object.assign(new Error("Provider not found."), { name: "ProviderNotFoundError" }), "Base"), "That wallet isn't available in this browser.");
  assert.equal(walletErrorMessage(Object.assign(new Error("long\nstack"), { shortMessage: "Something broke.\nDetails: x" }), "Base"), "Something broke.");
  assert.equal(walletErrorMessage({}, "Base"), "Your wallet didn't respond. Try again.");
  // A self-referencing cause must not loop forever.
  const loop: { message: string; cause?: unknown } = { message: "loop" };
  loop.cause = loop;
  assert.equal(walletErrorMessage(loop, "Base"), "loop");
});
