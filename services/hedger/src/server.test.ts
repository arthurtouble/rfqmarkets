import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHedger,
  loadHedgeCoins,
  type HedgeMarket,
  type HedgeVenue,
  type VenueOrder,
  type VenueResult,
} from "./server.js";

const TOKEN = "hedge-test-token",
  AUTH = { authorization: `Bearer ${TOKEN}` };

test("hedges finalized aggregate exposure once with a stable client order id", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-hedger-"));
  const payload = {
    blockNumber: 50,
    markets: {
      BTC: { aggregateBase: "1000000000000000000", bid: "99990000000", ask: "100010000000" },
      ETH: { aggregateBase: "0", bid: "0", ask: "0" },
    },
  };
  const fetchImpl = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const hedge = buildHedger({
    healthToken: TOKEN,
    indexerUrl: "http://indexer",
    databasePath: join(directory, "hedge.sqlite"),
    fetchImpl,
    pollMs: 60_000,
  });
  await hedge.ready();
  const first = (await hedge.inject({ method: "GET", url: "/v1/status", headers: AUTH })).json();
  assert.equal(first.orders.length, 1);
  assert.equal(first.orders[0].status, "filled");
  assert.equal(first.positions.BTC, "250000000000000000");
  assert(first.observedAtMs > 0);
  await hedge.inject({ method: "POST", url: "/v1/tick", headers: AUTH });
  const second = (await hedge.inject({ method: "GET", url: "/v1/status", headers: AUTH })).json();
  assert.equal(second.orders.length, 2);
  assert.equal(second.positions.BTC, "500000000000000000");
  await hedge.close();
  const restarted = buildHedger({
    healthToken: TOKEN,
    indexerUrl: "http://indexer",
    databasePath: join(directory, "hedge.sqlite"),
    fetchImpl,
    pollMs: 60_000,
  });
  await restarted.ready();
  const recovered = (await restarted.inject({ method: "GET", url: "/v1/status", headers: AUTH })).json();
  assert.equal(recovered.orders.length, 3);
  assert.equal(recovered.positions.BTC, "750000000000000000");
  await restarted.inject({ method: "POST", url: "/v1/tick", headers: AUTH });
  const stable = (await restarted.inject({ method: "GET", url: "/v1/status", headers: AUTH })).json();
  assert.equal(stable.orders.length, 3);
  assert.equal(stable.positions.BTC, recovered.positions.BTC);
  await restarted.close();
  rmSync(directory, { recursive: true, force: true });
});

test("reconciles a lost partial-fill acknowledgement before submitting another slice", async () => {
  class PartialVenue implements HedgeVenue {
    readonly mode = "fault-injection";
    positions: Record<HedgeMarket, bigint> = { BTC: 0n, ETH: 0n };
    orders = new Map<string, VenueResult>();
    submissions = 0;
    lose = true;
    async position(market: HedgeMarket) {
      return this.positions[market];
    }
    async find(id: string) {
      return this.orders.get(id) ?? null;
    }
    async submit(order: VenueOrder) {
      this.submissions++;
      const filled = order.baseDelta / 2n,
        result: VenueResult = {
          venueOrderId: `venue-${this.submissions}`,
          status: "partial",
          filledBase: filled,
        };
      this.orders.set(order.clientId, result);
      this.positions[order.market] += filled;
      if (this.lose) {
        this.lose = false;
        throw new Error("acknowledgement lost");
      }
      return result;
    }
  }
  const directory = mkdtempSync(join(tmpdir(), "rfq-partial-")),
    venue = new PartialVenue(),
    payload = {
      blockNumber: 70,
      markets: {
        BTC: { aggregateBase: "1000000000000000000", bid: "99990000000", ask: "100010000000" },
        ETH: { aggregateBase: "0", bid: "0", ask: "0" },
      },
    },
    fetchImpl = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
  const hedge = buildHedger({
    healthToken: TOKEN,
    indexerUrl: "http://indexer",
    databasePath: join(directory, "hedge.sqlite"),
    fetchImpl,
    pollMs: 60_000,
    venue,
  });
  await hedge.ready();
  let status = (await hedge.inject({ method: "GET", url: "/v1/status", headers: AUTH })).json();
  assert.equal(status.healthy, false);
  assert.equal(venue.submissions, 1);
  await hedge.inject({ method: "POST", url: "/v1/tick", headers: AUTH });
  status = (await hedge.inject({ method: "GET", url: "/v1/status", headers: AUTH })).json();
  assert.equal(status.healthy, true);
  assert.equal(
    status.orders.some((order: { status: string }) => order.status === "partial"),
    true,
  );
  assert.equal(venue.submissions, 2, "lost acknowledgement caused duplicate submission");
  assert(BigInt(status.positions.BTC) > 0n);
  await hedge.close();
  rmSync(directory, { recursive: true, force: true });
});

