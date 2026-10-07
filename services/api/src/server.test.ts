import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AbiCoder, Wallet, keccak256 } from "ethers";
import { buildApprover } from "../../approver/src/server.js";
import { buildApi } from "./server.js";
import { importApproverRecovery } from "../../../scripts/approver-recovery.js";

const directory = mkdtempSync(join(tmpdir(), "rfq-services-"));
const chainId = 31_337n;
const verifyingContract = "0x0000000000000000000000000000000000000001";
const apps: Array<ReturnType<typeof buildApprover>> = [];
let api: ReturnType<typeof buildApi>;
let routedFetch: typeof fetch;
const user = Wallet.createRandom();

async function approveQuote(target: ReturnType<typeof buildApi>, quote: { quoteId: string }, signer = user) {
  const nonce = BigInt(`0x${crypto.randomUUID().replaceAll("-", "")}`).toString();
  const preparedResponse = await target.inject({
    method: "POST",
    url: "/v1/prepare",
    payload: { quoteId: quote.quoteId, account: signer.address, nonce },
  });
  assert.equal(preparedResponse.statusCode, 200, preparedResponse.body);
  const prepared = preparedResponse.json();
  const signature = await signer.signTypedData(prepared.domain, prepared.types, prepared.intent);
  return target.inject({
    method: "POST",
    url: "/v1/approve",
    payload: { quoteId: quote.quoteId, account: signer.address, nonce, userSignature: signature },
  });
}

before(async () => {
  const approvers = [];
  for (let index = 0; index < 3; index++) {
    const token = `transport-${index}`;
    const app = buildApprover({
      privateKey: Wallet.createRandom().privateKey,
      transportToken: token,
      databasePath: join(directory, `${index}.sqlite`),
      expectedChainId: chainId,
      expectedVerifyingContract: verifyingContract,
    });
    apps.push(app);
    await app.ready();
    approvers.push({ url: `http://approver-${index}`, token });
  }
  routedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const index = Number(url.hostname.split("-")[1]);
    if (!Number.isInteger(index) || !apps[index]) throw new Error("approver offline");
    const response = await apps[index].inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: url.pathname,
      headers: init?.headers as Record<string, string>,
      payload: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers as HeadersInit,
    });
  }) as typeof fetch;
  api = buildApi({ approvers, fetchImpl: routedFetch });
  await api.ready();
});

after(async () => {
  await api.close();
  await Promise.all(apps.map((app) => app.close()));
  rmSync(directory, { recursive: true, force: true });
});

test("two distinct approvers sign and same-direction reservations worsen the next quote", async () => {
  const firstResponse = await api.inject({
    method: "POST",
    url: "/v1/quote",
    payload: { market: "BTC", side: "buy", amount: "10000" },
  });
  assert.equal(firstResponse.statusCode, 200);
  const first = firstResponse.json();
  const reservation = await approveQuote(api, first);
  assert.equal(reservation.statusCode, 200, reservation.body);
  const approved = reservation.json();
  assert.equal(
    new Set(approved.approvals.map((item: { signer: string }) => item.signer.toLowerCase())).size,
    2,
  );
  const secondResponse = await api.inject({
    method: "POST",
    url: "/v1/quote",
    payload: { market: "BTC", side: "buy", amount: "10000" },
  });
  const second = secondResponse.json();
  assert(BigInt(second.expectedPrice) > BigInt(first.expectedPrice));
});

test("one unavailable approver still leaves quorum", async () => {
  const healthy = apps
    .slice(0, 2)
    .map((_, index) => ({ url: `http://approver-${index}`, token: `transport-${index}` }));
  const degraded = buildApi({
    approvers: [...healthy, { url: "http://approver-99", token: "offline" }],
    fetchImpl: routedFetch,
  });
  await degraded.ready();
  const quote = (
    await degraded.inject({
      method: "POST",
      url: "/v1/quote",
      payload: { market: "ETH", side: "sell", amount: "500" },
    })
  ).json();
  const result = await approveQuote(degraded, quote);
  assert.equal(result.statusCode, 200, result.body);
  await degraded.close();
});

test("leader startup restores recent paid-flow evidence from its durable journal", async () => {
  const journalPath = join(directory, "flow-restart.sqlite"),
    empty = buildApi({ journalPath });
  await empty.ready();
  await empty.close();
  const db = new DatabaseSync(journalPath),
    now = Date.now();
  db.prepare("INSERT INTO flow_fills(fill_id,market,side,price,notional,filled_ms) VALUES(?,?,?,?,?,?)").run(
    "fill-1",
    "BTC",
    "buy",
    "100000000000",
    "250000000000",
    now,
  );
  db.close();
  const restarted = buildApi({ journalPath, operationsToken: "ops" });
  await restarted.ready();
  assert.equal((await restarted.inject({ method: "GET", url: "/internal/metrics" })).statusCode, 401);
  const health = (
    await restarted.inject({
      method: "GET",
      url: "/internal/metrics",
      headers: { authorization: "Bearer ops" },
    })
  ).json();
  assert.equal(health.quoteModel.restoredPaidFills, 1);
  await restarted.close();
});

test("duplicate signed submissions share one approver quorum request", async () => {
  let calls = 0;
  const delayedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return routedFetch(input, init);
  }) as typeof fetch;
  const target = buildApi({
    approvers: apps.map((_, index) => ({ url: `http://approver-${index}`, token: `transport-${index}` })),
    fetchImpl: delayedFetch,
  });
  await target.ready();
  const quote = (
      await target.inject({
        method: "POST",
        url: "/v1/quote",
        payload: { market: "BTC", side: "buy", amount: "100" },
      })
    ).json(),
    nonce = "424242",
    prepared = (
      await target.inject({
        method: "POST",
        url: "/v1/prepare",
        payload: { quoteId: quote.quoteId, account: user.address, nonce },
      })
    ).json(),
    userSignature = await user.signTypedData(prepared.domain, prepared.types, prepared.intent),
    payload = { quoteId: quote.quoteId, account: user.address, nonce, userSignature };
  const [first, second] = await Promise.all([
    target.inject({ method: "POST", url: "/v1/approve", payload }),
    target.inject({ method: "POST", url: "/v1/approve", payload }),
  ]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(calls, 3, "duplicate submission multiplied signer work");
  const afterCompletion = await target.inject({ method: "POST", url: "/v1/approve", payload });
  assert.equal(afterCompletion.statusCode, 200, afterCompletion.body);
  assert.equal(afterCompletion.body, first.body);
  assert.equal(calls, 3, "completed retry requested another quorum");
  const mismatched = await target.inject({
    method: "POST",
    url: "/v1/approve",
    payload: { ...payload, account: Wallet.createRandom().address },
  });
  assert.equal(mismatched.statusCode, 409);
  await target.close();
});

