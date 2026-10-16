import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { buildApprover } from "../../../services/approver/src/server.js";
import { buildApi } from "../../../services/api/src/server.js";
import {
  IntentMismatchError,
  RfqApiError,
  RfqClient,
  isolatedAccountAddress,
  randomNonce,
} from "./client.js";
import { verifyPrepared } from "./verify.js";

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
  const result = await client.trade({ market: "BTC", side: "buy", amount: "1000" });
  assert.equal(new Set(result.approvals.map((approval) => approval.signer.toLowerCase())).size, 2);
});

test("reads and the ladder go through the same client", async () => {
  const ladder = await client.ladder("ETH", ["500", "5000"]);
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

test("grantSession signs only the grant it asked for", async () => {
  const session = Wallet.createRandom().address,
    request = {
      session,
      marketIndexes: [0, 1],
      maxTradeAmount: "100",
      maxCumulativeAmount: "1000",
      durationSeconds: 3600,
    };
  const prepared = await api.inject({
    method: "POST",
    url: "/v1/session/prepare",
    payload: {
      account: wallet.address,
      session,
      marketMask: 3,
      maxTradeAmount: "100",
      maxCumulativeAmount: "1000",
      maxFee: "0.000001",
      durationSeconds: 3600,
      nonce: randomNonce(),
    },
  });
  assert.equal(prepared.statusCode, 200, prepared.body);
  const tampered = (patch: Record<string, unknown>) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await inject(api)(input, init);
      if (!String(input).endsWith("/v1/session/prepare")) return response;
      const body = (await response.json()) as { grant: Record<string, unknown> };
      return Response.json({ ...body, grant: { ...body.grant, ...patch } }, { status: response.status });
    }) as typeof fetch;
  for (const patch of [
    { session: Wallet.createRandom().address },
    { marketMask: "7" },
    { maxCumulativeNotional: "2000000000" },
    { validUntil: String(Math.floor(Date.now() / 1000) + 7200) },
  ])
    await assert.rejects(
      new RfqClient({ baseUrl: "http://api.test/", signer: wallet, fetch: tampered(patch) }).grantSession(
        request,
      ),
      /differs from the one requested/,
    );
  await assert.rejects(client.grantSession({ ...request, marketIndexes: [] }), /at least one market index/);
});

/** Routes to the API, rewriting the JSON body of responses to `path` with `patch`. */
function tamper(
  path: string,
  patch: (body: Record<string, unknown>) => Record<string, unknown>,
  seen?: string[],
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen?.push(new URL(String(input)).pathname);
    const response = await inject(api)(input, init);
    if (!String(input).endsWith(path)) return response;
    return Response.json(patch((await response.json()) as Record<string, unknown>), {
      status: response.status,
    });
  }) as typeof fetch;
}

