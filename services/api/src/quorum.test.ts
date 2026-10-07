import { test } from "node:test";
import assert from "node:assert/strict";
import { firstQuorum } from "./quorum.js";
test("distinct quorum completes without waiting for a stalled third signer", async () => {
  const result = await Promise.race([
    firstQuorum([Promise.resolve("a"), Promise.resolve("b"), new Promise<string>(() => {})], (x) => x),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("quorum stalled")), 100)),
  ]);
  assert.equal(result.length, 2);
});
test("duplicate identities cannot satisfy quorum and rejected jobs are contained", async () => {
  const result = await firstQuorum(
    [Promise.resolve("a"), Promise.resolve("a"), Promise.reject(new Error("offline"))],
    (x) => x,
  );
  assert.equal(result.length, 3);
  assert.equal(result.filter((x) => x.status === "rejected").length, 1);
});
