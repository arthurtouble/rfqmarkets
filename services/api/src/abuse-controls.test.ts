import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Interface, JsonRpcProvider, Wallet, type TransactionRequest } from "ethers";
import { clearingApiAbi } from "../../../packages/shared/src/abi.js";
import {
  cancelTypes,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  isolatedMarginTypes,
  withdrawalTypes,
} from "../../../packages/shared/src/eip712.js";
import { isolatedAccountAddress } from "../../../packages/shared/src/isolated.js";
import { legMargin } from "../../../packages/shared/src/pricing.js";
import { QuoteAdmission } from "./admission.js";
import { ApproverRefusal, everyApproverRefused } from "./approvals.js";
import type { ApiContext } from "./context.js";
import { coversOpeningMargin, INSUFFICIENT_MARGIN } from "./execution.js";
import { executionRefusal, TERMINAL_ORDER_RETENTION_MS } from "./orders.js";
import { SimulatedMarketDataSource } from "./oracle.js";
import { buildApi } from "./server.js";
import { admitIsolatedMargin, admitSponsoredAction } from "./signed-actions.js";

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

test("isolated margin moves need collateral where they draw from and have their own budget", async () => {
  const owner = Wallet.createRandom().address,
    isolated = isolatedAccountAddress(owner, 0);
  const balances = new Map<string, bigint>();
  const ctx = {
    clearing: { collateralOf: async (account: string) => balances.get(account.toLowerCase()) ?? 0n },
    isolatedMarginActions: new QuoteAdmission(0, 2, 100, 1_000, 1_000),
  } as unknown as ApiContext;
  const add = { account: owner, market: 0, amount: 5n },
    remove = { account: owner, market: 0, amount: -5n };
  assert.equal((await admitIsolatedMargin(ctx, add))?.status, 409, "an unfunded owner cannot add");
  balances.set(owner.toLowerCase(), 10n);
  assert.equal(await admitIsolatedMargin(ctx, add), undefined);
  assert.equal((await admitIsolatedMargin(ctx, remove))?.status, 409, "an empty isolated account");
  balances.set(isolated.toLowerCase(), 5n);
  assert.equal(await admitIsolatedMargin(ctx, remove), undefined);
  assert.equal((await admitIsolatedMargin(ctx, add))?.status, 429, "the account's budget is spent");
});

