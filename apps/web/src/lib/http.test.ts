import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, errorMessage } from "./http.js";

test("wallet rejections read as a cancellation", () => {
  assert.equal(errorMessage({ code: 4001, message: "User denied" }, "x"), "You cancelled in your wallet");
  const wrapped = Object.assign(new Error("Transaction failed"), { shortMessage: "Transaction failed", cause: { name: "UserRejectedRequestError" } });
  assert.equal(errorMessage(wrapped, "x"), "You cancelled in your wallet");
});

test("other errors keep their short message, then message, then the fallback", () => {
  assert.equal(errorMessage({ shortMessage: "Execution reverted", message: "long" }, "x"), "Execution reverted");
  assert.equal(errorMessage(new ApiError("minimum deposit is 10 USDC", 409), "x"), "minimum deposit is 10 USDC");
  assert.equal(errorMessage(null, "Unavailable"), "Unavailable");
});
