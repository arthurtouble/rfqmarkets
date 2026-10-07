import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { buildApprover } from "./server.js";
import { CHAIN_ID, CLEARING, buildFixture } from "./test-fixtures.js";

const directory = mkdtempSync(join(tmpdir(), "rfq-approver-server-"));
const key = Wallet.createRandom();
const app = buildApprover({
  privateKey: key.privateKey,
  transportToken: "secret",
  databasePath: join(directory, "approver.sqlite"),
  expectedChainId: CHAIN_ID,
  expectedVerifyingContract: CLEARING,
});
const auth = { authorization: "Bearer secret" };

before(() => app.ready());
after(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

test("routes require the transport token", async () => {
  for (const [method, url] of [
    ["POST", "/approve"],
    ["GET", "/internal/recovery"],
  ] as const) {
    const response = await app.inject({ method, url, headers: { authorization: "Bearer wrong" } });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "unauthorized" });
  }
});

test("health reports the signer and recovery state", async () => {
  const response = await app.inject({ url: "/health" });
  assert.deepEqual(response.json(), { ok: true, signer: key.address });
});

test("malformed bodies are rejected before any policy check", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/approve",
    headers: auth,
    payload: { quote: {} },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, "invalid request");
});

test("a valid envelope is signed, journaled and exported for recovery", async () => {
  const { payload } = buildFixture();
  const response = await app.inject({ method: "POST", url: "/approve", headers: auth, payload });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().signer, key.address);
  const rejected = await app.inject({
    method: "POST",
    url: "/approve",
    headers: auth,
    payload: { ...payload, domain: { ...payload.domain, version: "2" } },
  });
  assert.equal(rejected.statusCode, 409);
  assert.deepEqual(rejected.json(), { error: "domain mismatch" });
  const exported = (await app.inject({ url: "/internal/recovery", headers: auth })).json();
  assert.equal(exported.signer, key.address);
  assert.equal(exported.approvals.length, 1);
  assert.equal(JSON.parse(exported.approvals[0].payload).quote.quoteId, payload.quote.quoteId);
});

test("chain signing requires a pinned chain and clearing contract", () => {
  assert.throws(
    () =>
      buildApprover({
        privateKey: key.privateKey,
        transportToken: "t",
        databasePath: join(directory, "unpinned.sqlite"),
        rpcUrl: "http://127.0.0.1:1",
      }),
    /pinned chain and clearing address/,
  );
});