test("fenced signer recovery repairs missing payloads only with bound signatures and rolls back journal failures", async () => {
  const key = Wallet.createRandom(),
    path = join(directory, "repair-approver.sqlite"),
    signer = buildApprover({
      privateKey: key.privateKey,
      transportToken: "repair",
      databasePath: path,
      expectedChainId: chainId,
      expectedVerifyingContract: verifyingContract,
    });
  await signer.ready();
  const target = buildApi({
    approvers: [
      { url: "http://repair", token: "repair" },
      ...apps.slice(1).map((_, i) => ({ url: `http://approver-${i + 1}`, token: `transport-${i + 1}` })),
    ],
    fetchImpl: (async (input, init) => {
      if (new URL(String(input)).hostname !== "repair") return routedFetch(input, init);
      const response = await signer.inject({
        method: "POST",
        url: "/approve",
        headers: { authorization: "Bearer repair", "content-type": "application/json" },
        payload: String(init?.body),
      });
      return new Response(response.body, { status: response.statusCode });
    }) as typeof fetch,
  });
  await target.ready();
  try {
    const quote = (
      await target.inject({
        method: "POST",
        url: "/v1/quote",
        payload: { market: "ETH", side: "buy", amount: "100" },
      })
    ).json();
    const result = await approveQuote(target, quote);
    assert.equal(result.statusCode, 200, result.body);
    const exported = (
      await signer.inject({ url: "/internal/recovery", headers: { authorization: "Bearer repair" } })
    ).json();
    assert.equal(exported.approvals.length, 1);
    await signer.close();
    const db = new DatabaseSync(path),
      expected = { chainId, proxy: verifyingContract, signer: key.address };
    try {
      db.exec("UPDATE approvals SET payload=NULL");
      const forged = structuredClone(exported);
      const payload = JSON.parse(forged.approvals[0].payload);
      payload.approval.executionPrice = "1";
      forged.approvals[0].payload = JSON.stringify(payload);
      assert.throws(() => importApproverRecovery(db, forged, expected), /binding/);
      assert.equal(db.prepare("SELECT payload FROM approvals").get()!.payload, null);
      assert.throws(() => importApproverRecovery(db, exported, { ...expected, chainId: 8453n }), /context/);
      db.exec(
        "CREATE TRIGGER fail_recovery BEFORE INSERT ON gross_reservations BEGIN SELECT RAISE(ABORT,'disk failure'); END",
      );
      assert.throws(() => importApproverRecovery(db, exported, expected), /disk failure/);
      assert.equal(db.prepare("SELECT payload FROM approvals").get()!.payload, null);
      db.exec("DROP TRIGGER fail_recovery");
      assert.deepEqual(importApproverRecovery(db, exported, expected), {
        imported: 1,
        incompleteExport: 0,
        incompleteJournal: 0,
      });
      assert.equal(importApproverRecovery(db, exported, expected).imported, 1);
      assert.equal(db.prepare("SELECT COUNT(*) count FROM gross_reservations").get()!.count, 1);
    } finally {
      db.close();
    }
  } finally {
    await target.close();
    await signer.close();
  }
});

test("a stalled quorum does not hold admission for another wallet and retained reservations remain priced", async () => {
  let release!: () => void, entered!: () => void;
  const stalled = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const target = buildApi({
    operationsToken: "lock-test",
    approvers: apps.map((_, index) => ({ url: `http://approver-${index}`, token: `transport-${index}` })),
    fetchImpl: (async (input, init) => {
      const payload = JSON.parse(String(init?.body));
      if (payload.intent.nonce === "70701") {
        entered();
        await stalled;
      }
      return routedFetch(input, init);
    }) as typeof fetch,
  });
  await target.ready();
  const prepare = async (nonce: string, signer: typeof user) => {
    const quote = (
        await target.inject({
          method: "POST",
          url: "/v1/quote",
          payload: { market: "BTC", side: "buy", amount: "100" },
        })
      ).json(),
      prepared = (
        await target.inject({
          method: "POST",
          url: "/v1/prepare",
          payload: { quoteId: quote.quoteId, account: signer.address, nonce },
        })
      ).json();
    return {
      quote,
      payload: {
        quoteId: quote.quoteId,
        account: signer.address,
        nonce,
        userSignature: await signer.signTypedData(prepared.domain, prepared.types, prepared.intent),
      },
    };
  };
  try {
    const first = await prepare("70701", user),
      pending = target.inject({ method: "POST", url: "/v1/approve", payload: first.payload });
    await started;
    const other = await prepare("70702", Wallet.createRandom());
    assert(BigInt(other.quote.expectedPrice) > BigInt(first.quote.expectedPrice));
    const second = await Promise.race([
      target.inject({ method: "POST", url: "/v1/approve", payload: other.payload }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("admission held by stalled quorum")), 1000),
      ),
    ]);
    assert.equal(second.statusCode, 200, second.body);
    const metrics = (
      await target.inject({ url: "/internal/metrics", headers: { authorization: "Bearer lock-test" } })
    ).json();
    assert.equal(metrics.grossReservations.active, 2);
    release();
    const result = await pending;
    assert.equal(result.statusCode, 200, result.body);
  } finally {
    release();
    await target.close();
  }
});

