import assert from "node:assert/strict";
import test from "node:test";
import { resetAccessCacheForTests, verifyAccess } from "./access.mjs";
import { handlePrivateRequest, runtimeRead } from "./private-edge.mjs";
import { admitAtEdge } from "../runtime/edge-admission.mjs";

const DOMAIN = "team.cloudflareaccess.com", AUD = "aud-tag";
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const fetcher = async (url) => {
  assert.equal(url, `https://${DOMAIN}/cdn-cgi/access/certs`);
  return Response.json({ keys: [jwk] });
};
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
async function token(claims = {}, { kid = "k1", key = pair.privateKey } = {}) {
  const head = b64(JSON.stringify({ alg: "RS256", kid })),
    body = b64(JSON.stringify({ aud: [AUD], iss: `https://${DOMAIN}`, exp: Math.floor(Date.now() / 1000) + 600, email: "op@example.test", ...claims }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(signature))}`;
}
const env = (extra = {}) => ({
  ACCESS_TEAM_DOMAIN: DOMAIN,
  ACCESS_AUD: AUD,
  ASSETS: { fetch: () => new Response("<html>", { headers: { "content-type": "text/html" } }) },
  ...extra,
});
const request = (path, jwt, init = {}) =>
  new Request(`https://admin.example.test${path}`, { ...init, headers: { ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), ...(init.headers ?? {}) } });

test.beforeEach(() => resetAccessCacheForTests());

test("accepts a token signed for this application", async () => {
  assert.equal((await verifyAccess(request("/", await token()), env(), { fetcher })).email, "op@example.test");
});

test("rejects missing, foreign, expired and forged tokens", async () => {
  const other = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign"],
  );
  for (const jwt of [
    undefined,
    "not.a.jwt",
    await token({ aud: ["other-app"] }),
    await token({ iss: "https://evil.cloudflareaccess.com" }),
    await token({ exp: Math.floor(Date.now() / 1000) - 1 }),
    await token({}, { kid: "missing" }),
    await token({}, { key: other.privateKey }),
  ])
    assert.equal(await verifyAccess(request("/", jwt), env(), { fetcher }), null, String(jwt));
});

test("stays locked when Access is not configured, even with a valid token", async () => {
  const response = await handlePrivateRequest(request("/", await token()), env({ ACCESS_AUD: undefined }), { fetcher });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /locked/);
});

test("refuses assets without Access and serves them with private headers with it", async () => {
  assert.equal((await handlePrivateRequest(request("/"), env(), { fetcher })).status, 403);
  const response = await handlePrivateRequest(request("/", await token()), env(), { fetcher });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
});

test("forwards only the dashboard's reads to the runtime, without the Access token or cookies", async () => {
  assert.ok(runtimeRead("/v1/risk") && runtimeRead("/v1/updates/stream") && runtimeRead("/v1/config"));
  assert.ok(runtimeRead("/ops/hedger/v1/status") && runtimeRead("/ops/hedger/v1/status/stream"));
  assert.ok(!runtimeRead("/v1/dev/risk-operator") && !runtimeRead("/v1/config/x"));
  assert.ok(!runtimeRead("/v1/quote") && !runtimeRead("/ops/hedger/v1/tick") && !runtimeRead("/ops/hedger/internal/risk"));
  const seen = [];
  const RUNTIME = { fetch: async (forwarded) => (seen.push(forwarded), Response.json({ ok: true })) };
  const jwt = await token();
  const response = await handlePrivateRequest(
    request("/v1/risk?finalized=true", jwt, { headers: { cookie: "CF_Authorization=x", accept: "application/json", "cf-connecting-ip": "203.0.113.7" } }),
    env({ RUNTIME }),
    { fetcher },
  );
  assert.equal(response.status, 200);
  assert.equal(new URL(seen[0].url).search, "?finalized=true");
  assert.equal(seen[0].headers.get("cookie"), null);
  assert.equal(seen[0].headers.get("cf-access-jwt-assertion"), null);
  assert.equal(seen[0].headers.get("accept"), "application/json");
  // The runtime's edge admission refuses indexer reads without a client IP.
  assert.equal(seen[0].headers.get("cf-connecting-ip"), "203.0.113.7");
  const limiter = { limit: async () => ({ success: true }) };
  const limits = { PUBLIC_READ_LIMIT: limiter, GLOBAL_READ_LIMIT: limiter, PUBLIC_WRITE_LIMIT: limiter, GLOBAL_WRITE_LIMIT: limiter };
  assert.equal(await admitAtEdge(seen[0], limits), null, "the runtime admits the forwarded read");
  assert.equal((await handlePrivateRequest(request("/v1/quote", jwt), env({ RUNTIME }), { fetcher })).status, 404);
  assert.equal((await handlePrivateRequest(request("/ops/hedger/v1/tick", jwt), env({ RUNTIME }), { fetcher })).status, 404);
  assert.equal((await handlePrivateRequest(request("/v1/risk", jwt, { method: "POST" }), env({ RUNTIME }), { fetcher })).status, 405);
  assert.equal(seen.length, 1);
});

test("internal docs have no runtime routes", async () => {
  const response = await handlePrivateRequest(request("/v1/risk", await token()), env(), { fetcher });
  assert.equal(response.status, 404);
});