test("does not stack hedge slices while a venue order remains open", async () => {
  class OpenVenue implements HedgeVenue {
    readonly mode = "open-order-test";
    submissions = 0;
    orders = new Map<string, VenueResult>();
    async position() {
      return 0n;
    }
    async find(id: string) {
      return this.orders.get(id) ?? null;
    }
    async submit(order: VenueOrder) {
      this.submissions++;
      const result: VenueResult = {
        venueOrderId: `open-${this.submissions}`,
        status: "open",
        filledBase: 0n,
      };
      this.orders.set(order.clientId, result);
      return result;
    }
  }
  const directory = mkdtempSync(join(tmpdir(), "rfq-open-")),
    venue = new OpenVenue(),
    payload = {
      blockNumber: 80,
      markets: {
        BTC: { aggregateBase: "1000000000000000000", bid: "99990000000", ask: "100010000000" },
        ETH: { aggregateBase: "0", bid: "0", ask: "0" },
      },
    },
    fetchImpl = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
  const hedge = buildHedger({
    healthToken: TOKEN,
    indexerUrl: "http://indexer",
    databasePath: join(directory, "hedge.sqlite"),
    fetchImpl,
    pollMs: 60_000,
    venue,
  });
  await hedge.ready();
  await hedge.inject({ method: "POST", url: "/v1/tick", headers: AUTH });
  await hedge.inject({ method: "POST", url: "/v1/tick", headers: AUTH });
  const status = (await hedge.inject({ method: "GET", url: "/v1/status", headers: AUTH })).json();
  assert.equal(status.orders.length, 1);
  assert.equal(status.orders[0].status, "open");
  assert.equal(venue.submissions, 1);
  await hedge.close();
  rmSync(directory, { recursive: true, force: true });
});

test("venue rejection is journaled with its reason and fails quote admission closed", async () => {
  class RejectingVenue implements HedgeVenue {
    readonly mode = "rejecting-test";
    async position() {
      return 0n;
    }
    async find() {
      return null;
    }
    async submit(): Promise<VenueResult> {
      return {
        venueOrderId: "rejected-1",
        status: "rejected",
        filledBase: 0n,
        reason: "insufficient margin",
      };
    }
  }
  const directory = mkdtempSync(join(tmpdir(), "rfq-rejected-")),
    payload = {
      blockNumber: 81,
      markets: {
        BTC: { aggregateBase: "1000000000000000000", bid: "99990000000", ask: "100010000000" },
        ETH: { aggregateBase: "0", bid: "0", ask: "0" },
      },
    },
    fetchImpl = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  const hedge = buildHedger({
    indexerUrl: "http://indexer",
    databasePath: join(directory, "hedge.sqlite"),
    fetchImpl,
    pollMs: 60_000,
    venue: new RejectingVenue(),
    healthToken: "risk-secret",
  });
  await hedge.ready();
  assert.equal((await hedge.inject({ method: "GET", url: "/v1/status" })).statusCode, 401);
  assert.equal((await hedge.inject({ method: "POST", url: "/v1/tick" })).statusCode, 401);
  const status = (
      await hedge.inject({
        method: "GET",
        url: "/v1/status",
        headers: { authorization: "Bearer risk-secret" },
      })
    ).json(),
    risk = (
      await hedge.inject({
        method: "GET",
        url: "/internal/risk",
        headers: { authorization: "Bearer risk-secret" },
      })
    ).json();
  assert.equal(status.healthy, false);
  assert.match(status.error, /insufficient margin/);
  assert.equal(status.orders[0].status, "rejected");
  assert.equal(status.orders[0].reason, "insufficient margin");
  assert.equal(risk.markets.BTC.mode, "reduce_only");
  await hedge.close();
  rmSync(directory, { recursive: true, force: true });
});

