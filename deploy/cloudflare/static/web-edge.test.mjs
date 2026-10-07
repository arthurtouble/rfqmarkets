import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SECURITY_HEADERS, handleRequest, serviceForPath } from "./web-edge.mjs";
const limiter = { limit: async () => ({ success: true }) },
  edge = {
    PUBLIC_READ_LIMIT: limiter,
    PUBLIC_WRITE_LIMIT: limiter,
    GLOBAL_READ_LIMIT: limiter,
    GLOBAL_WRITE_LIMIT: limiter,
  },
  request = (url, init = {}, cf = { country: "FR" }) =>
    Object.assign(
      new Request(url, { ...init, headers: { "cf-connecting-ip": "192.0.2.1", ...(init.headers ?? {}) } }),
      { cf },
    );

test("routes public reads to the indexer and market streams to the gateway", () => {
  assert.equal(serviceForPath("/v1/risk"), "INDEXER");
  assert.equal(serviceForPath("/v1/positions"), "INDEXER");
  assert.equal(serviceForPath("/v1/activity"), "INDEXER");
  assert.equal(serviceForPath("/v1/updates/stream"), "INDEXER");
  assert.equal(serviceForPath("/health"), "INDEXER");
  assert.equal(serviceForPath("/v1/markets/stream"), "MARKET_GATEWAY");
  assert.equal(serviceForPath("/v1/markets/history?market=BTC"), "MARKET_GATEWAY");
  assert.equal(serviceForPath("/v1/candles?market=BTC&interval=1h"), "MARKET_GATEWAY");
  assert.equal(serviceForPath("/v1/markets/stats"), "MARKET_GATEWAY");
  const account = "0x" + "ab".repeat(20);
  assert.equal(serviceForPath(`/v1/portfolio/${account}`), "INDEXER");
  assert.equal(serviceForPath(`/v1/portfolio/${account}/history`), "INDEXER");
  assert.equal(serviceForPath(`/v1/portfolio/${account}/trades`), "INDEXER");
  assert.equal(serviceForPath(`/v1/funding/${account}`), "INDEXER");
  assert.equal(serviceForPath(`/v1/portfolio/${account}/other`), null);
  assert.equal(serviceForPath("/v1/portfolio/0x12"), null);
  assert.equal(serviceForPath(`/v1/funding/${account}`, "POST"), null);
  assert.equal(serviceForPath("/v1/leaderboard?window=7d"), "INDEXER");
  assert.equal(serviceForPath(`/v1/points/${account}`), "INDEXER");
  assert.equal(serviceForPath("/v1/points/0x12"), null);
  assert.equal(serviceForPath("/v1/leaderboard", "POST"), null);
  assert.equal(serviceForPath("/v1/referrals", "POST"), "INDEXER");
  assert.equal(serviceForPath("/v1/referrals", "GET"), null);
  assert.equal(serviceForPath(`/v1/referrals/${account}`), "INDEXER");
  assert.equal(serviceForPath(`/v1/referrals/${account}`, "POST"), null);
  assert.equal(serviceForPath(`/v1/fees/${account}`), "INDEXER");
  assert.equal(serviceForPath(`/v1/fees/${account}`, "POST"), null);
  assert.equal(serviceForPath("/v1/quote"), "API");
  assert.equal(serviceForPath("/v1/quote/ladder", "GET"), "API");
  assert.equal(serviceForPath("/v1/quote/ladder", "POST"), null);
  for (const path of [
    "/v1/orders/prepare",
    "/v1/orders/trigger/prepare",
    "/v1/orders/tpsl/prepare",
    "/v1/close/all/quote",
    "/v1/isolated/margin/prepare",
    "/v1/isolated/margin/execute",
  ]) {
    assert.equal(serviceForPath(path, "POST"), "API", path);
    assert.equal(serviceForPath(path, "GET"), null, path);
  }
  assert.equal(serviceForPath("/v1/orders/trigger", "POST"), null);
  assert.equal(serviceForPath("/v1/isolated/margin", "POST"), null);
  assert.equal(serviceForPath("/v1/orders/tpslprepare", "POST"), null);
  assert.equal(serviceForPath("/markets"), null);
});

