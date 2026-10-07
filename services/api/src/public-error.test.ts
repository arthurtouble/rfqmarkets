import { test } from "node:test";
import assert from "node:assert/strict";
import { publicError } from "./public-error.js";
test("public action errors cannot expose transport credentials or provider request bodies", () => {
  const message = "RPC https://provider/private-token Bearer signer-token signed-body";
  assert.equal(publicError(new Error(message), "action failed"), "action failed");
  assert.equal(publicError({ message, data: "0x50cb02e4" }, "action failed"), "Insufficient margin");
  assert.equal(publicError({ message, revert: { name: "Replay" } }, "action failed"), "Nonce already used");
  assert.equal(publicError({ revert: { name: message } }, "action failed"), "action failed");
  assert.equal(publicError({ message, data: "0xdccfcae2" }, "action failed"), "Trigger price not reached");
});