test("market-depth telemetry outage blocks new quote risk without blocking hedging", async () => {
  class BlindVenue implements HedgeVenue {
    readonly mode = "blind-book-test";
    positionBase = 0n;
    orders = new Map<string, VenueResult>();
    async position() {
      return this.positionBase;
    }
    async find(id: string) {
      return this.orders.get(id) ?? null;
    }
    async execution(): Promise<never> {
      throw new Error("book unavailable");
    }
    async submit(order: VenueOrder) {
      this.positionBase += order.baseDelta;
      const result: VenueResult = { venueOrderId: "hedged", status: "filled", filledBase: order.baseDelta };
      this.orders.set(order.clientId, result);
      return result;
    }
  }
  const directory = mkdtempSync(join(tmpdir(), "rfq-blind-book-")),
    venue = new BlindVenue(),
    payload = {
      blockNumber: 82,
      markets: {
        BTC: { aggregateBase: "1000000000000000000", bid: "99990000000", ask: "100010000000" },
        ETH: { aggregateBase: "0", bid: "0", ask: "0" },
      },
    },
    fetchImpl = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  const hedge = buildHedger({
    indexerUrl: "http://indexer",
    databasePath: join(directory, "hedge.sqlite"),
    fetchImpl,
    pollMs: 60_000,
    venue,
    healthToken: "secret",
  });
  await hedge.ready();
  const status = (
      await hedge.inject({ method: "GET", url: "/v1/status", headers: { authorization: "Bearer secret" } })
    ).json(),
    risk = (
      await hedge.inject({
        method: "GET",
        url: "/internal/risk",
        headers: { authorization: "Bearer secret" },
      })
    ).json();
  assert(BigInt(status.positions.BTC) > 0n, "hedging stopped behind market-data telemetry");
  assert.equal(risk.markets.BTC.mode, "reduce_only");
  await hedge.close();
  rmSync(directory, { recursive: true, force: true });
});

test("flattens venue exposure instead of leaving residual below its minimum order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-hedge-dust-")),
    payload = {
      blockNumber: 82,
      markets: {
        BTC: { aggregateBase: "110000000000000", bid: "99990000000", ask: "100010000000" },
        ETH: { aggregateBase: "0", bid: "0", ask: "0" },
      },
    },
    fetchImpl = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  const hedge = buildHedger({
    healthToken: TOKEN,
    indexerUrl: "http://indexer",
    databasePath: join(directory, "hedge.sqlite"),
    fetchImpl,
    pollMs: 60_000,
    bandUsdc: 1_000_000n,
    maxOrderUsdc: 25_000_000n,
    minOrderUsdc: 10_000_000n,
  });
  await hedge.ready();
  let status = (await hedge.inject({ method: "GET", url: "/v1/status", headers: AUTH })).json();
  assert(BigInt(status.positions.BTC) > 0n, "opening hedge was not submitted");
  payload.blockNumber++;
  payload.markets.BTC.aggregateBase = "0";
  await hedge.inject({ method: "POST", url: "/v1/tick", headers: AUTH });
  status = (await hedge.inject({ method: "GET", url: "/v1/status", headers: AUTH })).json();
  assert.equal(status.positions.BTC, "0");
  assert.equal(status.orders.length, 2);
  await hedge.close();
  rmSync(directory, { recursive: true, force: true });
});

test("does not halt quoting for exposure smaller than the venue minimum order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-minimum-risk-")),
    payload = {
      blockNumber: 83,
      markets: {
        BTC: { aggregateBase: "50000000000000", bid: "99990000000", ask: "100010000000" },
        ETH: { aggregateBase: "0", bid: "0", ask: "0" },
      },
    },
    fetchImpl = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  const app = buildHedger({
    indexerUrl: "http://indexer",
    databasePath: join(directory, "min-risk.sqlite"),
    fetchImpl,
    bandUsdc: 1_000_000n,
    minOrderUsdc: 10_000_000n,
    healthToken: "secret",
    pollMs: 60_000,
  });
  await app.ready();
  const risk = (
    await app.inject({ method: "GET", url: "/internal/risk", headers: { authorization: "Bearer secret" } })
  ).json();
  assert.equal(risk.markets.BTC.mode, "normal");
  assert.equal(risk.markets.BTC.bandUsdc, "1000000");
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