test("real oracle source drives quotes and fails closed when unavailable", async () => {
  const now = Math.floor(Date.now() / 1_000),
    oracleApi = buildApi({
      oracleSource: {
        latest: async (market) => ({
          snapshot: {
            market,
            bid: market === "BTC" ? 89_990n * 1_000_000n : 2_990n * 1_000_000n,
            ask: market === "BTC" ? 90_010n * 1_000_000n : 3_010n * 1_000_000n,
            observedAtMs: Date.now(),
          },
          report: "0x1234",
          validUntil: now + 10,
        }),
      },
    });
  await oracleApi.ready();
  const response = await oracleApi.inject({
    method: "POST",
    url: "/v1/quote",
    payload: { market: "BTC", side: "buy", amount: "100" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const quote = response.json();
  assert(BigInt(quote.expectedPrice) > 89_990n * 1_000_000n);
  assert(Number(quote.expiresAtMs) <= (now + 10) * 1_000);
  await oracleApi.close();
  const failed = buildApi({
    oracleSource: {
      latest: async () => {
        throw new Error("feed unavailable");
      },
    },
  });
  await failed.ready();
  const unavailable = await failed.inject({
    method: "POST",
    url: "/v1/quote",
    payload: { market: "BTC", side: "buy", amount: "100" },
  });
  assert.equal(unavailable.statusCode, 503);
  await failed.close();
});

test("public quotes and market reads omit oracle transport credentials", async () => {
  const secret = "https://oracle/private-token Bearer signer-token signed-body",
    target = buildApi({
      oracleSource: {
        latest: async () => {
          throw new Error(secret);
        },
      },
    });
  await target.ready();
  try {
    for (const request of [
      { method: "GET" as const, url: "/v1/markets" },
      { method: "POST" as const, url: "/v1/quote", payload: { market: "BTC", side: "buy", amount: "100" } },
    ]) {
      const response = await target.inject(request);
      assert.equal(response.statusCode, 503);
      for (const canary of ["private-token", "signer-token", "signed-body"])
        assert(!response.body.includes(canary));
    }
  } finally {
    await target.close();
  }
});

test("origin budgets cover reads and invalid write attempts while forwarding headers cannot invent clients", async () => {
  const target = buildApi({ publicReadBurst: 1, publicWriteBurst: 1 });
  await target.ready();
  try {
    assert.equal((await target.inject("/v1/config")).statusCode, 200);
    assert.equal(
      (await target.inject({ url: "/v1/config", headers: { "x-forwarded-for": "198.51.100.20" } }))
        .statusCode,
      429,
    );
    assert.equal(
      (await target.inject({ method: "POST", url: "/v1/withdraw/prepare", payload: {} })).statusCode,
      400,
    );
    assert.equal(
      (
        await target.inject({
          method: "POST",
          url: "/v1/session/execute",
          headers: { "x-forwarded-for": "198.51.100.21" },
          payload: {},
        })
      ).statusCode,
      429,
    );
    assert.equal((await target.inject("/health")).statusCode, 200);
  } finally {
    await target.close();
  }
});

test("refreshes the authenticated settlement proof after wallet signing", async () => {
  const now = Math.floor(Date.now() / 1_000);
  let settlements = 0;
  const observation = (bid: bigint, ask: bigint, reportTag: string) => ({
    snapshot: { market: "BTC" as const, bid, ask, observedAtMs: Date.now() },
    report: AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)[]"],
      [[[0, bid, ask, now, now + 15]]],
    ),
    validUntil: now + 15,
    reportTag,
  });
  const target = buildApi({
    approvers: apps.map((_, index) => ({ url: `http://approver-${index}`, token: `transport-${index}` })),
    fetchImpl: routedFetch,
    oracleSource: {
      latest: async () => observation(99_990n * 1_000_000n, 100_010n * 1_000_000n, "indicative"),
      settlement: async () => {
        settlements++;
        return settlements === 1
          ? observation(99_990n * 1_000_000n, 100_010n * 1_000_000n, "initial")
          : observation(99_995n * 1_000_000n, 100_015n * 1_000_000n, "refreshed");
      },
    },
  });
  await target.ready();
  const quote = (
      await target.inject({
        method: "POST",
        url: "/v1/quote",
        payload: { market: "BTC", side: "buy", amount: "100" },
      })
    ).json(),
    nonce = "991",
    prepared = (
      await target.inject({
        method: "POST",
        url: "/v1/prepare",
        payload: { quoteId: quote.quoteId, account: user.address, nonce },
      })
    ).json();
  assert(
    Number(prepared.intent.deadline) > now + 10,
    "user intent must not inherit the first oracle proof expiry",
  );
  const userSignature = await user.signTypedData(prepared.domain, prepared.types, prepared.intent),
    response = await target.inject({
      method: "POST",
      url: "/v1/approve",
      payload: { quoteId: quote.quoteId, account: user.address, nonce, userSignature },
    });
  assert.equal(response.statusCode, 200, response.body);
  const approved = response.json(),
    expectedReport = observation(99_995n * 1_000_000n, 100_015n * 1_000_000n, "refreshed").report;
  assert.equal(settlements, 2);
  assert.equal(approved.approval.oracleReportHash, keccak256(expectedReport));
  assert(BigInt(approved.quote.expectedPrice) > BigInt(quote.expectedPrice));
  await target.close();
});

test("rejects a refreshed settlement price outside the signed protection", async () => {
  const now = Math.floor(Date.now() / 1_000);
  let settlements = 0;
  const observation = (bid: bigint, ask: bigint) => ({
      snapshot: { market: "BTC" as const, bid, ask, observedAtMs: Date.now() },
      report: AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)[]"],
        [[[0, bid, ask, now, now + 15]]],
      ),
      validUntil: now + 15,
    }),
    target = buildApi({
      oracleSource: {
        latest: async () => observation(99_990n * 1_000_000n, 100_010n * 1_000_000n),
        settlement: async () => {
          settlements++;
          return settlements === 1
            ? observation(99_990n * 1_000_000n, 100_010n * 1_000_000n)
            : observation(100_990n * 1_000_000n, 101_010n * 1_000_000n);
        },
      },
    });
  await target.ready();
  const quote = (
      await target.inject({
        method: "POST",
        url: "/v1/quote",
        payload: { market: "BTC", side: "buy", amount: "100" },
      })
    ).json(),
    nonce = "992",
    prepared = (
      await target.inject({
        method: "POST",
        url: "/v1/prepare",
        payload: { quoteId: quote.quoteId, account: user.address, nonce },
      })
    ).json(),
    userSignature = await user.signTypedData(prepared.domain, prepared.types, prepared.intent),
    response = await target.inject({
      method: "POST",
      url: "/v1/approve",
      payload: { quoteId: quote.quoteId, account: user.address, nonce, userSignature },
    });
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().error, /signed protection/);
  await target.close();
});

test("refreshes and re-approves automatically when the first proof lacks inclusion budget", async () => {
  const now = Math.floor(Date.now() / 1_000);
  let settlements = 0;
  const observation = (validFor: number) => ({
    snapshot: {
      market: "BTC" as const,
      bid: 99_990n * 1_000_000n,
      ask: 100_010n * 1_000_000n,
      observedAtMs: Date.now(),
    },
    report: AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)[]"],
      [[[0, 99_990n * 1_000_000n, 100_010n * 1_000_000n, now, now + validFor]]],
    ),
    validUntil: now + validFor,
  });
  const target = buildApi({
    approvers: apps.map((_, index) => ({ url: `http://approver-${index}`, token: `transport-${index}` })),
    fetchImpl: routedFetch,
    minSettlementInclusionSeconds: 8,
    operationsToken: "ops",
    oracleSource: {
      latest: async () => observation(15),
      settlement: async () => observation(++settlements === 2 ? 6 : 15),
    },
  });
  await target.ready();
  const quote = (
      await target.inject({
        method: "POST",
        url: "/v1/quote",
        payload: { market: "BTC", side: "buy", amount: "100" },
      })
    ).json(),
    nonce = "993",
    prepared = (
      await target.inject({
        method: "POST",
        url: "/v1/prepare",
        payload: { quoteId: quote.quoteId, account: user.address, nonce },
      })
    ).json(),
    userSignature = await user.signTypedData(prepared.domain, prepared.types, prepared.intent),
    response = await target.inject({
      method: "POST",
      url: "/v1/approve",
      payload: { quoteId: quote.quoteId, account: user.address, nonce, userSignature },
    });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(settlements, 3, "approval did not replace the short-lived proof");
  const health = (
    await target.inject({ method: "GET", url: "/internal/metrics", headers: { authorization: "Bearer ops" } })
  ).json();
  assert(health.latency.firmQuote.count >= 1);
  assert(health.latency.tradeApproval.count >= 1);
  assert(health.latency.tradeApproval.p95Ms >= 0);
  await target.close();
});

test("development funding cannot expose a wallet on a non-local chain", () => {
  assert.throws(
    () =>
      buildApi({
        chainId: 8453n,
        chain: {
          rpcUrl: "https://mainnet.base.org",
          sponsorPrivateKey: Wallet.createRandom().privateKey,
          clearingAddress: "0x0000000000000000000000000000000000000001",
          tokenAddress: "0x0000000000000000000000000000000000000002",
          devFund: true,
          devWallet: { account: Wallet.createRandom().address, privateKey: Wallet.createRandom().privateKey },
        },
      }),
    /development funding requires local chain/,
  );
});

