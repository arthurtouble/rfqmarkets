import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { buildApprover } from "../../../services/approver/src/server.js";
import { buildApi } from "../../../services/api/src/server.js";
import { RfqApiError, RfqClient, isolatedAccountAddress, randomNonce } from "./client.js";

const directory = mkdtempSync(join(tmpdir(), "rfq-sdk-"));
const approvers: Array<ReturnType<typeof buildApprover>> = [];
let api: ReturnType<typeof buildApi>;
let client: RfqClient;
const wallet = Wallet.createRandom();

/** Routes fetch calls to in-process Fastify apps: approver-N hosts to approvers, anything else to the API. */
function inject(target: { inject: ReturnType<typeof buildApi>["inject"] }) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const response = await target.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: url.pathname + url.search,
      headers: init?.headers as Record<string, string>,
      payload: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers as HeadersInit,
    });
  }) as typeof fetch;
}

before(async () => {
  const urls = [];
  for (let index = 0; index < 3; index++) {
    const app = buildApprover({
      privateKey: Wallet.createRandom().privateKey,
      transportToken: `token-${index}`,
      databasePath: join(directory, `${index}.sqlite`),
      expectedChainId: 31_337n,
      expectedVerifyingContract: "0x0000000000000000000000000000000000000001",
    });
    await app.ready();
    approvers.push(app);
    urls.push({ url: `http://approver-${index}`, token: `token-${index}` });
  }
  api = buildApi({
    approvers: urls,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      return inject(approvers[Number(url.hostname.split("-")[1])])(input, init);
    }) as typeof fetch,
  });
  await api.ready();
  client = new RfqClient({ baseUrl: "http://api.test/", signer: wallet, fetch: inject(api) });
});

after(async () => {
  await api.close();
  await Promise.all(approvers.map((app) => app.close()));
  rmSync(directory, { recursive: true, force: true });
});

test("trade quotes, signs with the wallet and gets a two-approver quorum", async () => {
  const result = (await client.trade({ market: "BTC", side: "buy", amount: "1000" })) as {
    approvals: Array<{ signer: string }>;
  };
  assert.equal(new Set(result.approvals.map((approval) => approval.signer.toLowerCase())).size, 2);
});

test("reads and the ladder go through the same client", async () => {
  const ladder = (await client.ladder("ETH", ["500", "5000"])) as { buy: unknown[]; sell: unknown[] };
  assert.equal(ladder.buy.length, 2);
  assert.equal(ladder.sell.length, 2);
  const quote = await client.quote({ market: "BTC", side: "sell", amount: "250" });
  assert.match(quote.quoteId, /^[0-9a-f-]{36}$/);
});

test("API errors surface status and body", async () => {
  await assert.rejects(client.quote({ market: "DOGE", side: "buy", amount: "1" }), (error: unknown) => {
    assert(error instanceof RfqApiError);
    assert.equal(error.status, 400);
    return true;
  });
  await assert.rejects(
    new RfqClient({ baseUrl: "http://api.test", fetch: inject(api) }).trade({
      market: "BTC",
      side: "buy",
      amount: "1",
    }),
    /needs a signer/,
  );
});

test("helpers: isolated addresses match the shared derivation and nonces are fresh", async () => {
  assert.equal(await client.isolatedAccount(1), isolatedAccountAddress(wallet.address, 1));
  assert.notEqual(randomNonce(), randomNonce());
});
