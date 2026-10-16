import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { API_ERROR_CODES, apiErrorCode } from "../../../packages/shared/src/api-errors.js";
import { redactUrls, registerErrorCodes, registerErrorHandler } from "./error-codes.js";

test("every error response carries a stable code and a retryable flag", async () => {
  const app = Fastify();
  registerErrorCodes(app);
  app.get("/expired", (_request, reply) => reply.code(409).send({ error: "quote expired" }));
  app.get("/margin", (_request, reply) =>
    reply.code(409).send({ error: "insufficient margin for this trade", code: "insufficient_margin" }),
  );
  app.get("/odd", (_request, reply) => reply.code(400).send({ error: "Max per trade is $25" }));
  app.get("/flagged", (_request, reply) =>
    reply.code(409).send({ error: "quote submission requires reconciliation or retry", retriable: true }),
  );
  app.get("/ok", () => ({ error: "not an error" }));
  try {
    const body = async (url: string) => (await app.inject({ method: "GET", url })).json();
    assert.deepEqual(await body("/expired"), {
      error: "quote expired",
      code: "quote_expired",
      retryable: true,
    });
    assert.deepEqual(await body("/margin"), {
      error: "insufficient margin for this trade",
      code: "insufficient_margin",
      retryable: false,
    });
    assert.deepEqual(await body("/odd"), {
      error: "Max per trade is $25",
      code: "invalid_request",
      retryable: false,
    });
    assert.equal((await body("/flagged")).retryable, true);
    assert.deepEqual(await body("/ok"), { error: "not an error" });
    // Fastify's own 404 gets a code too.
    assert.equal((await body("/missing")).code, "not_found");
  } finally {
    await app.close();
  }
});

test("codes by message and by status stay within the published list", () => {
  assert.equal(apiErrorCode(503, "approver quorum unavailable"), "approvals_unavailable");
  assert.equal(apiErrorCode(429, "quote rate limit exceeded"), "rate_limited");
  assert.equal(apiErrorCode(409, "user authorization rejected"), "session_limit");
  for (const status of [400, 401, 403, 404, 409, 418, 429, 500, 502, 503])
    assert.ok(API_ERROR_CODES.includes(apiErrorCode(status, "something new")));
});

test("server errors never echo their message; client errors keep theirs", async () => {
  const app = Fastify(),
    logged: string[] = [];
  registerErrorCodes(app);
  registerErrorHandler(app, "test", (message) => logged.push(message));
  const rpcFailure = Object.assign(
    new Error(
      'server response 500 (request={ }, requestUrl="https://base.example/v2/SECRET-KEY", code=SERVER_ERROR)',
    ),
    { code: "SERVER_ERROR" },
  );
  app.get("/rpc", async () => {
    throw rpcFailure;
  });
  app.get("/unavailable", async () => {
    throw Object.assign(new Error("https://rpc.example/key-in-path down"), { statusCode: 503 });
  });
  app.post("/json", async () => ({ ok: true }));
  try {
    const rpc = await app.inject({ method: "GET", url: "/rpc" });
    assert.equal(rpc.statusCode, 500);
    assert.deepEqual(rpc.json(), { error: "internal error", code: "internal", retryable: false });
    assert.doesNotMatch(rpc.body, /SECRET|base\.example/);
    const unavailable = await app.inject({ method: "GET", url: "/unavailable" });
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.json(), { error: "internal error", code: "unavailable", retryable: true });
    assert.equal(logged.length, 2);
    assert.match(logged[0], /test GET \/rpc failed/);
    assert.doesNotMatch(logged.join("\n"), /SECRET-KEY|key-in-path/, "logs redact URL paths too");
    const malformed = await app.inject({
      method: "POST",
      url: "/json",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    assert.equal(malformed.statusCode, 400);
    const body = malformed.json();
    assert.equal(body.code, "invalid_request");
    assert.equal(body.retryable, false);
    assert.match(body.message, /JSON/);
  } finally {
    await app.close();
  }
});

test("URL redaction keeps the origin only", () => {
  assert.equal(
    redactUrls('requestUrl="https://mainnet.example/v2/abc?key=1" and wss://ws.example/k'),
    'requestUrl="https://mainnet.example/…" and wss://ws.example/…',
  );
});