test("public config never exposes the API's credentialed RPC transport", async () => {
  const target = buildApi({
    chainId: 84532n,
    publicRpcUrl: "https://sepolia.base.org",
    chain: {
      rpcUrl: "https://provider.example/v3/private-token",
      sponsorPrivateKey: Wallet.createRandom().privateKey,
      clearingAddress: "0x0000000000000000000000000000000000000001",
      tokenAddress: "0x0000000000000000000000000000000000000002",
    },
  });
  await target.ready();
  const config = (await target.inject({ method: "GET", url: "/v1/config" })).json();
  assert.equal(config.rpcUrl, "https://sepolia.base.org");
  assert(!JSON.stringify(config).includes("private-token"));
  await target.close();
});

test("market snapshots expose bid, ask, mid and signed funding without a chain", async () => {
  const marketApi = buildApi();
  await marketApi.ready();
  const response = await marketApi.inject({ method: "GET", url: "/v1/markets" });
  assert.equal(response.statusCode, 200, response.body);
  const snapshot = response.json();
  assert.equal(snapshot.markets.BTC.mid, "100000000000");
  assert.equal(snapshot.markets.BTC.bid, "99990000000");
  assert.equal(snapshot.markets.BTC.ask, "100010000000");
  assert.equal(snapshot.markets.BTC.fundingApr, "0");
  assert.equal(snapshot.markets.ETH.enabled, true);
  assert.deepEqual(snapshot.pricing.settled, { BTC: "0", ETH: "0" });
  assert.deepEqual(snapshot.pricing.pending, []);
  assert.equal(snapshot.markets.BTC.maxTradeNotional, "1000000000000");
  assert.equal(snapshot.markets.BTC.maxMarketNotional, "5000000000000");
  await marketApi.close();
});

test("hedge monitor failure fails firm quotes closed and exposes reduce-only market state", async () => {
  const hedgeRiskSource = {
      latest: async () => {
        throw new Error("hedger offline");
      },
    },
    marketApi = buildApi({ hedgeRiskSource });
  await marketApi.ready();
  const markets = (await marketApi.inject({ method: "GET", url: "/v1/markets" })).json();
  assert.equal(markets.markets.BTC.riskMode, "reduce_only");
  assert.equal(markets.markets.BTC.canBuy, false);
  assert.equal(markets.markets.BTC.canSell, false);
  const quote = await marketApi.inject({
    method: "POST",
    url: "/v1/quote",
    payload: { market: "BTC", side: "buy", amount: "100" },
  });
  assert.equal(quote.statusCode, 503);
  assert.match(quote.body, /exposure-reducing/);
  await marketApi.close();
});

test("firm quotes include measured hedge cost, latency, and venue basis", async () => {
  const observedAtMs = Date.now(),
    hedgeRiskSource = {
      latest: async () => ({
        observedAtMs,
        healthy: true,
        indexedBlock: 50,
        markets: {
          BTC: {
            mode: "normal" as const,
            gapNotional: "0",
            bandUsdc: "1000000",
            execution: {
              estimatedCostBps: 4,
              latencyMs: 1_000,
              basisBps: 3,
              depthUsdc: "50000000000",
              observedAtMs,
            },
          },
          ETH: { mode: "normal" as const, gapNotional: "0", bandUsdc: "1000000" },
        },
      }),
    };
  const target = buildApi({ hedgeRiskSource, operationsToken: "ops" });
  await target.ready();
  const quote = (
    await target.inject({
      method: "POST",
      url: "/v1/quote",
      payload: { market: "BTC", side: "buy", amount: "100" },
    })
  ).json();
  assert(BigInt(quote.spread.hedgeBps) >= 4n);
  assert.equal(quote.spread.basisBps, "3");
  const health = (
    await target.inject({ method: "GET", url: "/internal/metrics", headers: { authorization: "Bearer ops" } })
  ).json();
  assert.equal(health.shadowModel.count, 1);
  await target.close();
});

test("firm quote and unsigned order preparation have bounded admission", async () => {
  const bounded = buildApi({ maxActiveQuotes: 1, maxRestingOrders: 1 });
  await bounded.ready();
  assert.equal(
    (
      await bounded.inject({
        method: "POST",
        url: "/v1/quote",
        payload: { market: "BTC", side: "buy", amount: "100" },
      })
    ).statusCode,
    200,
  );
  const full = await bounded.inject({
    method: "POST",
    url: "/v1/quote",
    payload: { market: "BTC", side: "buy", amount: "101" },
  });
  assert.equal(full.statusCode, 409);
  assert.match(full.body, /capacity/);
  const payload = {
    account: user.address,
    market: "ETH",
    side: "buy",
    amount: "100",
    limitPrice: "2000",
    durationSeconds: 3600,
    nonce: "991",
    reduceOnly: false,
  };
  assert.equal(
    (await bounded.inject({ method: "POST", url: "/v1/orders/prepare", payload })).statusCode,
    200,
  );
  const orderFull = await bounded.inject({
    method: "POST",
    url: "/v1/orders/prepare",
    payload: { ...payload, nonce: "992" },
  });
  assert.equal(orderFull.statusCode, 409);
  assert.match(orderFull.body, /capacity/);
  await bounded.close();
});

test("firm quote admission throttles one client without blocking another", async () => {
  const target = buildApi({
    trustedProxy: ["127.0.0.1"],
    firmQuoteRatePerSecond: 0.01,
    firmQuoteBurst: 2,
    globalFirmQuoteRatePerSecond: 1_000,
    globalFirmQuoteBurst: 1_000,
  });
  await target.ready();
  const payload = { market: "BTC", side: "buy", amount: "100" };
  const first = { "x-forwarded-for": "203.0.113.1" },
    second = { "x-forwarded-for": "203.0.113.2" };
  assert.equal(
    (await target.inject({ method: "POST", url: "/v1/quote", headers: first, payload })).statusCode,
    200,
  );
  assert.equal(
    (await target.inject({ method: "POST", url: "/v1/quote", headers: first, payload })).statusCode,
    200,
  );
  const limited = await target.inject({
    method: "POST",
    url: "/v1/orders/prepare",
    headers: first,
    payload: {
      account: user.address,
      market: "BTC",
      side: "buy",
      amount: "100",
      limitPrice: "90000",
      durationSeconds: 3600,
      nonce: "123",
      reduceOnly: false,
    },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "1");
  assert.equal(
    (await target.inject({ method: "POST", url: "/v1/quote", headers: second, payload })).statusCode,
    200,
  );
  await target.close();
});

test("a durable all-or-none limit order binds size, price, fee, nonce and expiry", async () => {
  const orderApi = buildApi();
  await orderApi.ready();
  const nonce = "998877";
  const preparedResponse = await orderApi.inject({
    method: "POST",
    url: "/v1/orders/prepare",
    payload: {
      account: user.address,
      market: "BTC",
      side: "buy",
      amount: "1000",
      limitPrice: "90000",
      durationSeconds: 3600,
      nonce,
      reduceOnly: false,
    },
  });
  assert.equal(preparedResponse.statusCode, 200, preparedResponse.body);
  const prepared = preparedResponse.json();
  assert.equal(prepared.intent.leaderEpoch, undefined);
  assert.equal(prepared.intent.policyVersion, undefined);
  assert.equal(prepared.intent.limitPrice, "90000000000");
  assert.equal(prepared.intent.nonce, nonce);
  const attacker = Wallet.createRandom(),
    badSignature = await attacker.signTypedData(prepared.domain, prepared.types, prepared.intent);
  assert.equal(
    (
      await orderApi.inject({
        method: "POST",
        url: "/v1/orders",
        payload: { orderId: prepared.orderId, userSignature: badSignature },
      })
    ).statusCode,
    401,
  );
  const signature = await user.signTypedData(prepared.domain, prepared.types, prepared.intent),
    placed = await orderApi.inject({
      method: "POST",
      url: "/v1/orders",
      payload: { orderId: prepared.orderId, userSignature: signature },
    });
  assert.equal(placed.statusCode, 200, placed.body);
  const list = (await orderApi.inject({ method: "GET", url: `/v1/orders/${user.address}` })).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].status, "open");
  assert.equal(list.items[0].limitPrice, "90000000000");
  await orderApi.close();
});

