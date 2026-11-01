import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, connectionLost, errorMessage, getJson } from "./http.js";

test("wallet rejections read as a cancellation", () => {
  assert.equal(errorMessage({ code: 4001, message: "User denied" }, "x"), "You cancelled in your wallet");
  const wrapped = Object.assign(new Error("Transaction failed"), {
    shortMessage: "Transaction failed",
    cause: { name: "UserRejectedRequestError" },
  });
  assert.equal(errorMessage(wrapped, "x"), "You cancelled in your wallet");
});

test("other errors keep their short message, then message, then the fallback", () => {
  assert.equal(
    errorMessage({ shortMessage: "Execution reverted", message: "long" }, "x"),
    "Execution reverted",
  );
  assert.equal(
    errorMessage(new ApiError("minimum deposit is 10 USDC", 409), "x"),
    "minimum deposit is 10 USDC",
  );
  assert.equal(errorMessage(null, "Unavailable"), "Unavailable");
});

test("a jurisdiction refusal shows its sentence, other errors their code", async () => {
  const original = globalThis.fetch;
  const reply = (status: number, body: unknown) => {
    globalThis.fetch = async () => new Response(JSON.stringify(body), { status });
  };
  try {
    reply(451, {
      error: "jurisdiction_restricted",
      status: "restricted",
      message: "Opening positions is not available in your location.",
    });
    await assert.rejects(getJson("/v1/quote"), {
      message: "Opening positions is not available in your location.",
      status: 451,
    });
    reply(429, { error: "rate_limit_exceeded", message: "ignored" });
    await assert.rejects(getJson("/v1/quote"), { message: "rate_limit_exceeded" });
  } finally {
    globalThis.fetch = original;
  }
});

test("connectionLost tells a lost answer from a refusal", () => {
  assert.equal(connectionLost(new TypeError("Failed to fetch")), true, "Chrome");
  assert.equal(connectionLost(new TypeError("Load failed")), true, "Safari");
  assert.equal(
    connectionLost(new TypeError("NetworkError when attempting to fetch resource.")),
    true,
    "Firefox",
  );
  assert.equal(connectionLost(new ApiError("bad gateway", 502)), true);
  assert.equal(connectionLost(new ApiError("gateway timeout", 504)), true);
  assert.equal(connectionLost(new ApiError("quote expired", 409)), false);
  assert.equal(connectionLost(new ApiError("upstream_unavailable", 503)), false);
  assert.equal(connectionLost(new TypeError("x is not a function")), false);
  assert.equal(connectionLost(new Error("User rejected the request.")), false);
});