test("protected risk endpoint reports normal, guarded and reduce-only operating modes", async () => {
  for (const [name, aggregateBase, expected] of [
    ["normal", "300000000000000000", "normal"],
    ["guarded", "650000000000000000", "guarded"],
    ["reduce", "1000000000000000000", "reduce_only"],
  ] as const) {
    const directory = mkdtempSync(join(tmpdir(), `rfq-risk-${name}-`)),
      payload = {
        blockNumber: 90,
        markets: {
          BTC: { aggregateBase, bid: "99990000000", ask: "100010000000" },
          ETH: { aggregateBase: "0", bid: "0", ask: "0" },
        },
      },
      fetchImpl = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
    const hedge = buildHedger({
      indexerUrl: "http://indexer",
      databasePath: join(directory, "hedge.sqlite"),
      fetchImpl,
      pollMs: 60_000,
      healthToken: "risk-secret",
    });
    await hedge.ready();
    assert.equal((await hedge.inject({ method: "GET", url: "/internal/risk" })).statusCode, 401);
    const response = await hedge.inject({
      method: "GET",
      url: "/internal/risk",
      headers: { authorization: "Bearer risk-secret" },
    });
    assert.equal(response.statusCode, 200, response.body);
    const risk = response.json();
    assert.equal(risk.healthy, true);
    assert.equal(risk.indexedBlock, 90);
    assert.equal(risk.markets.BTC.mode, expected);
    await hedge.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("risk endpoint fails closed when finalized exposure cannot be read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-risk-failure-")),
    fetchImpl = (async () => new Response("offline", { status: 503 })) as typeof fetch,
    hedge = buildHedger({
      indexerUrl: "http://indexer",
      databasePath: join(directory, "hedge.sqlite"),
      fetchImpl,
      pollMs: 60_000,
      healthToken: "risk-secret",
    });
  await hedge.ready();
  const risk = (
    await hedge.inject({
      method: "GET",
      url: "/internal/risk",
      headers: { authorization: "Bearer risk-secret" },
    })
  ).json();
  assert.equal(risk.healthy, false);
  assert.equal(risk.markets.BTC.mode, "reduce_only");
  await hedge.close();
  rmSync(directory, { recursive: true, force: true });
});

test("a recent finalized snapshot survives a transient indexer failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-risk-hysteresis-"));
  let online = true;
  const payload = {
      blockNumber: 91,
      markets: {
        BTC: { aggregateBase: "0", bid: "99990000000", ask: "100010000000" },
        ETH: { aggregateBase: "0", bid: "0", ask: "0" },
      },
    },
    fetchImpl = (async () =>
      online
        ? new Response(JSON.stringify(payload), { status: 200 })
        : new Response("offline", { status: 503 })) as typeof fetch;
  const hedge = buildHedger({
    indexerUrl: "http://indexer",
    databasePath: join(directory, "hedge.sqlite"),
    fetchImpl,
    pollMs: 60_000,
    healthToken: "risk-secret",
    riskStaleMs: 10_000,
  });
  await hedge.ready();
  online = false;
  await hedge.inject({ method: "POST", url: "/v1/tick", headers: { authorization: "Bearer risk-secret" } });
  const risk = (
    await hedge.inject({
      method: "GET",
      url: "/internal/risk",
      headers: { authorization: "Bearer risk-secret" },
    })
  ).json();
  assert.equal(risk.healthy, true);
  assert.equal(risk.indexedBlock, 91);
  assert.match((await hedge.inject({ method: "GET", url: "/health" })).json().error, /indexer unavailable/);
  await hedge.close();
  rmSync(directory, { recursive: true, force: true });
});