test("an open limit order survives API restart without becoming a balance ledger", async () => {
  const journalPath = join(directory, "orders-restart.sqlite"),
    first = buildApi({ journalPath });
  await first.ready();
  const prepared = (
      await first.inject({
        method: "POST",
        url: "/v1/orders/prepare",
        payload: {
          account: user.address,
          market: "ETH",
          side: "sell",
          amount: "750",
          limitPrice: "5000",
          durationSeconds: 3600,
          nonce: "123123",
          reduceOnly: false,
        },
      })
    ).json(),
    signature = await user.signTypedData(prepared.domain, prepared.types, prepared.intent);
  assert.equal(
    (
      await first.inject({
        method: "POST",
        url: "/v1/orders",
        payload: { orderId: prepared.orderId, userSignature: signature },
      })
    ).statusCode,
    200,
  );
  await first.close();
  const restarted = buildApi({ journalPath });
  await restarted.ready();
  const list = (await restarted.inject({ method: "GET", url: `/v1/orders/${user.address}` })).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].orderId, prepared.orderId);
  assert.equal(list.items[0].status, "open");
  await restarted.close();
});

test("an invalid wallet signature cannot reserve portfolio capacity", async () => {
  const first = (
    await api.inject({
      method: "POST",
      url: "/v1/quote",
      payload: { market: "ETH", side: "buy", amount: "777" },
    })
  ).json();
  const nonce = "7";
  const prepared = (
    await api.inject({
      method: "POST",
      url: "/v1/prepare",
      payload: { quoteId: first.quoteId, account: user.address, nonce },
    })
  ).json();
  const attacker = Wallet.createRandom();
  const badSignature = await attacker.signTypedData(prepared.domain, prepared.types, prepared.intent);
  const rejected = await api.inject({
    method: "POST",
    url: "/v1/approve",
    payload: { quoteId: first.quoteId, account: user.address, nonce, userSignature: badSignature },
  });
  assert.equal(rejected.statusCode, 401);
  const second = (
    await api.inject({
      method: "POST",
      url: "/v1/quote",
      payload: { market: "ETH", side: "buy", amount: "777" },
    })
  ).json();
  assert.equal(second.expectedPrice, first.expectedPrice);
});

test("a prepared quote cannot be reused by another wallet or nonce", async () => {
  const quote = (
    await api.inject({
      method: "POST",
      url: "/v1/quote",
      payload: { market: "BTC", side: "buy", amount: "333" },
    })
  ).json();
  const nonce = "123456";
  const first = await api.inject({
    method: "POST",
    url: "/v1/prepare",
    payload: { quoteId: quote.quoteId, account: user.address, nonce },
  });
  assert.equal(first.statusCode, 200, first.body);
  const retry = await api.inject({
    method: "POST",
    url: "/v1/prepare",
    payload: { quoteId: quote.quoteId, account: user.address, nonce },
  });
  assert.equal(retry.statusCode, 200, retry.body);
  const attacker = Wallet.createRandom();
  const otherWallet = await api.inject({
    method: "POST",
    url: "/v1/prepare",
    payload: { quoteId: quote.quoteId, account: attacker.address, nonce },
  });
  assert.equal(otherWallet.statusCode, 409);
  const otherNonce = await api.inject({
    method: "POST",
    url: "/v1/prepare",
    payload: { quoteId: quote.quoteId, account: user.address, nonce: "123457" },
  });
  assert.equal(otherNonce.statusCode, 409);
});