test("fails closed with machine-readable 503 when a runtime binding is absent", async () => {
  const response = await handleRequest(request("https://example.test/v1/quote", { method: "POST" }), {
    ...edge,
    ASSETS: { fetch: () => new Response("asset") },
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal((await response.json()).service, "api");
});

test("forwards methods, bodies, and request correlation to a private service", async () => {
  let received;
  const response = await handleRequest(
    request("https://example.test/v1/quote", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-ray": "ray-123" },
      body: JSON.stringify({ market: "BTC" }),
    }),
    {
      ...edge,
      API: {
        fetch: async (request) => {
          received = request;
          return new Response("ok", { status: 201 });
        },
      },
      ASSETS: { fetch: () => new Response("asset") },
    },
  );
  assert.equal(response.status, 201);
  assert.equal(received.method, "POST");
  assert.equal(received.headers.get("x-request-id"), "ray-123");
  assert.deepEqual(await received.json(), { market: "BTC" });
});

test("contains upstream failures and still serves non-service assets", async () => {
  const failed = await handleRequest(request("https://example.test/v1/risk"), {
    ...edge,
    INDEXER: {
      fetch: async () => {
        throw new Error("offline");
      },
    },
    ASSETS: { fetch: () => new Response("asset") },
  });
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error, "upstream_unavailable");

  const asset = await handleRequest(new Request("https://example.test/markets"), {
    ASSETS: { fetch: () => new Response("terminal") },
  });
  assert.equal(await asset.text(), "terminal");
});

test("asset responses carry the app's security headers, the same as apps/web/public/_headers", async () => {
  const asset = await handleRequest(new Request("https://example.test/portfolio"), {
    ASSETS: {
      fetch: () =>
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html", "cache-control": "public, max-age=0" },
        }),
    },
  });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "<html></html>");
  assert.equal(asset.headers.get("content-type"), "text/html");
  assert.equal(asset.headers.get("cache-control"), "public, max-age=0");
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    assert.equal(asset.headers.get(name), value, name);
  // The worker's copy must match the Pages-style _headers file the app ships.
  const shipped = {};
  const block = readFileSync(new URL("../../../apps/web/public/_headers", import.meta.url), "utf8")
    .split(/\n\s*\n/)
    .find((section) => section.trimStart().startsWith("/*\n"));
  for (const line of block.split("\n").slice(1)) {
    const index = line.indexOf(":");
    if (index > 0) shipped[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  assert.deepEqual(shipped, { ...SECURITY_HEADERS });
});

test("reports edge readiness separately from runtime readiness", async () => {
  const response = await handleRequest(new Request("https://example.test/edge/health"), {
    API: { fetch() {} },
    ASSETS: { fetch() {} },
  });
  assert.deepEqual(await response.json(), {
    ok: true,
    edge: "ready",
    runtime: { api: true, indexer: false, marketGateway: false },
  });
});

test("denies private, unknown and wrong-method routes before origin or assets", async () => {
  const env = {
    API: {
      fetch() {
        throw new Error("origin reached");
      },
    },
    ASSETS: {
      fetch() {
        throw new Error("assets reached");
      },
    },
  };
  for (const [path, method] of [
    ["/v1/dev/wallet", "GET"],
    ["/v1/unknown", "POST"],
    ["/internal/metrics", "GET"],
    ["/v1/risk/secret", "GET"],
    ["/v1/risk", "POST"],
    ["/v1/quote", "GET"],
  ])
    assert.equal((await handleRequest(request(`https://example.test${path}`, { method }), env)).status, 404);
});