test("trades sign only for the pinned settlement and the requested terms", async () => {
  const clearing = "0x0000000000000000000000000000000000000001";
  const pinned = new RfqClient({
    baseUrl: "http://api.test/",
    signer: wallet,
    fetch: inject(api),
    chainId: 31_337n,
    clearingAddress: clearing,
  });
  const result = await pinned.trade({ market: "BTC", side: "buy", amount: "1000" });
  assert.equal(result.approvals.length >= 2, true);

  const refusals: Array<[string, (body: Record<string, unknown>) => Record<string, unknown>, string?]> = [
    [
      "/v1/prepare",
      (body) => ({
        ...body,
        domain: { ...(body.domain as object), verifyingContract: "0x" + "22".repeat(20) },
      }),
    ],
    ["/v1/prepare", (body) => ({ ...body, domain: { ...(body.domain as object), chainId: "8453" } })],
    [
      "/v1/prepare",
      (body) => {
        const intent = body.intent as Record<string, string>;
        return { ...body, intent: { ...intent, baseDelta: (BigInt(intent.baseDelta) * 2n).toString() } };
      },
    ],
    [
      "/v1/prepare",
      (body) => ({ ...body, intent: { ...(body.intent as object), account: Wallet.createRandom().address } }),
    ],
    ["/v1/prepare", (body) => ({ ...body, intent: { ...(body.intent as object), maxFee: "1000000000" } })],
    // A quote whose worst price sits far past the requested 50 bps slippage.
    [
      "/v1/quote",
      (body) => ({
        ...body,
        worstPrice: ((BigInt(body.expectedPrice as string) * 10_300n) / 10_000n).toString(),
      }),
    ],
  ];
  for (const [path, patch] of refusals) {
    const seen: string[] = [];
    await assert.rejects(
      new RfqClient({
        baseUrl: "http://api.test/",
        signer: wallet,
        fetch: tamper(path, patch, seen),
        chainId: 31_337n,
        clearingAddress: clearing,
      }).trade({ market: "BTC", side: "buy", amount: "1000", slippageBps: 50 }),
      IntentMismatchError,
    );
    assert.equal(seen.includes("/v1/approve"), false, "nothing signed reaches the API");
  }

  // A client pinned to another contract refuses whatever the API's own config says.
  await assert.rejects(
    new RfqClient({
      baseUrl: "http://api.test/",
      signer: wallet,
      fetch: inject(api),
      chainId: 31_337n,
      clearingAddress: "0x" + "33".repeat(20),
    }).trade({ market: "BTC", side: "buy", amount: "1000" }),
    /wrong settlement contract/,
  );
});

test("withdrawals, margin moves and grants are checked field by field", () => {
  const clearing = "0x0000000000000000000000000000000000000001",
    context = { chainId: 31_337n, clearing, account: wallet.address },
    domain = { name: "RFQ Markets", version: "1", chainId: "31337", verifyingContract: clearing },
    withdrawal = {
      account: wallet.address,
      recipient: wallet.address,
      amount: "5000000",
      nonce: "7",
      deadline: "9999999999",
    },
    types = {
      WithdrawalIntent: [
        { name: "account", type: "address" },
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    },
    expected = { kind: "withdraw" as const, recipient: wallet.address, amountMicro: 5_000_000n, nonce: "7" };
  const signed = verifyPrepared({ domain, types }, withdrawal, "WithdrawalIntent", context, expected);
  assert.equal(signed.domain.chainId, 31_337n);
  for (const message of [
    { ...withdrawal, recipient: Wallet.createRandom().address },
    { ...withdrawal, amount: "5000001" },
    { ...withdrawal, nonce: "8" },
    { ...withdrawal, extra: "1" },
  ])
    assert.throws(
      () => verifyPrepared({ domain, types }, message, "WithdrawalIntent", context, expected),
      IntentMismatchError,
    );
  assert.throws(
    () =>
      verifyPrepared(
        { domain, types: { WithdrawalIntent: types.WithdrawalIntent.slice(1) } },
        withdrawal,
        "WithdrawalIntent",
        context,
        expected,
      ),
    /type definition/,
  );
  const margin = { account: wallet.address, market: 1, amount: "-5", nonce: "1", deadline: "9999999999" },
    marginTypes = {
      IsolatedMarginIntent: [
        { name: "account", type: "address" },
        { name: "market", type: "uint8" },
        { name: "amount", type: "int256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    },
    move = { kind: "isolated-margin" as const, market: 1, amountMicro: -5n, nonce: "1" };
  verifyPrepared({ domain, types: marginTypes }, margin, "IsolatedMarginIntent", context, move);
  assert.throws(
    () =>
      verifyPrepared(
        { domain, types: marginTypes },
        { ...margin, amount: "5" },
        "IsolatedMarginIntent",
        context,
        move,
      ),
    /margin amount changed/,
  );
  assert.throws(
    () =>
      verifyPrepared(
        { domain, types: marginTypes },
        { ...margin, market: 0 },
        "IsolatedMarginIntent",
        context,
        move,
      ),
    /market changed/,
  );
});