test("market intents bind reduce-only and cannot be re-prepared with weaker semantics", async () => {
  const target = buildApi({
    approvers: apps.map((_, index) => ({ url: `http://approver-${index}`, token: `transport-${index}` })),
    fetchImpl: routedFetch,
  });
  await target.ready();
  const quote = (
      await target.inject({
        method: "POST",
        url: "/v1/quote",
        payload: { market: "ETH", side: "sell", amount: "200" },
      })
    ).json(),
    nonce = "771122";
  const first = await target.inject({
    method: "POST",
    url: "/v1/prepare",
    payload: { quoteId: quote.quoteId, account: user.address, nonce, reduceOnly: true },
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().intent.reduceOnly, true);
  const second = await target.inject({
    method: "POST",
    url: "/v1/prepare",
    payload: { quoteId: quote.quoteId, account: user.address, nonce, reduceOnly: false },
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().intent.reduceOnly, true, "the first prepared intent must remain authoritative");
  const signature = await user.signTypedData(first.json().domain, first.json().types, first.json().intent),
    approved = await target.inject({
      method: "POST",
      url: "/v1/approve",
      payload: {
        quoteId: quote.quoteId,
        account: user.address,
        nonce,
        userSignature: signature,
        reduceOnly: false,
      },
    });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().intent.reduceOnly, true, "approval must use the signed prepared intent");
  await target.close();
});

test("approvers reject an API that requests signatures for an unpinned chain domain", async () => {
  const approvers = apps.map((_, index) => ({
    url: `http://approver-${index}`,
    token: `transport-${index}`,
  }));
  const wrongDomain = buildApi({ approvers, fetchImpl: routedFetch, chainId: 1n, verifyingContract });
  await wrongDomain.ready();
  const quote = (
    await wrongDomain.inject({
      method: "POST",
      url: "/v1/quote",
      payload: { market: "BTC", side: "sell", amount: "250" },
    })
  ).json();
  const result = await approveQuote(wrongDomain, quote);
  assert.equal(result.statusCode, 503);
  await wrongDomain.close();
});

test("a restart restores the signed retry envelope and escaped reservation exposure", async () => {
  const approvers = apps.map((_, index) => ({
    url: `http://approver-${index}`,
    token: `transport-${index}`,
  }));
  const journalPath = join(directory, "api.sqlite");
  const firstApi = buildApi({ approvers, fetchImpl: routedFetch, journalPath });
  await firstApi.ready();
  const first = (
    await firstApi.inject({
      method: "POST",
      url: "/v1/quote",
      payload: { market: "BTC", side: "buy", amount: "900" },
    })
  ).json();
  const nonce = "909090",
    prepared = (
      await firstApi.inject({
        method: "POST",
        url: "/v1/prepare",
        payload: { quoteId: first.quoteId, account: user.address, nonce },
      })
    ).json(),
    userSignature = await user.signTypedData(prepared.domain, prepared.types, prepared.intent),
    payload = { quoteId: first.quoteId, account: user.address, nonce, userSignature };
  assert.equal((await firstApi.inject({ method: "POST", url: "/v1/approve", payload })).statusCode, 200);
  await firstApi.close();
  const restarted = buildApi({ approvers, fetchImpl: routedFetch, journalPath });
  await restarted.ready();
  const retried = await restarted.inject({ method: "POST", url: "/v1/approve", payload });
  assert.equal(retried.statusCode, 200, retried.body);
  const after = (
    await restarted.inject({
      method: "POST",
      url: "/v1/quote",
      payload: { market: "BTC", side: "buy", amount: "900" },
    })
  ).json();
  assert(BigInt(after.expectedPrice) > BigInt(first.expectedPrice));
  await restarted.close();
});

test("leader readiness rejects an active commitment whose approval artifact is missing", async () => {
  const approvers = apps.map((_, index) => ({
    url: `http://approver-${index}`,
    token: `transport-${index}`,
  }));
  const journalPath = join(directory, "api-incomplete.sqlite"),
    firstApi = buildApi({ approvers, fetchImpl: routedFetch, journalPath });
  await firstApi.ready();
  const quote = (
    await firstApi.inject({
      method: "POST",
      url: "/v1/quote",
      payload: { market: "ETH", side: "sell", amount: "125" },
    })
  ).json();
  assert.equal((await approveQuote(firstApi, quote)).statusCode, 200);
  await firstApi.close();
  const database = new DatabaseSync(journalPath);
  database.prepare("DELETE FROM approval_artifacts WHERE quote_id=?").run(quote.quoteId);
  database.close();
  assert.throws(() => buildApi({ approvers, fetchImpl: routedFetch, journalPath }), /approval artifact/);
});

test("deposit routes bind source terms and require the receiving wallet", async () => {
  const routeResponse = await api.inject({
    method: "POST",
    url: "/v1/deposit/quote",
    payload: { account: user.address, fromChainId: 1, fromToken: "ETH", amount: "1" },
  });
  assert.equal(routeResponse.statusCode, 200, routeResponse.body);
  const route = routeResponse.json();
  const attacker = Wallet.createRandom();
  const bad = await attacker.signTypedData(route.domain, route.types, route.intent);
  assert.equal(
    (
      await api.inject({
        method: "POST",
        url: "/v1/deposit/execute",
        payload: { routeId: route.routeId, userSignature: bad },
      })
    ).statusCode,
    401,
  );
  const signature = await user.signTypedData(route.domain, route.types, route.intent);
  const unavailable = await api.inject({
    method: "POST",
    url: "/v1/deposit/execute",
    payload: { routeId: route.routeId, userSignature: signature },
  });
  assert.equal(unavailable.statusCode, 503);
});

test("an unexpired deposit authorization survives an API leader restart", async () => {
  const journalPath = join(directory, "deposit-restart.sqlite");
  const firstApi = buildApi({ journalPath });
  await firstApi.ready();
  const response = await firstApi.inject({
    method: "POST",
    url: "/v1/deposit/quote",
    payload: { account: user.address, fromChainId: 42161, fromToken: "USDC", amount: "250" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const route = response.json();
  await firstApi.close();
  const restarted = buildApi({ journalPath });
  await restarted.ready();
  const signature = await user.signTypedData(route.domain, route.types, route.intent);
  const result = await restarted.inject({
    method: "POST",
    url: "/v1/deposit/execute",
    payload: { routeId: route.routeId, userSignature: signature },
  });
  assert.equal(result.statusCode, 503, result.body);
  await restarted.close();
});

test("owner exit and cancellation actions are exactly signed before sponsorship", async () => {
  const nonce = BigInt(`0x${crypto.randomUUID().replaceAll("-", "")}`).toString();
  const withdrawal = (
    await api.inject({
      method: "POST",
      url: "/v1/withdraw/prepare",
      payload: { account: user.address, amount: "25.5", nonce },
    })
  ).json();
  assert.equal(withdrawal.intent.recipient, user.address);
  assert.equal(withdrawal.intent.amount, "25500000");
  const withdrawalSignature = await user.signTypedData(
    withdrawal.domain,
    withdrawal.types,
    withdrawal.intent,
  );
  assert.equal(
    (
      await api.inject({
        method: "POST",
        url: "/v1/withdraw/execute",
        payload: { intent: withdrawal.intent, userSignature: withdrawalSignature },
      })
    ).statusCode,
    503,
  );
  const attacker = Wallet.createRandom(),
    badWithdrawal = await attacker.signTypedData(withdrawal.domain, withdrawal.types, withdrawal.intent);
  assert.equal(
    (
      await api.inject({
        method: "POST",
        url: "/v1/withdraw/execute",
        payload: { intent: withdrawal.intent, userSignature: badWithdrawal },
      })
    ).statusCode,
    401,
  );

  const cancel = (
    await api.inject({
      method: "POST",
      url: "/v1/nonce/cancel/prepare",
      payload: { account: user.address, nonce: (BigInt(nonce) + 1n).toString() },
    })
  ).json();
  const cancelSignature = await user.signTypedData(cancel.domain, cancel.types, cancel.intent);
  assert.equal(
    (
      await api.inject({
        method: "POST",
        url: "/v1/nonce/cancel/execute",
        payload: { intent: cancel.intent, userSignature: cancelSignature },
      })
    ).statusCode,
    503,
  );

  const close = (
    await api.inject({
      method: "POST",
      url: "/v1/close/prepare",
      payload: { account: user.address, market: "BTC", nonce: (BigInt(nonce) + 2n).toString() },
    })
  ).json();
  const closeSignature = await user.signTypedData(close.domain, close.types, close.intent);
  assert.equal(
    (
      await api.inject({
        method: "POST",
        url: "/v1/close/execute",
        payload: { intent: close.intent, userSignature: closeSignature },
      })
    ).statusCode,
    503,
  );

  const session = Wallet.createRandom();
  const grantResponse = await api.inject({
    method: "POST",
    url: "/v1/session/prepare",
    payload: {
      account: user.address,
      session: session.address,
      marketMask: 3,
      maxTradeAmount: "2500",
      maxCumulativeAmount: "10000",
      maxFee: "5",
      durationSeconds: 28_800,
      nonce: (BigInt(nonce) + 3n).toString(),
    },
  });
  assert.equal(grantResponse.statusCode, 200, grantResponse.body);
  const grant = grantResponse.json();
  const grantSignature = await user.signTypedData(grant.domain, grant.types, grant.grant);
  assert.equal(
    (
      await api.inject({
        method: "POST",
        url: "/v1/session/execute",
        payload: { grant: grant.grant, userSignature: grantSignature },
      })
    ).statusCode,
    503,
  );
});

test("limit-order execution does not spend the public write budget", async () => {
  // Freeze Date so the 127.0.0.1 write bucket cannot refill between the client's writes and the
  // order executor; when executions went through the public route they were rejected with 429.
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let approverCalls = 0;
  const countingFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    approverCalls++;
    return routedFetch(input, init);
  }) as typeof fetch;
  const target = buildApi({
    approvers: apps.map((_, index) => ({ url: `http://approver-${index}`, token: `transport-${index}` })),
    fetchImpl: countingFetch,
    publicWriteBurst: 2,
  });
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
          limitPrice: "200000",
          durationSeconds: 3600,
          nonce: "556677",
        },
      })
    ).json();
    const userSignature = await user.signTypedData(prepared.domain, prepared.types, prepared.intent);
    const placed = await target.inject({
      method: "POST",
      url: "/v1/orders",
      payload: { orderId: prepared.orderId, userSignature },
    });
    assert.equal(placed.statusCode, 200, placed.body);
    const exhausted = await target.inject({ method: "POST", url: "/v1/quote", payload: {} });
    assert.equal(exhausted.statusCode, 429, "the client's write budget should be spent");
    let order: { status: string; lastError?: string } | undefined;
    for (let poll = 0; poll < 200 && !order?.lastError; poll++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order = (await target.inject({ url: `/v1/orders/${user.address}` })).json().items[0];
    }
    assert(approverCalls >= 2, `the order never reached the approvers: ${order?.lastError}`);
    assert.doesNotMatch(order?.lastError ?? "", /rate limit/);
  } finally {
    await target.close();
    mock.timers.reset();
  }
});

