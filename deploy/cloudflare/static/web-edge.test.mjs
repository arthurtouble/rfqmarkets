import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest, serviceForPath } from "./web-edge.mjs";
const limiter={limit:async()=>({success:true})},edge={PUBLIC_READ_LIMIT:limiter,PUBLIC_WRITE_LIMIT:limiter,GLOBAL_READ_LIMIT:limiter,GLOBAL_WRITE_LIMIT:limiter},request=(url,init={})=>new Request(url,{...init,headers:{'cf-connecting-ip':'192.0.2.1',...(init.headers??{})}});

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
  assert.equal(serviceForPath("/v1/quote"), "API");
  assert.equal(serviceForPath("/markets"), null);
});

test("fails closed with machine-readable 503 when a runtime binding is absent", async () => {
  const response = await handleRequest(request("https://example.test/v1/quote",{method:"POST"}), {
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
  const response = await handleRequest(request("https://example.test/v1/quote", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-ray": "ray-123" },
    body: JSON.stringify({ market: "BTC" }),
  }), {
    ...edge,
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
  const failed = await handleRequest(request("https://example.test/v1/risk"), {
    ...edge,
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
  for(const [path,method] of [['/v1/dev/wallet','GET'],['/v1/unknown','POST'],['/internal/metrics','GET'],['/v1/risk/secret','GET'],['/v1/risk','POST'],['/v1/quote','GET']])assert.equal((await handleRequest(request(`https://example.test${path}`,{method}),env)).status,404);
});
