import assert from "node:assert/strict";
import test from "node:test";
import { TERMS_VERSION, hasAccepted, parseLocation, withAcceptance } from "./legal.js";

const alice = "0xAbC0000000000000000000000000000000000001";
const bob = "0x0000000000000000000000000000000000000002";

test("terms acceptance is per account, case-insensitive and survives other accounts", () => {
  assert.equal(hasAccepted(null, alice), false);
  const once = withAcceptance(null, alice, 1);
  assert.equal(hasAccepted(once, alice), true);
  assert.equal(hasAccepted(once, alice.toLowerCase()), true);
  assert.equal(hasAccepted(once, bob), false);
  const twice = withAcceptance(once, bob, 2);
  assert.equal(hasAccepted(twice, alice) && hasAccepted(twice, bob), true);
});

test("a new terms version or a corrupt value asks again", () => {
  const old = JSON.stringify({ version: "2000-01-01", accounts: { [alice.toLowerCase()]: 1 } });
  assert.equal(hasAccepted(old, alice), false);
  assert.equal(JSON.parse(withAcceptance(old, bob, 2)).version, TERMS_VERSION);
  assert.deepEqual(Object.keys(JSON.parse(withAcceptance(old, bob, 2)).accounts), [bob.toLowerCase()]);
  for (const raw of ["{", "[]", "1", JSON.stringify({ version: TERMS_VERSION, accounts: { [alice.toLowerCase()]: "yes" } })])
    assert.equal(hasAccepted(raw, alice), false, raw);
});

test("location answers outside the known statuses never block", () => {
  assert.deepEqual(parseLocation({ status: "sanctioned", message: "No" }), { status: "sanctioned", message: "No" });
  assert.deepEqual(parseLocation({ status: "restricted" }), { status: "restricted", message: null });
  for (const body of [null, "x", {}, { status: "blocked" }]) assert.equal(parseLocation(body).status, "unknown");
});
