import assert from "node:assert/strict";
import { test } from "node:test";
import { openingPnl, positionPnl } from "../packages/shared/src/account-risk.js";

test("opening margin ignores each winner independently", () => {
  assert.equal(1_000n + openingPnl([200n, -100n]), 900n);
  assert.equal(openingPnl([-200n, -100n]), -300n);
  assert.equal(openingPnl([200n, 100n]), 0n);
});
test("PnL preserves separate-leg contract rounding for fractional base sizes", () => {
  assert.equal(positionPnl(600_000_000_000_000_000n, 2n, 3n), 0n);
  assert.equal(positionPnl(-600_000_000_000_000_000n, 2n, 3n), 0n);
  assert.equal(positionPnl(10n ** 18n, 100n, 125n), 25n);
  assert.equal(positionPnl(-(10n ** 18n), 100n, 125n), -25n);
});
