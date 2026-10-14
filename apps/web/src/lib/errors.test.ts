import assert from "node:assert/strict";
import { test } from "node:test";
import { friendlyError } from "./errors.js";

test("API and wallet reasons become plain language", () => {
  assert.match(friendlyError("User rejected the request."), /cancelled in your wallet/);
  assert.match(friendlyError("quote expired"), /price expired/);
  assert.match(friendlyError("The quote expired. Review the new price"), /price expired/);
  assert.match(friendlyError("market disabled"), /paused/);
  assert.match(friendlyError("market is paused"), /paused/);
  assert.match(friendlyError("reduce-only intent does not reduce position"), /open position/);
  assert.match(
    friendlyError("hedging unavailable: only exposure-reducing trades are allowed"),
    /direction is paused/,
  );
  assert.match(friendlyError("approver quorum unavailable"), /couldn't be confirmed/);
  assert.match(friendlyError("firm quote capacity reached"), /busy/);
  assert.match(friendlyError("price moved beyond signed protection"), /The price moved/);
  assert.match(friendlyError("Failed to fetch"), /Can't connect/);
});

test("other short reasons read as a sentence", () => {
  assert.equal(friendlyError("position is already closed"), "Position is already closed.");
  assert.equal(friendlyError("Insufficient margin"), "Insufficient margin.");
  assert.equal(friendlyError("Enter an amount."), "Enter an amount.");
});

test("raw chain errors become a generic line", () => {
  assert.match(friendlyError("execution reverted: 0x8baa579f"), /Something went wrong/);
  assert.match(friendlyError("x".repeat(200)), /Something went wrong/);
  assert.match(friendlyError(""), /Something went wrong/);
});
