import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Interface, JsonRpcProvider, Wallet, type TransactionRequest } from "ethers";
import { clearingApiAbi } from "../../../packages/shared/src/abi.js";
import { cancelTypes, DOMAIN_NAME, DOMAIN_VERSION } from "../../../packages/shared/src/eip712.js";
import { legMargin } from "../../../packages/shared/src/pricing.js";
import { QuoteAdmission } from "./admission.js";
import { ApproverRefusal, everyApproverRefused } from "./approvals.js";
import type { ApiContext } from "./context.js";
import { coversOpeningMargin, INSUFFICIENT_MARGIN } from "./execution.js";
import { executionRefusal } from "./orders.js";
import { buildApi } from "./server.js";
import { admitSponsoredAction } from "./signed-actions.js";

const USDC = 1_000_000n,
  BASE = 10n ** 18n,
  ASK = 100_000n * USDC;
const capital = (collateral: bigint, openingEquity = collateral, initialMargin = 0n) => ({
  collateral,
  openingEquity,
  initialMargin,
});
const margin = (input: Partial<Parameters<typeof coversOpeningMargin>[0]>) =>
  coversOpeningMargin({
    capital: capital(0n),
    positionSize: 0n,
    delta: BASE / 10n,
    reduceOnly: false,
    ask: ASK,
    storedAsk: ASK,
    marginScaleBps: 10_000,
    ...input,
  });

test("the margin pre-check refuses opening trades an empty account cannot pay for", () => {
  // 0.1 BTC at 100k = 10k notional; the first tier asks 20% = 2k initial margin.
  const required = legMargin(10_000n * USDC, true, 10_000);
  assert.equal(required, 2_000n * USDC);
  assert.equal(margin({}), false, "zero collateral cannot open");
  assert.equal(margin({ delta: -BASE / 10n }), false, "nor open short");
  assert.equal(margin({ capital: capital(required - 1n) }), false);
  assert.equal(margin({ capital: capital(required) }), true);
  assert.equal(margin({ capital: capital(-1n, 10n ** 12n) }), false, "negative collateral never opens");
  assert.equal(
    margin({ capital: capital(required, required), marginScaleBps: 20_000 }),
    false,
    "the market's margin multiplier applies",
  );
});

test("the margin pre-check counts existing margin and never blocks reductions", () => {
  const position = BASE / 10n,
    legRequired = legMargin(10_000n * USDC, true, 10_000);
  // Increasing needs headroom over the current initial margin.
  assert.equal(
    margin({ positionSize: position, capital: capital(3_000n * USDC, 3_000n * USDC, 2_000n * USDC) }),
    false,
  );
  assert.equal(
    margin({ positionSize: position, capital: capital(4_000n * USDC, 4_000n * USDC, legRequired) }),
    true,
  );
  // Reductions and reduce-only trades are always admitted, even for an empty account.
  assert.equal(margin({ positionSize: position, delta: -position / 2n }), true);
  assert.equal(margin({ positionSize: position, delta: -position }), true);
  assert.equal(margin({ positionSize: -position, delta: position / 2n }), true);
  assert.equal(margin({ reduceOnly: true }), true);
  // A flip releases the old leg's margin and needs margin only for the new leg.
  assert.equal(
    margin({
      positionSize: position,
      delta: -2n * position,
      capital: capital(2_000n * USDC, 2_000n * USDC, legRequired),
    }),
    true,
  );
  assert.equal(
    margin({ positionSize: position, delta: -2n * position, capital: capital(0n, 0n, legRequired) }),
    false,
  );
});

test("only explicit approver refusals prove that no approval signature exists", () => {
  const refused = { status: "rejected" as const, reason: new ApproverRefusal("approver 409") };
  assert.equal(everyApproverRefused([]), true);
  assert.equal(everyApproverRefused([refused, refused, refused]), true);
  assert.equal(
    everyApproverRefused([refused, { status: "rejected", reason: new Error("timeout") }]),
    false,
    "a timed-out approver may have signed",
  );
  assert.equal(
    everyApproverRefused([
      refused,
      { status: "fulfilled", value: { digest: "0x", signer: "0x", signature: "0x" } },
    ]),
    false,
  );
});

