import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionBudget } from "../packages/shared/src/connection-budget.js";
test("connections bound global and per-client leases and release exactly once without idle IDs", () => {
  const budget = new ConnectionBudget(3, 2),
    a = budget.acquire("a")!,
    b = budget.acquire("a")!;
  assert.equal(budget.acquire("a"), undefined);
  const c = budget.acquire("b")!;
  assert.equal(budget.acquire("c"), undefined);
  a();
  a();
  assert.equal(budget.status().active, 2);
  const d = budget.acquire("c")!;
  b();
  c();
  d();
  assert.equal(budget.status().clients, 0);
  assert.equal(budget.status().active, 0);
});