test("answers the app's location check from Cloudflare's geolocation only", async () => {
  const geo = async (cf, headers = {}) =>
    (
      await handleRequest(
        Object.assign(new Request("https://example.test/edge/geo", { headers }), { cf }),
        {},
      )
    ).json();
  assert.deepEqual(await geo({ country: "FR", regionCode: "IDF" }), {
    status: "allowed",
    country: "FR",
    region: "IDF",
    message: null,
  });
  assert.equal((await geo({ country: "US", regionCode: "NY" })).status, "restricted");
  assert.equal((await geo({ country: "IR" })).status, "sanctioned");
  assert.equal((await geo({ country: "UA", regionCode: "43" })).status, "sanctioned");
  assert.equal((await geo({ country: "UA", regionCode: "30" })).status, "allowed");
  // A spoofed header never unlocks anything: without request.cf the location is unverified.
  assert.equal((await geo(undefined, { "cf-ipcountry": "FR" })).status, "restricted");
});

test("refuses every service route from sanctioned locations before rate limiting or the origin", async () => {
  const env = {
    ...edge,
    API: {
      fetch() {
        throw new Error("origin reached");
      },
    },
    INDEXER: {
      fetch() {
        throw new Error("origin reached");
      },
    },
    ASSETS: { fetch: () => new Response("asset") },
  };
  for (const cf of [
    { country: "IR" },
    { country: "KP" },
    { country: "RU" },
    { country: "UA", regionCode: "14" },
  ])
    for (const [path, method] of [
      ["/v1/risk", "GET"],
      ["/v1/quote", "POST"],
      ["/v1/withdraw/prepare", "POST"],
      ["/v1/close/quote", "POST"],
    ]) {
      const response = await handleRequest(request(`https://example.test${path}`, { method }, cf), env);
      assert.equal(response.status, 451, `${cf.country} ${path}`);
      assert.deepEqual(await response.json(), {
        error: "jurisdiction_restricted",
        status: "sanctioned",
        message: "RFQ Markets is not available in your location.",
      });
    }
});

test("lets restricted and unverified locations reduce risk and withdraw but not open risk", async () => {
  const reached = [];
  const env = {
    ...edge,
    API: {
      fetch: async (r) => {
        reached.push(new URL(r.url).pathname);
        return new Response("{}");
      },
    },
    INDEXER: { fetch: async () => new Response("{}") },
    ASSETS: { fetch: () => new Response("asset") },
  };
  const blocked = [
    "/v1/quote",
    "/v1/orders",
    "/v1/orders/prepare",
    "/v1/orders/trigger/prepare",
    "/v1/orders/tpsl/prepare",
  ];
  const open = [
    "/v1/close/quote",
    "/v1/close/all/quote",
    "/v1/prepare",
    "/v1/approve",
    "/v1/close/prepare",
    "/v1/close/execute",
    "/v1/withdraw/prepare",
    "/v1/withdraw/execute",
    "/v1/session/prepare",
    "/v1/session/execute",
    "/v1/nonce/cancel/prepare",
    "/v1/nonce/cancel/execute",
    "/v1/orders/abc_1/cancel/prepare",
    "/v1/orders/abc_1/cancel",
  ];
  for (const cf of [
    { country: "US" },
    { country: "CA" },
    { country: "GB" },
    { country: "T1" },
    { country: "XX" },
    null,
  ]) {
    for (const path of blocked) {
      const response = await handleRequest(
        request(`https://example.test${path}`, { method: "POST" }, cf),
        env,
      );
      assert.equal(response.status, 451, `${cf?.country} ${path}`);
      assert.equal((await response.json()).status, "restricted");
    }
    for (const path of open)
      assert.equal(
        (await handleRequest(request(`https://example.test${path}`, { method: "POST" }, cf), env)).status,
        200,
        `${cf?.country} ${path}`,
      );
    assert.equal((await handleRequest(request("https://example.test/v1/risk", {}, cf), env)).status, 200);
  }
  assert.ok(!reached.some((path) => blocked.includes(path)));
});