test("resting orders are cancelled for margin at once and for repeated hard refusals only", () => {
  assert.equal(executionRefusal(409, { code: INSUFFICIENT_MARGIN }), "margin");
  assert.equal(
    executionRefusal(409, { code: INSUFFICIENT_MARGIN }, true),
    "refused",
    "protective orders stay",
  );
  assert.equal(executionRefusal(401, { error: "invalid user signature" }), "refused");
  assert.equal(executionRefusal(409, { error: "settlement simulation failed" }), "refused");
  assert.equal(
    executionRefusal(409, { error: "settlement simulation failed", retriable: true }),
    "transient",
  );
  for (const error of [
    "price moved beyond signed protection",
    "outstanding approvals exceed gross, net, stress, side or capital capacity",
  ])
    assert.equal(executionRefusal(409, { error }), "transient", error);
  assert.equal(executionRefusal(503, { error: "approver quorum unavailable" }), "transient");
});

test("sponsored actions need collateral and stay within a per-account budget", async () => {
  let collateral = 0n,
    failing = false;
  const ctx = {
    clearing: {
      collateralOf: async () => {
        if (failing) throw new Error("rpc down");
        return collateral;
      },
    },
    sponsoredActions: new QuoteAdmission(0, 1, 100, 1_000, 1_000),
  } as unknown as ApiContext;
  const funded = Wallet.createRandom().address,
    other = Wallet.createRandom().address;
  assert.equal((await admitSponsoredAction(ctx, funded))?.status, 409, "an unfunded account is refused");
  collateral = 1n;
  assert.equal(await admitSponsoredAction(ctx, funded), undefined);
  assert.equal((await admitSponsoredAction(ctx, funded))?.status, 429, "the account's budget is spent");
  failing = true;
  assert.equal((await admitSponsoredAction(ctx, other))?.status, 503, "a failed read fails closed");
  assert.equal(
    (await admitSponsoredAction({ ...ctx, clearing: undefined } as unknown as ApiContext, other))?.status,
    503,
  );
});

test("a sponsored nonce cancel from an unfunded account never reaches the sender", async () => {
  const clearing = "0x0000000000000000000000000000000000000001",
    iface = new Interface(clearingApiAbi),
    user = Wallet.createRandom(),
    now = Math.floor(Date.now() / 1000);
  let collateral = 0n;
  const submitted: Array<{ id: string; deadline?: number }> = [];
  class Chain extends JsonRpcProvider {
    override async send(method: string): Promise<never> {
      throw new Error(`unexpected ${method}`);
    }
    override async call(request: TransactionRequest) {
      const parsed = iface.parseTransaction({ data: String(request.data) })!;
      if (parsed.name === "collateralOf") return iface.encodeFunctionResult("collateralOf", [collateral]);
      throw new Error(`unexpected ${parsed.name}`);
    }
  }
  const provider = new Chain(),
    app = buildApi({
      provider,
      chainId: 84532n,
      verifyingContract: clearing,
      sponsoredActionRatePerSecond: 0,
      sponsoredActionBurst: 1,
      chain: {
        rpcUrl: "https://unused",
        sponsorPrivateKey: Wallet.createRandom().privateKey,
        clearingAddress: clearing,
        tokenAddress: "0x0000000000000000000000000000000000000002",
      },
      sender: {
        reconcile: async () => {},
        status: () => [],
        submit: async (id, _request, options) => {
          submitted.push({ id, deadline: options?.deadline });
          return {
            hash: "0x" + "11".repeat(32),
            blockHash: "0x" + "22".repeat(32),
            blockNumber: 1,
            status: 1,
          };
        },
      },
    });
  const domain = { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: 84532n, verifyingContract: clearing };
  const cancel = async (nonce: bigint) => {
    const intent = { account: user.address, nonce, deadline: BigInt(now + 120) },
      userSignature = await user.signTypedData(domain, cancelTypes, intent);
    return app.inject({
      method: "POST",
      url: "/v1/nonce/cancel/execute",
      payload: {
        intent: { account: user.address, nonce: nonce.toString(), deadline: intent.deadline.toString() },
        userSignature,
      },
    });
  };
  try {
    await app.ready();
    const refused = await cancel(1n);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(submitted.length, 0);
    collateral = 10n * USDC;
    const accepted = await cancel(2n);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(submitted, [{ id: `cancel:${user.address}:2`, deadline: now + 120 }]);
    assert.equal((await cancel(3n)).statusCode, 429, "per-account sponsored budget");
    assert.equal(submitted.length, 1);
  } finally {
    await app.close();
    provider.destroy();
  }
});

