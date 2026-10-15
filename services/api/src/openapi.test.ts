import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { jsonSchema, OPERATIONS, registeredRoutes } from "./openapi.js";
import { buildApi } from "./server.js";

test("the OpenAPI document lists every public route the API registers", async () => {
  const app = buildApi();
  await app.ready();
  const routes = registeredRoutes(app);
  try {
    const documented = new Set(OPERATIONS.map((operation) => `${operation.method} ${operation.path}`)),
      undocumented = [...routes].filter(
        (route) =>
          !documented.has(route) &&
          !/ \/(internal|v1\/dev)\//.test(route) &&
          !["get /v1/markets/stream", "get /v1/openapi.json"].includes(route),
      );
    assert.deepEqual(undocumented, []);
    assert.deepEqual(
      [...documented].filter((route) => !routes.has(route)),
      [],
    );

    const response = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    assert.equal(response.statusCode, 200);
    const document = response.json(),
      session = document.paths["/v1/session/prepare"].post.requestBody.content["application/json"].schema;
    assert.equal(document.openapi, "3.1.0");
    assert.deepEqual(session.required, [
      "account",
      "nonce",
      "session",
      "marketMask",
      "maxTradeAmount",
      "maxCumulativeAmount",
      "maxFee",
      "durationSeconds",
    ]);
    assert.deepEqual(session.properties.durationSeconds, {
      type: "integer",
      minimum: 300,
      maximum: 2_592_000,
    });
    assert.equal(session.properties.marketMask.anyOf.length, 2);
    const quote = document.paths["/v1/quote"].post.requestBody.content["application/json"].schema;
    assert.deepEqual(quote.properties.side, { type: "string", enum: ["buy", "sell"] });
    assert.ok(!quote.required.includes("slippageBps"));
    assert.ok(document.components.schemas.Error.properties.code.enum.includes("quote_expired"));
    const ladder = document.paths["/v1/quote/ladder"].get.parameters;
    assert.deepEqual(
      ladder.map((parameter: { name: string; required: boolean }) => [parameter.name, parameter.required]),
      [
        ["market", true],
        ["amounts", false],
      ],
    );
  } finally {
    await app.close();
  }
});

test("jsonSchema maps defaults and rejects kinds it can't describe", () => {
  assert.deepEqual(jsonSchema(z.boolean().default(false)), { type: "boolean", default: false });
  assert.throws(() => jsonSchema(z.date()), /unsupported schema kind: ZodDate/);
  assert.throws(() => jsonSchema(z.string().email()), /unsupported string check: email/);
});
