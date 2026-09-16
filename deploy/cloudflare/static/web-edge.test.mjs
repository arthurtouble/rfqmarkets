import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest, serviceForPath } from "./web-edge.mjs";

test("routes public reads to the indexer and market streams to the gateway", () => {
  assert.equal(serviceForPath("/v1/risk"), "INDEXER");
  assert.equal(serviceForPath("/v1/positions"), "INDEXER");
  assert.equal(serviceForPath("/v1/activity"), "INDEXER");
  assert.equal(serviceForPath("/v1/updates/stream"), "INDEXER");
  assert.equal(serviceForPath("/health"), "INDEXER");
  assert.equal(serviceForPath("/v1/markets/stream"), "MARKET_GATEWAY");
  assert.equal(serviceForPath("/v1/markets/history?market=BTC"), "MARKET_GATEWAY");
  assert.equal(serviceForPath("/v1/quote"), "API");
  assert.equal(serviceForPath("/markets"), null);
});

test("fails closed with machine-readable 503 when a runtime binding is absent", async () => {
  const response = await handleRequest(new Request("https://example.test/v1/quote",{method:"POST"}), {
    ASSETS: { fetch: () => new Response("asset") },
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal((await response.json()).service, "api");
});

test("forwards methods, bodies, and request correlation to a private service", async () => {
  let received;
  const response = await handleRequest(new Request("https://example.test/v1/quote", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-ray": "ray-123" },
    body: JSON.stringify({ market: "BTC" }),
  }), {
    API: { fetch: async (request) => {
      received = request;
      return new Response("ok", { status: 201 });
    } },
    ASSETS: { fetch: () => new Response("asset") },
  });
  assert.equal(response.status, 201);
  assert.equal(received.method, "POST");
  assert.equal(received.headers.get("x-request-id"), "ray-123");
  assert.deepEqual(await received.json(), { market: "BTC" });
});

test("contains upstream failures and still serves non-service assets", async () => {
  const failed = await handleRequest(new Request("https://example.test/v1/risk"), {
    INDEXER: { fetch: async () => { throw new Error("offline"); } },
    ASSETS: { fetch: () => new Response("asset") },
  });
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error, "upstream_unavailable");

  const asset = await handleRequest(new Request("https://example.test/markets"), {
    ASSETS: { fetch: () => new Response("terminal") },
  });
  assert.equal(await asset.text(), "terminal");
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

test('denies private, unknown and wrong-method routes before origin or assets',async()=>{
 const env={API:{fetch(){throw new Error('origin reached')}},ASSETS:{fetch(){throw new Error('assets reached')}}};
 for(const [path,method] of [['/v1/dev/wallet','GET'],['/v1/unknown','POST'],['/internal/metrics','GET'],['/v1/risk/secret','GET'],['/v1/risk','POST'],['/v1/quote','GET']])assert.equal((await handleRequest(new Request(`https://example.test${path}`,{method}),env)).status,404);
});
