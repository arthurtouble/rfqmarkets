import assert from "node:assert/strict";
import { test } from "node:test";
import { QuoteAdmission } from "./admission.js";

test("quote admission bounds client cardinality and refills deterministically", () => {
  const admission = new QuoteAdmission(1, 2, 2, 100, 100, 1_000);
  assert(admission.allow("a", 1_000));
  assert(admission.allow("a", 1_000));
  assert.equal(admission.allow("a", 1_000), false);
  assert(admission.allow("b", 1_000));
  assert(admission.allow("c", 1_000));
  assert.equal(admission.clientCount, 2);
  assert(admission.allow("a", 2_000), "evicted clients may re-enter after bounded churn");
  assert.equal(admission.clientCount, 2);
});

test("a throttled client does not consume global admission tokens", () => {
  const admission = new QuoteAdmission(0, 1, 10, 0, 2, 1_000);
  assert(admission.allow("noisy", 1_000));
  for (let i = 0; i < 50; i++) assert.equal(admission.allow("noisy", 1_000), false);
  assert(
    admission.allow("quiet", 1_000),
    "refused requests from one client must not drain the global bucket",
  );
  assert.equal(admission.allow("other", 1_000), false, "global capacity still binds");
});

test("a request refused for global load keeps the client's token", () => {
  const admission = new QuoteAdmission(0, 1, 10, 1, 1, 1_000);
  assert(admission.allow("a", 1_000));
  assert.equal(admission.allow("b", 1_000), false, "global bucket is empty");
  assert(admission.allow("b", 2_000), "b's only token was refunded when the global bucket refused it");
  assert.equal(admission.allow("b", 3_000), false, "b's own bucket still binds");
});
