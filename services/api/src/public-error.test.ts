import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approverPolicyRejection,
  futureReportFailure,
  publicError,
  staleOracleFailure,
} from "./public-error.js";
test("public action errors cannot expose transport credentials or provider request bodies", () => {
  const message = "RPC https://provider/private-token Bearer signer-token signed-body";
  assert.equal(publicError(new Error(message), "action failed"), "action failed");
  assert.equal(publicError({ message, data: "0x50cb02e4" }, "action failed"), "Insufficient margin");
  assert.equal(publicError({ message, revert: { name: "Replay" } }, "action failed"), "Nonce already used");
  assert.equal(publicError({ revert: { name: message } }, "action failed"), "action failed");
  assert.equal(publicError({ message, data: "0xdccfcae2" }, "action failed"), "Trigger price not reached");
  assert.equal(publicError({ message, data: "0x0e6692d8" }, "action failed"), "Session key limit reached");
  assert.equal(
    publicError({ message, data: "0x4b3eeb24" }, "action failed"),
    "Price worse than the signed limit",
  );
});

const rejected = (status: number, error: string): PromiseSettledResult<unknown> => ({
  status: "rejected",
  reason: new Error(`approver ${status}: ${JSON.stringify({ error })}`),
});
const signed: PromiseSettledResult<unknown> = { status: "fulfilled", value: { signer: "0x1" } };

test("a policy reason that blocks quorum reaches the trader; infrastructure failures do not", () => {
  // Two of three approvers refuse an opening trade on a disabled market: quorum of two is impossible.
  assert.equal(
    approverPolicyRejection(
      [rejected(409, "market disabled"), rejected(409, "market disabled"), signed],
      3,
      2,
    ),
    "market disabled",
  );
  assert.equal(
    approverPolicyRejection(
      [0, 1, 2].map(() => rejected(409, "reduce-only intent does not reduce position")),
      3,
      2,
    ),
    "reduce-only intent does not reduce position",
  );
  // A session key the approvers no longer honour: the app falls back to the wallet on this reason.
  assert.equal(
    approverPolicyRejection(
      [0, 1, 2].map(() => rejected(409, "user authorization rejected")),
      3,
      2,
    ),
    "user authorization rejected",
  );
  // One policy rejection alone did not block quorum: the cause was elsewhere.
  assert.equal(
    approverPolicyRejection(
      [rejected(409, "market disabled"), rejected(503, "hedge health unavailable"), signed],
      3,
      2,
    ),
    undefined,
  );
  // Disagreeing reasons, non-public reasons and transport errors stay generic.
  assert.equal(
    approverPolicyRejection(
      [rejected(409, "market disabled"), rejected(409, "market trade limit exceeded")],
      3,
      2,
    ),
    undefined,
  );
  assert.equal(
    approverPolicyRejection([rejected(409, "rpc divergence"), rejected(409, "rpc divergence")], 3, 2),
    undefined,
  );
  assert.equal(
    approverPolicyRejection(
      [
        { status: "rejected", reason: new Error("approver 409: not json") },
        { status: "rejected", reason: new Error("fetch failed") },
      ],
      3,
      2,
    ),
    undefined,
  );
});

test("stale price reverts are recognised for a refresh-and-retry, including errors that carry bigints", () => {
  assert.equal(staleOracleFailure({ data: "0xd7815800", value: 1n }), true);
  assert.equal(staleOracleFailure(new Error('execution reverted (data="0xd7815800")')), true);
  assert.equal(staleOracleFailure({ data: "0x50cb02e4", value: 1n }), false);
  assert.equal(publicError({ data: "0xd7815800" }, "action failed"), "Oracle or authorization expired");
});

test("a report from after the simulated block is recognised so the simulation can wait for the head", () => {
  assert.equal(futureReportFailure({ data: "0xb55ac754" }), true);
  assert.equal(futureReportFailure(new Error("execution reverted: InvalidReport()")), true);
  assert.equal(futureReportFailure({ data: "0xd7815800", value: 1n }), false);
});