test("operations endpoints always require the token and CORS follows configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-hedger-auth-")),
    fetchImpl = (async () => new Response("offline", { status: 503 })) as typeof fetch;
  assert.throws(
    () => buildHedger({ indexerUrl: "http://indexer", databasePath: ":memory:", healthToken: "" }),
    /operations token/,
  );
  const hedge = buildHedger({
    indexerUrl: "http://indexer",
    databasePath: join(directory, "hedge.sqlite"),
    fetchImpl,
    pollMs: 60_000,
    healthToken: TOKEN,
    corsOrigin: ["https://ops.example", "https://backup.example"],
  });
  try {
    await hedge.ready();
    for (const [method, url] of [
      ["GET", "/v1/status"],
      ["GET", "/v1/status/stream"],
      ["POST", "/v1/tick"],
      ["GET", "/internal/risk"],
    ] as const) {
      assert.equal((await hedge.inject({ method, url })).statusCode, 401, url);
      assert.equal(
        (await hedge.inject({ method, url, headers: { authorization: "Bearer wrong" } })).statusCode,
        401,
        url,
      );
    }
    const allowed = await hedge.inject({
      method: "GET",
      url: "/v1/status",
      headers: { ...AUTH, origin: "https://backup.example" },
    });
    assert.equal(allowed.headers["access-control-allow-origin"], "https://backup.example");
    const local = await hedge.inject({
      method: "GET",
      url: "/v1/status",
      headers: { ...AUTH, origin: "http://127.0.0.1:4174" },
    });
    assert.equal(local.headers["access-control-allow-origin"], undefined);
  } finally {
    await hedge.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a malformed exposure response is rejected before it can size a hedge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-hedger-malformed-")),
    payload = {
      blockNumber: 70,
      markets: { BTC: { aggregateBase: "1e18", bid: "99990000000", ask: "100010000000" } },
    },
    fetchImpl = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
  const hedge = buildHedger({
    indexerUrl: "http://indexer",
    databasePath: join(directory, "hedge.sqlite"),
    fetchImpl,
    pollMs: 60_000,
    healthToken: TOKEN,
  });
  try {
    await hedge.ready();
    const status = (await hedge.inject({ method: "GET", url: "/v1/status", headers: AUTH })).json();
    assert.equal(status.healthy, false);
    assert.match(status.error, /indexer unavailable/);
    assert.equal(status.orders.length, 0);
  } finally {
    await hedge.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hedges through the venue coin map and keeps an unmapped market reduce-only without orders", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rfq-hedger-coins-")),
    submitted: VenueOrder[] = [],
    logged: string[] = [];
  const venue: HedgeVenue = {
    mode: "coin-map",
    position: async () => 0n,
    find: async () => null,
    submit: async (order) => {
      submitted.push(order);
      return { venueOrderId: "venue-1", status: "filled", filledBase: order.baseDelta };
    },
  };
  const payload = {
      blockNumber: 90,
      markets: {
        BTC: { aggregateBase: "1000000000000000000", bid: "99990000000", ask: "100010000000" },
        ETH: { aggregateBase: "0", bid: "4000000000", ask: "4000000000" },
        // Added by governance: customers already hold 2,000 SOL but no venue coin is configured.
        SOL: { aggregateBase: "2000000000000000000000", bid: "150000000", ask: "150000000" },
      },
    },
    fetchImpl = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
  const hedge = buildHedger({
    healthToken: TOKEN,
    indexerUrl: "http://indexer",
    databasePath: join(directory, "hedge.sqlite"),
    fetchImpl,
    pollMs: 60_000,
    venue,
    hedgeCoins: { BTC: "BTC-PERP", ETH: "ETH" },
    log: (message) => logged.push(message),
  });
  try {
    await hedge.ready();
    await hedge.inject({ method: "POST", url: "/v1/tick", headers: AUTH });
    assert.deepEqual(
      submitted.map((order) => order.market),
      ["BTC-PERP"],
      "BTC is hedged under its venue coin and SOL is never sent to the venue",
    );
    const risk = (await hedge.inject({ method: "GET", url: "/internal/risk", headers: AUTH })).json();
    assert.equal(risk.healthy, true, "an unmapped market does not make the hedger unhealthy");
    assert.equal(risk.markets.SOL.mode, "reduce_only");
    assert.equal(risk.markets.SOL.reason, "no_hedge_mapping");
    assert.notEqual(risk.markets.BTC.mode, undefined);
    const status = (await hedge.inject({ method: "GET", url: "/v1/status", headers: AUTH })).json();
    assert.equal(status.markets.SOL.state, "unhedged");
    assert.equal(status.markets.BTC.coin, "BTC-PERP");
    // The dashboard shows the same trading mode the API enforces.
    for (const market of ["BTC", "ETH", "SOL"])
      assert.equal(status.markets[market].tradingMode, risk.markets[market].mode, market);
    assert.equal(logged.length, 1, "the missing mapping is logged once");
    assert.match(logged[0], /SOL has no hedge venue mapping/);
  } finally {
    await hedge.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the default hedge coin map is data", () => {
  const coins = loadHedgeCoins();
  assert.equal(coins.BTC, "BTC");
  assert.equal(coins.ETH, "ETH");
});