test("market quotes accept a bounded custom slippage and keep the 8 bps default", async () => {
  const target = buildApi();
  await target.ready();
  try {
    const quote = async (payload: Record<string, unknown>) =>
      target.inject({ method: "POST", url: "/v1/quote", payload });
    const base = { market: "BTC", side: "buy", amount: "1000" };
    const fallback = (await quote(base)).json(),
      wide = (await quote({ ...base, slippageBps: 50 })).json(),
      selling = (await quote({ ...base, side: "sell", slippageBps: 1 })).json();
    const expected = BigInt(fallback.expectedPrice);
    assert.equal(BigInt(fallback.worstPrice), expected + (expected * 8n + 9_999n) / 10_000n);
    assert.equal(
      BigInt(wide.worstPrice),
      BigInt(wide.expectedPrice) + (BigInt(wide.expectedPrice) * 50n + 9_999n) / 10_000n,
    );
    assert.equal(
      BigInt(selling.worstPrice),
      BigInt(selling.expectedPrice) - (BigInt(selling.expectedPrice) + 9_999n) / 10_000n,
    );
    for (const slippageBps of [0, 501, 1.5])
      assert.equal((await quote({ ...base, slippageBps })).statusCode, 400, String(slippageBps));
  } finally {
    await target.close();
  }
});

test("config and market snapshots expose per-market margin multipliers and leverage", async () => {
  const target = buildApi();
  await target.ready();
  try {
    const config = (await target.inject("/v1/config")).json();
    assert.deepEqual(config.markets.BTC, {
      marginScaleBps: 10_000,
      maxLeverage: 5,
      initialMarginBps: 2_000,
      maintenanceMarginBps: 1_200,
    });
    assert.equal(config.marginTiers[0].maxNotional, "25000000000");
    assert.equal(config.marginTiers.at(-1).maxNotional, null);
    const markets = (await target.inject("/v1/markets")).json();
    assert.equal(markets.markets.ETH.marginScaleBps, 10_000);
    assert.equal(markets.markets.ETH.maxLeverage, 5);
  } finally {
    await target.close();
  }
});

/** An API whose oracle mid the test moves; `tick` notifies subscribers as a live feed would. */
function triggerApi(options: { journalPath?: string; approverFetch?: typeof fetch } = {}) {
  const prices: Record<string, bigint> = { BTC: 100_000n * 1_000_000n, ETH: 4_000n * 1_000_000n },
    listeners: Array<(market: string) => void> = [];
  const observation = (market: string) => {
    const now = Math.floor(Date.now() / 1_000),
      price = prices[market];
    return {
      snapshot: { market, bid: price, ask: price, observedAtMs: Date.now() },
      report: AbiCoder.defaultAbiCoder().encode(
        ["tuple(uint8 market,uint256 bid,uint256 ask,uint64 observedAt,uint64 validUntil)[]"],
        [[[market === "BTC" ? 0 : 1, price, price, now, now + 15]]],
      ),
      validUntil: now + 15,
    };
  };
  const app = buildApi({
    journalPath: options.journalPath,
    approvers: apps.map((_, index) => ({ url: `http://approver-${index}`, token: `transport-${index}` })),
    fetchImpl: options.approverFetch ?? routedFetch,
    oracleSource: {
      latest: async (market) => observation(market),
      subscribe: (listener: (market: string) => void) => {
        listeners.push(listener);
        return () => {};
      },
    },
  });
  return {
    app,
    prices,
    tick: () => {
      for (const listener of listeners) listener("BTC");
    },
  };
}

async function placeTrigger(
  target: ReturnType<typeof buildApi>,
  payload: Record<string, unknown>,
  signer = user,
) {
  const prepared = await target.inject({ method: "POST", url: "/v1/orders/trigger/prepare", payload });
  assert.equal(prepared.statusCode, 200, prepared.body);
  const body = prepared.json(),
    userSignature = await signer.signTypedData(body.domain, body.types, body.intent),
    placed = await target.inject({
      method: "POST",
      url: "/v1/orders",
      payload: { orderId: body.orderId, userSignature },
    });
  assert.equal(placed.statusCode, 200, placed.body);
  return body;
}