test("a reservation every approver refused is released; one with a possible signature is kept", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-abuse-"));
  const run = async (respond: () => Promise<Response>, name: string) => {
    const journalPath = join(directory, `${name}.sqlite`),
      user = Wallet.createRandom(),
      target = buildApi({
        operationsToken: "ops",
        journalPath,
        approvers: [0, 1, 2].map((index) => ({ url: `http://approver-${index}`, token: "t" })),
        fetchImpl: respond as unknown as typeof fetch,
      });
    try {
      await target.ready();
      const quote = (
        await target.inject({
          method: "POST",
          url: "/v1/quote",
          payload: { market: "BTC", side: "buy", amount: "1000" },
        })
      ).json();
      const nonce = "4242",
        prepared = (
          await target.inject({
            method: "POST",
            url: "/v1/prepare",
            payload: { quoteId: quote.quoteId, account: user.address, nonce },
          })
        ).json(),
        userSignature = await user.signTypedData(prepared.domain, prepared.types, prepared.intent),
        result = await target.inject({
          method: "POST",
          url: "/v1/approve",
          payload: { quoteId: quote.quoteId, account: user.address, nonce, userSignature },
        });
      assert.equal(result.statusCode, 503, result.body);
      const metrics = (
        await target.inject({ url: "/internal/metrics", headers: { authorization: "Bearer ops" } })
      ).json();
      const database = new DatabaseSync(journalPath);
      try {
        return {
          active: metrics.grossReservations.active as number,
          journaled: Number(
            (database.prepare("SELECT COUNT(*) count FROM gross_reservations").get() as { count: number })
              .count,
          ),
          commitments: Number(
            (database.prepare("SELECT COUNT(*) count FROM commitments").get() as { count: number }).count,
          ),
        };
      } finally {
        database.close();
      }
    } finally {
      await target.close();
    }
  };
  try {
    assert.deepEqual(
      await run(async () => new Response(JSON.stringify({ error: "rejected" }), { status: 409 }), "refused"),
      { active: 0, journaled: 0, commitments: 0 },
    );
    assert.deepEqual(
      await run(async () => {
        throw new Error("approver timed out");
      }, "timeout"),
      { active: 1, journaled: 1, commitments: 1 },
      "a timed-out approver may hold a signature, so capacity stays reserved",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("orders: prepared orders have their own cap and each account a live-order cap", async () => {
  const target = buildApi({ maxRestingOrders: 3, maxPreparedOrders: 4, maxRestingOrdersPerAccount: 2 });
  const user = Wallet.createRandom(),
    other = Wallet.createRandom();
  const prepare = (account: string, nonce: number) =>
    target.inject({
      method: "POST",
      url: "/v1/orders/prepare",
      payload: {
        account,
        market: "BTC",
        side: "buy",
        amount: "100",
        limitPrice: "1000",
        durationSeconds: 3600,
        nonce: String(nonce),
        reduceOnly: false,
      },
    });
  const place = async (signer: typeof user, response: Awaited<ReturnType<typeof prepare>>) => {
    const prepared = response.json();
    return target.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        orderId: prepared.orderId,
        userSignature: await signer.signTypedData(prepared.domain, prepared.types, prepared.intent),
      },
    });
  };
  try {
    await target.ready();
    // Four unsigned orders fit although resting capacity is three: prepared orders do not consume it.
    const staged = [];
    for (let nonce = 1; nonce <= 4; nonce++) {
      const response = await prepare(user.address, nonce);
      assert.equal(response.statusCode, 200, response.body);
      staged.push(response);
    }
    const overPrepared = await prepare(other.address, 9);
    assert.equal(overPrepared.statusCode, 409);
    assert.match(overPrepared.body, /capacity/);
    assert.equal((await place(user, staged[0])).statusCode, 200);
    assert.equal((await place(user, staged[1])).statusCode, 200);
    const third = await place(user, staged[2]);
    assert.equal(third.statusCode, 409);
    assert.match(third.body, /account open order limit/);
    const blocked = await prepare(user.address, 5);
    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.body, /account open order limit/);
    // Another account still has room up to global resting capacity.
    const otherOrder = await prepare(other.address, 6);
    assert.equal(otherOrder.statusCode, 200, otherOrder.body);
    assert.equal((await place(other, otherOrder)).statusCode, 200);
    const full = await prepare(Wallet.createRandom().address, 7);
    assert.equal(full.statusCode, 409);
    assert.match(full.body, /order capacity reached/);
  } finally {
    await target.close();
  }
});
