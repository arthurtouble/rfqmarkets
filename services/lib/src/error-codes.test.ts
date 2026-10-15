import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { API_ERROR_CODES, apiErrorCode } from "../../../packages/shared/src/api-errors.js";
import { registerErrorCodes } from "./error-codes.js";

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
