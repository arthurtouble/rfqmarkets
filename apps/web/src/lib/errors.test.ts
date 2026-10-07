import assert from "node:assert/strict";
import { test } from "node:test";
import { friendlyError } from "./errors.js";

test("API and wallet reasons become plain language", () => {
  assert.match(friendlyError("User rejected the request."), /cancelled the request in your wallet/);
  assert.match(friendlyError("quote expired"), /price expired/);
  assert.match(friendlyError("The quote expired. Review the new price"), /price expired/);
  assert.match(friendlyError("market disabled"), /paused/);
  assert.match(friendlyError("market is paused"), /paused/);
  assert.match(friendlyError("reduce-only intent does not reduce position"), /opposite position/);
  assert.match(friendlyError("hedging unavailable: only exposure-reducing trades are allowed"), /direction is closed/);
  assert.match(friendlyError("approver quorum unavailable"), /couldn't be confirmed/);
  assert.match(friendlyError("firm quote capacity reached"), /busy/);
  assert.match(friendlyError("price moved beyond signed protection"), /slippage/);
  assert.match(friendlyError("Failed to fetch"), /Can't reach/);
});

test("unknown reasons pass through", () => {
  assert.equal(friendlyError("position is already closed"), "position is already closed");
  // Shared by trades and withdrawals, so it stays as the API words it.
  assert.equal(friendlyError("Insufficient margin"), "Insufficient margin");
});
