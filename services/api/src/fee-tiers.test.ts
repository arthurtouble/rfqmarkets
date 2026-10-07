import assert from "node:assert/strict";
import { test } from "node:test";
import { feeTierWindow } from "../../../packages/shared/src/fee-tiers.js";
import { HttpFeeTierSource } from "./fee-tiers.js";

const account = "0x0000000000000000000000000000000000000002";

test("tiers are read once a day and only the tier number is trusted", async () => {
  let nowMs = 30 * 86_400_000 + 1_000,
    calls = 0,
    body: unknown = {};
  const source = new HttpFeeTierSource(
    "http://indexer/",
    (async (url: string) => {
      calls++;
      assert.equal(url, `http://indexer/v1/fees/${account}`);
      return Response.json(body);
    }) as typeof fetch,
    1_000,
    () => nowMs,
  );
  // A hostile discount is ignored: tier 2 maps to the local schedule's 22%.
  body = { tier: 2, discountBps: 10_000, windowEndMs: feeTierWindow(nowMs).endMs };
  assert.equal(await source.discountBps(account), 2_200);
  assert.equal(await source.discountBps(account.toUpperCase().replace("0X", "0x")), 2_200);
  assert.equal(calls, 1);
  // The next UTC day reads again; a response for an old window keeps the full fee.
  nowMs += 86_400_000;
  assert.equal(await source.discountBps(account), 0);
  assert.equal(calls, 2);
  body = { tier: 9, windowEndMs: feeTierWindow(nowMs).endMs };
  nowMs += 61_000;
  assert.equal(await source.discountBps(account), 0);
});

test("an unreachable indexer means the full fee, retried after a minute", async () => {
  let nowMs = 1_000_000,
    calls = 0;
  const source = new HttpFeeTierSource(
    "http://indexer",
    (async () => {
      calls++;
      throw new Error("offline");
    }) as typeof fetch,
    1_000,
    () => nowMs,
  );
  assert.equal(await source.discountBps(account), 0);
  assert.equal(await source.discountBps(account), 0);
  assert.equal(calls, 1);
  nowMs += 60_001;
  await source.discountBps(account);
  assert.equal(calls, 2);
});
