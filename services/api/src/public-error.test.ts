import { test } from "node:test";
import assert from "node:assert/strict";
import { approverPolicyRejection, publicError } from "./public-error.js";
test("public action errors cannot expose transport credentials or provider request bodies", () => {
  const message = "RPC https://provider/private-token Bearer signer-token signed-body";
  assert.equal(publicError(new Error(message), "action failed"), "action failed");
  assert.equal(publicError({ message, data: "0x50cb02e4" }, "action failed"), "Insufficient margin");
  assert.equal(publicError({ message, revert: { name: "Replay" } }, "action failed"), "Nonce already used");
  assert.equal(publicError({ revert: { name: message } }, "action failed"), "action failed");
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
