import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGateway } from "./server.js";

test("gateway reports upstream failure without blocking execution services", async () => {
  const gateway = buildGateway({
    upstreamUrl: "http://upstream",
    fetchImpl: async () => new Response("offline", { status: 503 }),
    reconnectMinMs: 5,
    reconnectMaxMs: 10,
  });
  await gateway.ready();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const health = (await gateway.inject({ method: "GET", url: "/health" })).json();
  assert.equal(health.ok, false);
  assert(health.reconnects > 0);
  assert.equal(health.lastError, "upstream_unavailable");
  await gateway.close();
});

test("gateway aborts a connected upstream that stops publishing frames", async () => {
  let calls = 0;
  const gateway = buildGateway({
    upstreamUrl: "http://upstream",
    upstreamStallMs: 20,
    reconnectMinMs: 1,
    reconnectMaxMs: 2,
    fetchImpl: async (_url, init) => {
      calls++;
      return new Response(
        new ReadableStream({
          start(controller) {
            init!.signal!.addEventListener("abort", () => controller.error(new Error("stalled")), {
              once: true,
            });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    await gateway.ready();
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert(calls >= 2);
    assert.equal((await gateway.inject({ method: "GET", url: "/health" })).json().ok, false);
  } finally {
    await gateway.close();
  }
});