test("sponsored withdrawals and margin moves are gated and simulated before the sender", async () => {
  const clearing = "0x0000000000000000000000000000000000000001",
    iface = new Interface(clearingApiAbi),
    user = Wallet.createRandom(),
    now = Math.floor(Date.now() / 1000);
  let collateral = 0n,
    reverts = true;
  const simulated: string[] = [],
    submitted: string[] = [];
  class Chain extends JsonRpcProvider {
    override async send(method: string): Promise<never> {
      throw new Error(`unexpected ${method}`);
    }
    override async call(request: TransactionRequest) {
      const parsed = iface.parseTransaction({ data: String(request.data) })!;
      if (parsed.name === "collateralOf") return iface.encodeFunctionResult("collateralOf", [collateral]);
      if (parsed.name === "isolatedOwner")
        return iface.encodeFunctionResult("isolatedOwner", ["0x" + "00".repeat(20)]);
      if (!parsed.name.includes("WithSignature")) throw new Error(`unexpected ${parsed.name}`);
      simulated.push(parsed.name);
      if (reverts) throw Object.assign(new Error("execution reverted"), { data: "0x50cb02e4" });
      return "0x";
    }
  }
  const provider = new Chain(),
    app = buildApi({
      provider,
      chainId: 84532n,
      verifyingContract: clearing,
      chain: {
        rpcUrl: "https://unused",
        sponsorPrivateKey: Wallet.createRandom().privateKey,
        clearingAddress: clearing,
        tokenAddress: "0x0000000000000000000000000000000000000002",
      },
      sender: {
        reconcile: async () => {},
        status: () => [],
        submit: async (id) => {
          submitted.push(id);
          return {
            hash: "0x" + "11".repeat(32),
            blockHash: "0x" + "22".repeat(32),
            blockNumber: 1,
            status: 1,
          };
        },
        hasOperation: (id) => submitted.includes(id),
      },
    });
  const domain = { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: 84532n, verifyingContract: clearing };
  const withdraw = async (nonce: bigint) => {
    const intent = {
      account: user.address,
      recipient: user.address,
      amount: 5n,
      nonce,
      deadline: BigInt(now + 120),
    };
    return app.inject({
      method: "POST",
      url: "/v1/withdraw/execute",
      payload: {
        intent: { ...intent, amount: "5", nonce: nonce.toString(), deadline: intent.deadline.toString() },
        userSignature: await user.signTypedData(domain, withdrawalTypes, intent),
      },
    });
  };
  const move = async (nonce: bigint) => {
    const intent = { account: user.address, market: 0, amount: 5n, nonce, deadline: BigInt(now + 120) };
    return app.inject({
      method: "POST",
      url: "/v1/isolated/margin/execute",
      payload: {
        intent: { ...intent, amount: "5", nonce: nonce.toString(), deadline: intent.deadline.toString() },
        userSignature: await user.signTypedData(domain, isolatedMarginTypes, intent),
      },
    });
  };
  try {
    await app.ready();
    assert.equal((await withdraw(1n)).statusCode, 409, "an unfunded account cannot withdraw");
    assert.equal((await move(1n)).statusCode, 409, "nor move margin");
    assert.deepEqual(simulated, [], "refused before any simulation");
    collateral = 10n * USDC;
    const reverted = await withdraw(2n);
    assert.equal(reverted.statusCode, 409, reverted.body);
    assert.equal(reverted.json().error, "Insufficient margin");
    assert.equal((await move(2n)).statusCode, 409);
    assert.deepEqual(simulated, ["withdrawWithSignature", "moveIsolatedMarginWithSignature"]);
    assert.deepEqual(submitted, [], "a failed simulation never reaches the sender");
    reverts = false;
    const moved = await move(3n);
    assert.equal(moved.statusCode, 200, moved.body);
    await withdraw(3n);
    assert.deepEqual(submitted, [`isolated:${user.address}:3`, `withdraw:${user.address}:3`]);
    // A client retrying actions the sender already journaled gets the stored outcome: no gate (the account
    // is empty now) and no simulation (it would revert: the nonce is spent).
    collateral = 0n;
    reverts = true;
    simulated.length = 0;
    const retried = await move(3n);
    assert.equal(retried.statusCode, 200, retried.body);
    await withdraw(3n);
    assert.deepEqual(simulated, []);
    assert.deepEqual(submitted.slice(2), [`isolated:${user.address}:3`, `withdraw:${user.address}:3`]);
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

test("terminal orders leave memory after the retention window; live ones stay listed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const target = buildApi(),
    user = Wallet.createRandom();
  const order = async (nonce: number) => {
    const prepared = (
      await target.inject({
        method: "POST",
        url: "/v1/orders/prepare",
        payload: {
          account: user.address,
          market: "BTC",
          side: "buy",
          amount: "100",
          limitPrice: "1000",
          durationSeconds: 300,
          nonce: String(nonce),
          reduceOnly: false,
        },
      })
    ).json();
    const placed = await target.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        orderId: prepared.orderId,
        userSignature: await user.signTypedData(prepared.domain, prepared.types, prepared.intent),
      },
    });
    assert.equal(placed.statusCode, 200, placed.body);
    return prepared.orderId as string;
  };
  const listed = async () =>
    (await target.inject({ method: "GET", url: `/v1/orders/${user.address}` }))
      .json()
      .items.map((item: { orderId: string; status: string }) => `${item.orderId}:${item.status}`);
  try {
    await target.ready();
    const first = await order(1);
    t.mock.timers.tick(301_000);
    // Placing another order runs the resting-order check, which expires the first.
    const second = await order(2);
    for (let i = 0; i < 50 && !(await listed()).includes(`${first}:expired`); i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual((await listed()).sort(), [`${first}:expired`, `${second}:open`].sort());
    // Still listed (order history, fill notices) within the retention window.
    t.mock.timers.tick(TERMINAL_ORDER_RETENTION_MS - 1_000);
    await target.inject({ method: "GET", url: "/v1/markets" });
    assert.equal((await listed()).length, 2);
    t.mock.timers.tick(2_000);
    // Any prune (here one run by an order prepare) evicts it.
    const pruning = await target.inject({
      method: "POST",
      url: "/v1/orders/prepare",
      payload: {
        account: Wallet.createRandom().address,
        market: "BTC",
        side: "buy",
        amount: "100",
        limitPrice: "1000",
        durationSeconds: 300,
        nonce: "3",
        reduceOnly: false,
      },
    });
    assert.equal(pruning.statusCode, 200, pruning.body);
    assert.deepEqual(await listed(), [`${second}:open`]);
  } finally {
    await target.close();
  }
});

test("a failed resting-order check is logged, not left as an unhandled rejection", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const directory = mkdtempSync(join(tmpdir(), "rfq-check-")),
    journalPath = join(directory, "api.sqlite"),
    source = new SimulatedMarketDataSource(),
    target = buildApi({ journalPath, oracleSource: source }),
    user = Wallet.createRandom(),
    unhandled: unknown[] = [],
    onUnhandled = (reason: unknown) => unhandled.push(reason);
  const logged = t.mock.method(console, "error", () => {});
  process.on("unhandledRejection", onUnhandled);
  let lock: DatabaseSync | undefined;
  try {
    await target.ready();
    const prepared = (
      await target.inject({
        method: "POST",
        url: "/v1/orders/prepare",
        payload: {
          account: user.address,
          market: "BTC",
          side: "buy",
          amount: "100",
          limitPrice: "1000",
          durationSeconds: 300,
          nonce: "1",
          reduceOnly: false,
        },
      })
    ).json();
    const placed = await target.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        orderId: prepared.orderId,
        userSignature: await user.signTypedData(prepared.domain, prepared.types, prepared.intent),
      },
    });
    assert.equal(placed.statusCode, 200, placed.body);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The order expires, but another process holds the journal: the expiry write fails.
    t.mock.timers.tick(301_000);
    lock = new DatabaseSync(journalPath);
    lock.exec("BEGIN EXCLUSIVE");
    source.setPrice("BTC", 100_000);
    for (let i = 0; i < 100 && !logged.mock.calls.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.match(String(logged.mock.calls[0]?.arguments[0]), /resting order check failed/);
  } finally {
    lock?.exec("ROLLBACK");
    lock?.close();
    process.off("unhandledRejection", onUnhandled);
    await target.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