test("trigger orders sign a TriggeredTradeIntent with a slippage-bounded limit and validate their kind", async () => {
  const { app: target } = triggerApi();
  await target.ready();
  try {
    const base = {
      account: user.address,
      market: "BTC",
      amount: "950",
      durationSeconds: 3600,
      nonce: "424242",
    };
    const prepare = (payload: Record<string, unknown>) =>
      target.inject({ method: "POST", url: "/v1/orders/trigger/prepare", payload: { ...base, ...payload } });
    const stop = await prepare({ kind: "stop-loss", side: "sell", triggerPrice: "95000", slippageBps: 200 });
    assert.equal(stop.statusCode, 200, stop.body);
    const prepared = stop.json();
    assert.equal(prepared.type, "stop-loss");
    assert.deepEqual(Object.keys(prepared.types), ["TriggeredTradeIntent"]);
    assert.equal(prepared.intent.triggerPrice, "95000000000");
    assert.equal(prepared.intent.triggerAbove, false);
    assert.equal(prepared.intent.reduceOnly, true);
    assert.equal(prepared.intent.baseDelta, "-10000000000000000");
    // 95,000 less 2%. A sell has no upper price bound, so the fee cap is 2 bps of the notional at twice
    // the trigger, enough for a take-profit that gaps far through its trigger to still fill.
    assert.equal(prepared.intent.limitPrice, "93100000000");
    assert.equal(prepared.intent.maxFee, "380000");
    assert.deepEqual(prepared.trigger, { triggerPrice: "95000000000", triggerAbove: false });

    const entry = (
      await prepare({ kind: "stop-entry", side: "buy", triggerPrice: "101000", nonce: "424243" })
    ).json();
    assert.equal(entry.intent.triggerAbove, true);
    assert.equal(entry.intent.reduceOnly, false);
    assert.equal(entry.intent.limitPrice, "102010000000");
    const profit = (
      await prepare({ kind: "take-profit", side: "sell", triggerPrice: "110000", nonce: "424244" })
    ).json();
    assert.equal(profit.intent.triggerAbove, true);

    const rejected: Array<[Record<string, unknown>, number]> = [
      [{ kind: "stop-loss", side: "sell", triggerPrice: "100500" }, 409], // already reached
      [{ kind: "stop-entry", side: "buy", triggerPrice: "99000" }, 409],
      [{ kind: "stop-loss", side: "sell", triggerPrice: "95000", triggerAbove: true }, 400],
      [{ kind: "stop-loss", side: "sell", triggerPrice: "95000", reduceOnly: false }, 400],
      [{ kind: "stop-loss", triggerPrice: "95000" }, 400], // amount sizing needs a side
      [{ kind: "stop-loss", sizing: "position", triggerPrice: "95000" }, 503], // needs the chain
      [{ kind: "stop-loss", side: "sell", triggerPrice: "95000", slippageBps: 501 }, 400],
      [{ kind: "trailing", side: "sell", triggerPrice: "95000" }, 400],
    ];
    for (const [payload, status] of rejected)
      assert.equal((await prepare(payload)).statusCode, status, JSON.stringify(payload));
    const pair = await target.inject({
      method: "POST",
      url: "/v1/orders/tpsl/prepare",
      payload: { ...base, takeProfitPrice: "110000", stopLossPrice: "95000" },
    });
    assert.equal(pair.statusCode, 503, pair.body);

    // A plain TradeIntent signature over the same fields does not place a triggered order.
    const { triggerPrice: _price, triggerAbove: _above, ...plain } = prepared.intent;
    const wrong = await user.signTypedData(
      prepared.domain,
      { TradeIntent: prepared.types.TriggeredTradeIntent.slice(0, 8) },
      plain,
    );
    assert.equal(
      (
        await target.inject({
          method: "POST",
          url: "/v1/orders",
          payload: { orderId: prepared.orderId, userSignature: wrong },
        })
      ).statusCode,
      401,
    );
  } finally {
    await target.close();
  }
});

test("an armed stop-loss fires through the approvers once the oracle mid crosses its trigger", async () => {
  const triggered: Array<{ status: number; triggerPrice?: string }> = [];
  const approverFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await routedFetch(input, init),
      payload = JSON.parse(String(init?.body ?? "{}"));
    triggered.push({ status: response.status, triggerPrice: payload.trigger?.triggerPrice });
    return response;
  }) as typeof fetch;
  const { app: target, prices, tick } = triggerApi({ approverFetch });
  await target.ready();
  try {
    const signer = Wallet.createRandom();
    const order = await placeTrigger(
      target,
      {
        account: signer.address,
        market: "BTC",
        kind: "stop-loss",
        side: "sell",
        amount: "950",
        triggerPrice: "95000",
        slippageBps: 100,
        durationSeconds: 3600,
        nonce: "777001",
      },
      signer,
    );
    const list = async () => (await target.inject(`/v1/orders/${signer.address}`)).json().items;
    const [armed] = await list();
    assert.equal(armed.type, "stop-loss");
    assert.equal(armed.triggerPrice, "95000000000");
    assert.equal(armed.triggerAbove, false);
    assert.equal(armed.reduceOnly, true);
    assert.equal(armed.status, "open");
    tick();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(triggered.length, 0, "an unreached trigger must not reach the approvers");

    prices.BTC = 94_900n * 1_000_000n;
    tick();
    let current = armed;
    for (let poll = 0; poll < 300 && !current.lastError && current.status === "open"; poll++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      [current] = await list();
    }
    const signed = triggered.filter((item) => item.status === 200);
    assert(signed.length >= 2, JSON.stringify({ triggered, current }));
    assert(signed.every((item) => item.triggerPrice === "95000000000"));
    assert.equal(current.orderId, order.orderId);
  } finally {
    await target.close();
  }
});

test("a stop that gaps past its slippage limit waits, says why, and fires once the price is back in its band", async () => {
  let approverCalls = 0;
  const approverFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    approverCalls++;
    return routedFetch(input, init);
  }) as typeof fetch;
  const { app: target, prices, tick } = triggerApi({ approverFetch });
  await target.ready();
  try {
    const signer = Wallet.createRandom();
    const base = {
      account: signer.address,
      market: "BTC",
      kind: "stop-loss",
      side: "sell",
      amount: "950",
      slippageBps: 100,
      durationSeconds: 3600,
    };
    const reached = await target.inject({
      method: "POST",
      url: "/v1/orders/trigger/prepare",
      payload: { ...base, triggerPrice: "100500", nonce: "777100" },
    });
    assert.equal(reached.statusCode, 409);
    assert.equal(reached.json().error, "stop-loss price must be below the current price");

    await placeTrigger(target, { ...base, triggerPrice: "95000", nonce: "777101" }, signer);
    const list = async () => (await target.inject(`/v1/orders/${signer.address}`)).json().items;
    // 90,000 is through the 95,000 trigger but below the 94,050 limit (1% slippage): no fill, a reason.
    prices.BTC = 90_000n * 1_000_000n;
    tick();
    let [current] = await list();
    for (let poll = 0; poll < 300 && !current.lastError; poll++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      [current] = await list();
    }
    assert.equal(current.status, "open");
    assert.match(current.lastError, /within the slippage limit/);
    assert.equal(approverCalls, 0, "a fill worse than the signed limit must not reach the approvers");

    prices.BTC = 94_500n * 1_000_000n;
    tick();
    for (let poll = 0; poll < 300 && approverCalls === 0; poll++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert(approverCalls > 0, "back inside the band, the stop fires");
  } finally {
    await target.close();
  }
});

test("an armed trigger order survives API restart with its type and trigger", async () => {
  const journalPath = join(directory, "trigger-restart.sqlite"),
    first = triggerApi({ journalPath });
  await first.app.ready();
  const signer = Wallet.createRandom();
  const prepared = await placeTrigger(
    first.app,
    {
      account: signer.address,
      market: "ETH",
      kind: "stop-entry",
      side: "buy",
      amount: "500",
      triggerPrice: "4200",
      durationSeconds: 3600,
      nonce: "880001",
    },
    signer,
  );
  await first.app.close();
  const restarted = triggerApi({ journalPath });
  await restarted.app.ready();
  try {
    const items = (await restarted.app.inject(`/v1/orders/${signer.address}`)).json().items;
    assert.equal(items.length, 1);
    assert.equal(items[0].orderId, prepared.orderId);
    assert.equal(items[0].type, "stop-entry");
    assert.equal(items[0].triggerPrice, "4200000000");
    assert.equal(items[0].triggerAbove, true);
    assert.equal(items[0].status, "open");
  } finally {
    await restarted.app.close();
  }
});
